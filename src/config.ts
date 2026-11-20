/**
 * Configuration lue exclusivement depuis l'environnement.
 * Le jeton n'est jamais journalisé ni renvoyé au modèle.
 */
export interface CpanelConfig {
    /** Hôte cPanel, ex. `vautour.o2switch.net` ou `mondomaine.fr` (sans schéma). */
    host: string;
    /** Port UAPI (2083 = cPanel en HTTPS). */
    port: number;
    /** Identifiant cPanel (o2switch : l'identifiant de connexion du compte). */
    user: string;
    /** Jeton API créé dans cPanel > Sécurité > Gérer les jetons d'API. */
    token: string;
    /** `true` uniquement si CPANEL_ALLOW_WRITES=1 : enregistre les outils qui créent ou modifient. */
    allowWrites: boolean;
    /**
     * `true` uniquement si CPANEL_ALLOW_DESTRUCTIVE=1 ET CPANEL_ALLOW_WRITES=1 : enregistre les outils
     * de suppression (chacun exige une confirmation explicite du nom de la cible).
     */
    allowDestructive: boolean;
    /** Fichier du journal local des écritures (CPANEL_JOURNAL, `off` pour désactiver). */
    journalPath: string | null;
    /** Délai maximal d'un appel, en millisecondes. */
    timeoutMs: number;
}

const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CpanelConfig {
    const missing = ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN'].filter((k) => !env[k]?.trim());
    if (missing.length) {
        throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')}. Voir README.`);
    }
    const host = env.CPANEL_HOST!.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const port = Number(env.CPANEL_PORT || 2083);
    if (!Number.isInteger(port) || port <= 0) throw new Error('CPANEL_PORT invalide');
    const allowWrites = truthy(env.CPANEL_ALLOW_WRITES);
    const home = env.USERPROFILE || env.HOME || '.';
    const journal = (env.CPANEL_JOURNAL || '').trim();
    return {
        host,
        port,
        user: env.CPANEL_USER!.trim(),
        token: env.CPANEL_TOKEN!.trim(),
        allowWrites,
        // La suppression n'a de sens qu'avec l'écriture : jamais l'une sans l'autre.
        allowDestructive: allowWrites && truthy(env.CPANEL_ALLOW_DESTRUCTIVE),
        journalPath: journal.toLowerCase() === 'off' ? null : (journal || `${home}/.mcp-cpanel/journal.log`),
        timeoutMs: Number(env.CPANEL_TIMEOUT_MS || 30000),
    };
}
