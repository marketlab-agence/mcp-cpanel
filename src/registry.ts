import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CpanelClient, CpanelError } from './cpanel.js';
import type { CpanelConfig } from './config.js';
import { Journal } from './journal.js';

const MAX_OUTPUT = 20_000;

export type Level = 'read' | 'write' | 'destructive';

export interface ToolDef<A> {
    title: string;
    description: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
    run: (args: A) => Promise<unknown>;
}

const ANNOTATIONS: Record<Level, Record<string, boolean>> = {
    read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const PREFIX: Record<Level, string> = { read: '', write: '[ÉCRITURE] ', destructive: '[SUPPRESSION — confirmation exigée] ' };

function format(value: unknown) {
    let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text === undefined) text = 'OK';
    if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + `\n… (tronqué, ${text.length} caractères au total)`;
    return { content: [{ type: 'text' as const, text }] };
}

/**
 * Enregistre les outils selon le niveau autorisé par la configuration.
 * Un outil d'un niveau non autorisé n'est tout simplement pas exposé au modèle.
 */
export class Registry {
    readonly names: string[] = [];
    readonly journal: Journal;

    constructor(private readonly server: McpServer, readonly client: CpanelClient, readonly cfg: CpanelConfig) {
        this.journal = new Journal(cfg.journalPath, `${cfg.user}@${cfg.host}`);
    }

    allowed(level: Level): boolean {
        if (level === 'read') return true;
        if (level === 'write') return this.cfg.allowWrites;
        return this.cfg.allowDestructive;
    }

    add<A = any>(level: Level, name: string, def: ToolDef<A>): void {
        if (!this.allowed(level)) return;
        const handler = async (args: A) => {
            try {
                const result = await def.run(args);
                if (level !== 'read') this.journal.record({ level, tool: name, args, ok: true });
                return format(result);
            } catch (err) {
                const msg = err instanceof CpanelError ? err.message : this.client.redact(String((err as any)?.message || err));
                if (level !== 'read') this.journal.record({ level, tool: name, args, ok: false, error: msg });
                return { content: [{ type: 'text' as const, text: `Erreur : ${msg}` }], isError: true };
            }
        };
        this.server.registerTool(
            name,
            {
                title: def.title,
                description: PREFIX[level] + def.description,
                ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
                annotations: ANNOTATIONS[level],
            } as any,
            handler as any,
        );
        this.names.push(name);
    }
}
