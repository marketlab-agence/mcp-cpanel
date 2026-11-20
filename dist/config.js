const truthy = (v) => v === '1' || v?.toLowerCase() === 'true';
export function loadConfig(env = process.env) {
    const missing = ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN'].filter((k) => !env[k]?.trim());
    if (missing.length) {
        throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')}. Voir README.`);
    }
    const host = env.CPANEL_HOST.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const port = Number(env.CPANEL_PORT || 2083);
    if (!Number.isInteger(port) || port <= 0)
        throw new Error('CPANEL_PORT invalide');
    const allowWrites = truthy(env.CPANEL_ALLOW_WRITES);
    const home = env.USERPROFILE || env.HOME || '.';
    const journal = (env.CPANEL_JOURNAL || '').trim();
    return {
        host,
        port,
        user: env.CPANEL_USER.trim(),
        token: env.CPANEL_TOKEN.trim(),
        allowWrites,
        // La suppression n'a de sens qu'avec l'écriture : jamais l'une sans l'autre.
        allowDestructive: allowWrites && truthy(env.CPANEL_ALLOW_DESTRUCTIVE),
        journalPath: journal.toLowerCase() === 'off' ? null : (journal || `${home}/.mcp-cpanel/journal.log`),
        timeoutMs: Number(env.CPANEL_TIMEOUT_MS || 30000),
    };
}
