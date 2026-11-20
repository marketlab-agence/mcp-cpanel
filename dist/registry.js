import { CpanelError } from './cpanel.js';
import { Journal } from './journal.js';
const MAX_OUTPUT = 20_000;
const ANNOTATIONS = {
    read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const PREFIX = { read: '', write: '[ÉCRITURE] ', destructive: '[SUPPRESSION — confirmation exigée] ' };
function format(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text === undefined)
        text = 'OK';
    if (text.length > MAX_OUTPUT)
        text = text.slice(0, MAX_OUTPUT) + `\n… (tronqué, ${text.length} caractères au total)`;
    return { content: [{ type: 'text', text }] };
}
/**
 * Enregistre les outils selon le niveau autorisé par la configuration.
 * Un outil d'un niveau non autorisé n'est tout simplement pas exposé au modèle.
 */
export class Registry {
    server;
    client;
    cfg;
    names = [];
    journal;
    constructor(server, client, cfg) {
        this.server = server;
        this.client = client;
        this.cfg = cfg;
        this.journal = new Journal(cfg.journalPath, `${cfg.user}@${cfg.host}`);
    }
    allowed(level) {
        if (level === 'read')
            return true;
        if (level === 'write')
            return this.cfg.allowWrites;
        return this.cfg.allowDestructive;
    }
    add(level, name, def) {
        if (!this.allowed(level))
            return;
        const handler = async (args) => {
            try {
                const result = await def.run(args);
                if (level !== 'read')
                    this.journal.record({ level, tool: name, args, ok: true });
                return format(result);
            }
            catch (err) {
                const msg = err instanceof CpanelError ? err.message : this.client.redact(String(err?.message || err));
                if (level !== 'read')
                    this.journal.record({ level, tool: name, args, ok: false, error: msg });
                return { content: [{ type: 'text', text: `Erreur : ${msg}` }], isError: true };
            }
        };
        this.server.registerTool(name, {
            title: def.title,
            description: PREFIX[level] + def.description,
            ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
            annotations: ANNOTATIONS[level],
        }, handler);
        this.names.push(name);
    }
}
