export function loadConfig(env = process.env) {
    const missing = ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN'].filter((k) => !env[k]?.trim());
    if (missing.length) {
        throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')}. Voir README.`);
    }
    const host = env.CPANEL_HOST.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const port = Number(env.CPANEL_PORT || 2083);
    if (!Number.isInteger(port) || port <= 0)
        throw new Error('CPANEL_PORT invalide');
    return {
        host,
        port,
        user: env.CPANEL_USER.trim(),
        token: env.CPANEL_TOKEN.trim(),
        allowWrites: env.CPANEL_ALLOW_WRITES === '1' || env.CPANEL_ALLOW_WRITES === 'true',
        timeoutMs: Number(env.CPANEL_TIMEOUT_MS || 30000),
    };
}
