import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CpanelClient, CpanelError } from './cpanel.js';
import type { CpanelConfig } from './config.js';

const MAX_OUTPUT = 20_000;

/** Préfixes de fonctions UAPI considérées comme lecture seule pour l'appel générique. */
const READ_PREFIX = /^(list|get|fetch|is|has|check|show|count)_/;

/** Modules que l'appel générique ne doit jamais toucher, même en lecture (secrets). */
const BLOCKED_MODULES = new Set(['Tokens', 'Passwd', 'TwoFactorAuth', 'SSH', 'Session']);

function ok(value: unknown) {
    let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + `\n… (tronqué, ${text.length} caractères au total)`;
    return { content: [{ type: 'text' as const, text }] };
}

function fail(err: unknown, client: CpanelClient) {
    const msg = err instanceof CpanelError ? err.message : client.redact(String((err as any)?.message || err));
    return { content: [{ type: 'text' as const, text: `Erreur : ${msg}` }], isError: true };
}

/** Exécute un handler en convertissant toute erreur en résultat MCP lisible (jamais d'exception brute). */
function safe<A>(client: CpanelClient, fn: (args: A) => Promise<unknown>) {
    return async (args: A) => {
        try {
            return ok(await fn(args));
        } catch (err) {
            return fail(err, client);
        }
    };
}

/** Refuse toute sortie de l'arborescence du compte. */
export function safeDir(dir: string, user: string): string {
    const d = dir.trim() || '/';
    if (d.includes('..') || d.includes('\0')) throw new CpanelError('Chemin refusé : « .. » interdit.');
    if (d.startsWith('/') && d !== `/home/${user}` && !d.startsWith(`/home/${user}/`)) {
        throw new CpanelError(`Chemin refusé : il doit être relatif au compte ou commencer par /home/${user}/.`);
    }
    return d;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function registerTools(server: McpServer, client: CpanelClient, cfg: CpanelConfig): string[] {
    const names: string[] = [];
    type ToolConfig = { title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations: Record<string, boolean> };
    const reg = (name: string, config: ToolConfig, cb: any) => {
        server.registerTool(name, config as any, cb);
        names.push(name);
    };

    // ── Lecture ────────────────────────────────────────────────────────────
    reg('cpanel_account_overview', {
        title: 'Vue d\'ensemble du compte',
        description: 'Quota disque, consommation des ressources (CPU, RAM, inodes, processus) et domaines du compte cPanel.',
        annotations: READ_ONLY,
    }, safe(client, async () => {
        const [quota, usage, domains] = await Promise.allSettled([
            client.uapi('Quota', 'get_quota_info'),
            client.uapi('ResourceUsage', 'get_usages'),
            client.uapi('DomainInfo', 'list_domains'),
        ]);
        const v = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value.data : { erreur: (r.reason as Error).message });
        return { host: cfg.host, user: cfg.user, ecrituresActives: cfg.allowWrites, quota: v(quota), ressources: v(usage), domaines: v(domains) };
    }));

    reg('cpanel_list_domains', {
        title: 'Domaines et sous-domaines',
        description: 'Domaine principal, domaines additionnels, sous-domaines et alias avec leur dossier racine.',
        annotations: READ_ONLY,
    }, safe(client, async () => (await client.uapi('DomainInfo', 'domains_data', { format: 'hash' })).data));

    reg('cpanel_ssl_status', {
        title: 'Certificats SSL installés',
        description: 'Certificats installés par domaine : émetteur, date d\'expiration, jours restants.',
        annotations: READ_ONLY,
    }, safe(client, async () => {
        const hosts = ((await client.uapi<any[]>('SSL', 'installed_hosts')).data || []) as any[];
        const now = Date.now() / 1000;
        return hosts.map((h) => {
            const c = h.certificate || {};
            const notAfter = Number(c.not_after) || null;
            return {
                domaines: h.domains || c.domains,
                emetteur: c['issuer.organizationName'] || c.issuer_text || null,
                expire: notAfter ? new Date(notAfter * 1000).toISOString().slice(0, 10) : null,
                joursRestants: notAfter ? Math.floor((notAfter - now) / 86400) : null,
                autoSigne: c.is_self_signed === 1 || c.is_self_signed === '1',
            };
        });
    }));

    reg('cpanel_autossl_problems', {
        title: 'Problèmes AutoSSL',
        description: 'Erreurs rencontrées par AutoSSL lors de la dernière vérification (DNS, validation, etc.).',
        annotations: READ_ONLY,
    }, safe(client, async () => (await client.uapi('SSL', 'get_autossl_problems')).data));

    reg('cpanel_list_email_accounts', {
        title: 'Boîtes mail',
        description: 'Comptes email du compte cPanel avec quota et espace utilisé.',
        inputSchema: { domain: z.string().optional().describe('Filtrer sur un domaine') },
        annotations: READ_ONLY,
    }, safe(client, async ({ domain }: { domain?: string }) => {
        const data = ((await client.uapi<any[]>('Email', 'list_pops_with_disk', domain ? { domain } : {})).data || []) as any[];
        return data.map((m) => ({ email: m.email, quota: m.humandiskquota, utilise: m.humandiskused, suspendu: m.suspended_login === 1 }));
    }));

    reg('cpanel_list_email_forwarders', {
        title: 'Redirections email',
        description: 'Redirecteurs email configurés.',
        inputSchema: { domain: z.string().optional() },
        annotations: READ_ONLY,
    }, safe(client, async ({ domain }: { domain?: string }) => (await client.uapi('Email', 'list_forwarders', domain ? { domain } : {})).data));

    reg('cpanel_list_databases', {
        title: 'Bases MySQL',
        description: 'Bases de données MySQL/MariaDB du compte avec leur taille et leurs utilisateurs.',
        annotations: READ_ONLY,
    }, safe(client, async () => (await client.uapi('Mysql', 'list_databases')).data));

    reg('cpanel_list_cron_jobs', {
        title: 'Tâches cron',
        description: 'Tâches planifiées (cron) du compte.',
        annotations: READ_ONLY,
    }, safe(client, async () => {
        const rows = (await client.api2<any[]>('Cron', 'listcron')) || [];
        return rows.filter((r) => r.command).map((r) => ({
            ligne: r.linekey ?? r.count, minute: r.minute, heure: r.hour, jour: r.day, mois: r.month, jourSemaine: r.weekday, commande: r.command,
        }));
    }));

    reg('cpanel_list_files', {
        title: 'Lister un dossier',
        description: 'Contenu d\'un dossier du compte (relatif au home, ex. « public_html »).',
        inputSchema: { dir: z.string().default('public_html').describe('Dossier relatif au home du compte') },
        annotations: READ_ONLY,
    }, safe(client, async ({ dir }: { dir: string }) => {
        const d = safeDir(dir, cfg.user);
        const data = ((await client.uapi<any[]>('Fileman', 'list_files', { dir: d, include_mime: 0, include_permissions: 1 })).data || []) as any[];
        return data.map((f) => ({ nom: f.file, type: f.type, taille: f.humansize ?? f.size, modifie: f.mtime ? new Date(Number(f.mtime) * 1000).toISOString() : null, permissions: f.nicemode }));
    }));

    reg('cpanel_read_file', {
        title: 'Lire un fichier texte',
        description: 'Contenu d\'un fichier texte du compte (ex. .htaccess, robots.txt). Limité à 20 000 caractères.',
        inputSchema: { dir: z.string().describe('Dossier relatif au home, ex. public_html'), file: z.string().describe('Nom du fichier, ex. .htaccess') },
        annotations: READ_ONLY,
    }, safe(client, async ({ dir, file }: { dir: string; file: string }) => {
        if (file.includes('/') || file.includes('..')) throw new CpanelError('Nom de fichier invalide.');
        const data: any = (await client.uapi('Fileman', 'get_file_content', { dir: safeDir(dir, cfg.user), file })).data;
        return data?.content ?? data;
    }));

    reg('cpanel_uapi_read', {
        title: 'Appel UAPI en lecture (générique)',
        description: 'Appelle une fonction UAPI de lecture non couverte par les autres outils. Seules les fonctions list_*, get_*, fetch_*, is_*, has_*, check_*, show_*, count_* sont autorisées ; les modules sensibles (Tokens, Passwd, SSH, TwoFactorAuth, Session) sont bloqués.',
        inputSchema: {
            module: z.string().describe('Module UAPI, ex. DomainInfo'),
            function: z.string().describe('Fonction UAPI, ex. list_domains'),
            params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        },
        annotations: READ_ONLY,
    }, safe(client, async ({ module, function: fn, params }: { module: string; function: string; params?: Record<string, any> }) => {
        if (BLOCKED_MODULES.has(module)) throw new CpanelError(`Module ${module} bloqué (données sensibles).`);
        if (!READ_PREFIX.test(fn)) throw new CpanelError(`${fn} n'est pas une fonction de lecture autorisée.`);
        return (await client.uapi(module, fn, params || {})).data;
    }));

    // ── Écriture (uniquement si CPANEL_ALLOW_WRITES=1, et jamais de suppression) ──
    if (!cfg.allowWrites) return names;

    reg('cpanel_create_subdomain', {
        title: 'Créer un sous-domaine',
        description: 'Crée un sous-domaine (ex. staging sur mastermaint360.com) avec son dossier racine. Le DNS doit pointer vers le serveur.',
        inputSchema: {
            subdomain: z.string().regex(/^[a-z0-9-]+$/).describe('Partie gauche, ex. staging'),
            rootdomain: z.string().describe('Domaine parent, ex. mastermaint360.com'),
            dir: z.string().optional().describe('Dossier racine relatif au home (défaut : public_html/<sous-domaine>)'),
        },
        annotations: WRITE,
    }, safe(client, async ({ subdomain, rootdomain, dir }: { subdomain: string; rootdomain: string; dir?: string }) => {
        const d = safeDir(dir || `public_html/${subdomain}`, cfg.user);
        await client.uapi('SubDomain', 'addsubdomain', { domain: subdomain, rootdomain, dir: d });
        return `Sous-domaine ${subdomain}.${rootdomain} créé (racine : ${d}).`;
    }));

    reg('cpanel_run_autossl', {
        title: 'Lancer AutoSSL',
        description: 'Lance une vérification AutoSSL pour émettre ou renouveler les certificats du compte.',
        annotations: { ...WRITE, idempotentHint: true },
    }, safe(client, async () => {
        await client.uapi('SSL', 'start_autossl_check');
        return 'Vérification AutoSSL lancée. Consultez cpanel_ssl_status dans quelques minutes.';
    }));

    reg('cpanel_write_file', {
        title: 'Écrire un fichier texte',
        description: 'Crée ou remplace un fichier texte (ex. .htaccess). Remplace le contenu existant : lisez-le d\'abord avec cpanel_read_file.',
        inputSchema: {
            dir: z.string().describe('Dossier relatif au home'),
            file: z.string().describe('Nom du fichier'),
            content: z.string().max(500_000),
        },
        annotations: { ...WRITE, destructiveHint: true },
    }, safe(client, async ({ dir, file, content }: { dir: string; file: string; content: string }) => {
        if (file.includes('/') || file.includes('..')) throw new CpanelError('Nom de fichier invalide.');
        await client.uapi('Fileman', 'save_file_content', { dir: safeDir(dir, cfg.user), file, content });
        return `${dir}/${file} enregistré (${content.length} caractères).`;
    }));

    reg('cpanel_add_cron_job', {
        title: 'Ajouter une tâche cron',
        description: 'Ajoute une tâche planifiée. Champs au format cron (ex. minute « 0 », heure « 3 »).',
        inputSchema: {
            command: z.string().min(1),
            minute: z.string().default('0'), hour: z.string().default('*'), day: z.string().default('*'),
            month: z.string().default('*'), weekday: z.string().default('*'),
        },
        annotations: WRITE,
    }, safe(client, async (a: { command: string; minute: string; hour: string; day: string; month: string; weekday: string }) => {
        await client.api2('Cron', 'add_line', a);
        return `Tâche ajoutée : ${a.minute} ${a.hour} ${a.day} ${a.month} ${a.weekday} ${a.command}`;
    }));

    return names;
}
