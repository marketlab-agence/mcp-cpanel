import fs from 'node:fs';
import path from 'node:path';

/** Clés dont la valeur ne doit jamais apparaître dans le journal (mots de passe, clés privées…). */
const SECRET_KEY = /pass|password|secret|token|key|cert|cabundle|content|body/i;

/** Remplace les valeurs sensibles par leur longueur, récursivement. */
export function redactArgs(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactArgs);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? `***(${v.length} car.)` : redactArgs(v);
        }
        return out;
    }
    return value;
}

export interface JournalEntry {
    level: 'write' | 'destructive';
    tool: string;
    args: unknown;
    ok: boolean;
    error?: string;
}

/**
 * Journal local (une ligne JSON par action) de toutes les écritures et suppressions.
 * Ne bloque jamais l'outil : une erreur d'écriture du journal est signalée sur stderr.
 */
export class Journal {
    constructor(private readonly file: string | null, private readonly account: string) {}

    record(entry: JournalEntry): void {
        if (!this.file) return;
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            account: this.account,
            ...entry,
            args: redactArgs(entry.args),
        });
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, line + '\n', 'utf8');
        } catch (err: any) {
            console.error(`[mcp-cpanel] journal non écrit (${this.file}) : ${err?.message || err}`);
        }
    }
}
