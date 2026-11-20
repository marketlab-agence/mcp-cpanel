import { z } from 'zod';
import { CpanelError } from './cpanel.js';
import type { Registry } from './registry.js';
import { DESTRUCTIVE_NAME, assertModuleAllowed, safeDir, safeName } from './guards.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Numéro de série SOA courant d'une zone (exigé par DNS::mass_edit_zone). */
export async function zoneSerial(r: Registry, zone: string): Promise<string> {
    const rows = ((await r.client.uapi<any[]>('DNS', 'parse_zone', { zone })).data || []) as any[];
    const soa = rows.find((x) => x.record_type === 'SOA');
    const data = Array.isArray(soa?.data_b64) ? soa.data_b64.map((v: string) => Buffer.from(v, 'base64').toString('utf8')) : [];
    if (!data[2]) throw new CpanelError(`Zone ${zone} introuvable ou non gérée par cet hébergeur (DNS chez Cloudflare ?).`);
    return data[2];
}

function refuseDestructive(fn: string): void {
    if (DESTRUCTIVE_NAME.test(fn)) {
        throw new CpanelError(`${fn} ressemble à une suppression : utilisez l'outil de suppression correspondant (niveau CPANEL_ALLOW_DESTRUCTIVE).`);
    }
}

export function registerWriteTools(r: Registry): void {
    const { client, cfg } = r;
    const home = (d: string) => safeDir(d, cfg.user);

    // ── Fichiers ───────────────────────────────────────────────────────────
    r.add('write', 'cpanel_write_file', {
        title: 'Écrire un fichier texte',
        description: 'Crée ou remplace un fichier texte (ex. .htaccess). Remplace le contenu existant : lisez-le d\'abord avec cpanel_read_file.',
        inputSchema: { dir: z.string(), file: z.string(), content: z.string().max(1_000_000) },
        run: async ({ dir, file, content }: { dir: string; file: string; content: string }) => {
            await client.uapi('Fileman', 'save_file_content', { dir: home(dir), file: safeName(file), content });
            return `${dir}/${file} enregistré (${content.length} caractères).`;
        },
    });

    r.add('write', 'cpanel_upload_file', {
        title: 'Envoyer un fichier (binaire ou zip)',
        description: 'Envoie un fichier encodé en base64 (image, zip…) dans un dossier du compte. Écrase un fichier du même nom. Maximum ~20 Mo.',
        inputSchema: {
            dir: z.string().describe('Dossier de destination relatif au home'),
            file: z.string().describe('Nom du fichier'),
            base64: z.string().max(28_000_000).describe('Contenu encodé en base64'),
        },
        run: async ({ dir, file, base64 }: { dir: string; file: string; base64: string }) => {
            const data = new Uint8Array(Buffer.from(base64, 'base64'));
            await client.uapiMultipart('Fileman', 'upload_files', { dir: home(dir), overwrite: 1 }, [{ field: 'file-1', name: safeName(file), data }]);
            return `${dir}/${file} envoyé (${data.length} octets).`;
        },
    });

    r.add('write', 'cpanel_make_dir', {
        title: 'Créer un dossier',
        description: 'Crée un dossier dans le compte.',
        inputSchema: { parent: z.string().describe('Dossier parent relatif au home'), name: z.string() },
        run: async ({ parent, name }: { parent: string; name: string }) => {
            await client.api2('Fileman', 'mkdir', { path: home(parent), name: safeName(name) });
            return `Dossier ${parent}/${name} créé.`;
        },
    });

    r.add('write', 'cpanel_file_operation', {
        title: 'Copier, déplacer, renommer, changer les droits, décompresser',
        description: 'Opération de fichier : copy, move, rename (source → destination), chmod (mode, ex. 0644), extract (archive zip/tar.gz → dossier destination). Un déplacement peut écraser la destination.',
        inputSchema: {
            op: z.enum(['copy', 'move', 'rename', 'chmod', 'extract']),
            source: z.string().describe('Chemin source relatif au home, ex. public_html/a.txt'),
            destination: z.string().optional().describe('Chemin de destination (copy, move, rename, extract)'),
            mode: z.string().regex(/^0?[0-7]{3}$/).optional().describe('Droits pour chmod, ex. 0644'),
        },
        run: async ({ op, source, destination, mode }: { op: string; source: string; destination?: string; mode?: string }) => {
            const params: Record<string, string> = { op, sourcefiles: home(source) };
            if (op === 'chmod') {
                if (!mode) throw new CpanelError('mode requis pour chmod.');
                params.metadata = mode.padStart(4, '0');
            } else {
                if (!destination) throw new CpanelError(`destination requise pour ${op}.`);
                params.destfiles = home(destination);
            }
            await client.api2('Fileman', 'fileop', params);
            return `${op} effectué : ${source}${destination ? ' → ' + destination : ''}${mode ? ' (' + mode + ')' : ''}.`;
        },
    });

    // ── Email ──────────────────────────────────────────────────────────────
    r.add('write', 'cpanel_create_email', {
        title: 'Créer une boîte mail',
        description: 'Crée une boîte mail. Le mot de passe doit être fort ; il n\'est jamais journalisé.',
        inputSchema: {
            user: z.string().regex(/^[A-Za-z0-9._+-]+$/).describe('Partie avant @'),
            domain: z.string(),
            password: z.string().min(12),
            quota_mb: z.number().int().min(0).default(1024).describe('Quota en Mo, 0 = illimité'),
        },
        run: async ({ user, domain, password, quota_mb }: { user: string; domain: string; password: string; quota_mb: number }) => {
            await client.uapi('Email', 'add_pop', { email: user, domain, password, quota: quota_mb });
            return `Boîte ${user}@${domain} créée (quota ${quota_mb || 'illimité'} Mo).`;
        },
    });

    r.add('write', 'cpanel_set_email_password', {
        title: 'Changer le mot de passe d\'une boîte mail',
        description: 'Change le mot de passe d\'une boîte mail existante.',
        inputSchema: { user: z.string(), domain: z.string(), password: z.string().min(12) },
        run: async ({ user, domain, password }: { user: string; domain: string; password: string }) => {
            await client.uapi('Email', 'passwd_pop', { email: user, domain, password });
            return `Mot de passe de ${user}@${domain} changé.`;
        },
    });

    r.add('write', 'cpanel_set_email_quota', {
        title: 'Changer le quota d\'une boîte mail',
        description: 'Modifie le quota d\'une boîte mail (Mo, 0 = illimité).',
        inputSchema: { user: z.string(), domain: z.string(), quota_mb: z.number().int().min(0) },
        run: async ({ user, domain, quota_mb }: { user: string; domain: string; quota_mb: number }) => {
            await client.uapi('Email', 'edit_pop_quota', { email: user, domain, quota: quota_mb });
            return `Quota de ${user}@${domain} : ${quota_mb || 'illimité'} Mo.`;
        },
    });

    r.add('write', 'cpanel_add_email_forwarder', {
        title: 'Ajouter une redirection email',
        description: 'Redirige les messages reçus par une adresse vers une autre adresse.',
        inputSchema: { address: z.string().describe('Adresse complète à rediriger, ex. contact@mondomaine.fr'), to: z.string().email() },
        run: async ({ address, to }: { address: string; to: string }) => {
            const [local, domain] = address.split('@');
            if (!local || !domain) throw new CpanelError('address doit être une adresse complète.');
            await client.uapi('Email', 'add_forwarder', { domain, email: address, fwdopt: 'fwd', fwdemail: to });
            return `${address} → ${to}.`;
        },
    });

    r.add('write', 'cpanel_add_autoresponder', {
        title: 'Créer un répondeur automatique',
        description: 'Répondeur automatique (absence, accusé de réception).',
        inputSchema: {
            address: z.string(), from: z.string().describe('Nom d\'expéditeur affiché'), subject: z.string(), body: z.string(),
            interval_hours: z.number().int().min(0).default(24), start: z.number().int().optional().describe('Début, timestamp Unix'),
            stop: z.number().int().optional().describe('Fin, timestamp Unix'),
        },
        run: async (a: { address: string; from: string; subject: string; body: string; interval_hours: number; start?: number; stop?: number }) => {
            const [local, domain] = a.address.split('@');
            if (!local || !domain) throw new CpanelError('address doit être une adresse complète.');
            await client.uapi('Email', 'add_auto_responder', {
                email: local, domain, from: a.from, subject: a.subject, body: a.body, is_html: 0,
                interval: a.interval_hours, start: a.start, stop: a.stop,
            });
            return `Répondeur créé pour ${a.address}.`;
        },
    });

    // ── Bases de données ───────────────────────────────────────────────────
    r.add('write', 'cpanel_create_database', {
        title: 'Créer une base MySQL',
        description: 'Crée une base. Le nom doit commencer par le préfixe du compte (voir cpanel_list_databases > restrictions), ex. moncompte_site.',
        inputSchema: { name: z.string().regex(/^[A-Za-z0-9_]+$/) },
        run: async ({ name }: { name: string }) => {
            await client.uapi('Mysql', 'create_database', { name });
            return `Base ${name} créée.`;
        },
    });

    r.add('write', 'cpanel_create_db_user', {
        title: 'Créer un utilisateur MySQL',
        description: 'Crée un utilisateur MySQL (préfixe du compte requis).',
        inputSchema: { name: z.string().regex(/^[A-Za-z0-9_]+$/), password: z.string().min(12) },
        run: async ({ name, password }: { name: string; password: string }) => {
            await client.uapi('Mysql', 'create_user', { name, password });
            return `Utilisateur ${name} créé.`;
        },
    });

    r.add('write', 'cpanel_grant_db_privileges', {
        title: 'Donner des droits sur une base',
        description: 'Attribue des privilèges à un utilisateur MySQL sur une base.',
        inputSchema: { user: z.string(), database: z.string(), privileges: z.string().default('ALL PRIVILEGES') },
        run: async ({ user, database, privileges }: { user: string; database: string; privileges: string }) => {
            await client.uapi('Mysql', 'set_privileges_on_database', { user, database, privileges });
            return `${user} : ${privileges} sur ${database}.`;
        },
    });

    // ── Domaines ───────────────────────────────────────────────────────────
    r.add('write', 'cpanel_create_subdomain', {
        title: 'Créer un sous-domaine',
        description: 'Crée un sous-domaine (ex. staging sur mondomaine.fr) avec son dossier racine.',
        inputSchema: {
            subdomain: z.string().regex(/^[a-z0-9-]+$/), rootdomain: z.string(),
            dir: z.string().optional().describe('Dossier racine relatif au home (défaut : public_html/<sous-domaine>)'),
        },
        run: async ({ subdomain, rootdomain, dir }: { subdomain: string; rootdomain: string; dir?: string }) => {
            const d = home(dir || `public_html/${subdomain}`);
            await client.uapi('SubDomain', 'addsubdomain', { domain: subdomain, rootdomain, dir: d });
            return `Sous-domaine ${subdomain}.${rootdomain} créé (racine : ${d}).`;
        },
    });

    r.add('write', 'cpanel_add_addon_domain', {
        title: 'Ajouter un domaine additionnel',
        description: 'Ajoute un domaine additionnel (site séparé) avec son dossier racine. Le domaine doit pointer vers le serveur.',
        inputSchema: {
            domain: z.string(), dir: z.string().describe('Dossier racine relatif au home, ex. monsite.fr'),
            subdomain: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Identifiant interne (défaut : déduit du domaine)'),
        },
        run: async ({ domain, dir, subdomain }: { domain: string; dir: string; subdomain?: string }) => {
            const sub = subdomain || domain.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase();
            await client.api2('AddonDomain', 'addaddondomain', { newdomain: domain, subdomain: sub, dir: home(dir) });
            return `Domaine additionnel ${domain} ajouté (racine : ${dir}).`;
        },
    });

    r.add('write', 'cpanel_add_alias_domain', {
        title: 'Ajouter un alias de domaine',
        description: 'Ajoute un alias (domaine parqué) qui affiche le même site que le domaine principal.',
        inputSchema: { domain: z.string() },
        run: async ({ domain }: { domain: string }) => {
            await client.api2('Park', 'park', { domain });
            return `Alias ${domain} ajouté.`;
        },
    });

    r.add('write', 'cpanel_add_redirect', {
        title: 'Ajouter une redirection web',
        description: 'Redirige un domaine ou un chemin vers une URL (301 permanente ou 302 temporaire).',
        inputSchema: {
            domain: z.string().describe('Domaine source, ou « ALL » pour tous'), path: z.string().default('/').describe('Chemin source, ex. /ancien'),
            to: z.string().url(), type: z.enum(['permanent', 'temp']).default('permanent'),
            wildcard: z.boolean().default(false).describe('Rediriger aussi tous les fichiers sous ce chemin'),
            www: z.enum(['only', 'without', 'both']).default('both'),
        },
        run: async (a: { domain: string; path: string; to: string; type: string; wildcard: boolean; www: string }) => {
            const redirect_www = { only: 1, without: 2, both: 0 }[a.www as 'only' | 'without' | 'both'];
            await client.uapi('Mime', 'add_redirect', {
                domain: a.domain, src: a.path, redirect: a.to, type: a.type, redirect_wildcard: a.wildcard ? 1 : 0, redirect_www,
            });
            return `Redirection ${a.type} : ${a.domain}${a.path} → ${a.to}.`;
        },
    });

    // ── DNS (domaines dont le DNS est chez l'hébergeur) ────────────────────
    r.add('write', 'cpanel_add_dns_record', {
        title: 'Ajouter un enregistrement DNS',
        description: 'Ajoute un enregistrement (A, AAAA, CNAME, MX, TXT, SRV, CAA) dans une zone gérée par l\'hébergeur. Sans effet si le DNS du domaine est chez Cloudflare.',
        inputSchema: {
            zone: z.string(), name: z.string().describe('Nom relatif (www) ou absolu avec point final'),
            type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA']), ttl: z.number().int().min(60).default(14400),
            values: z.array(z.string()).min(1).describe('Valeurs ; MX : ["10", "mail.exemple.fr."]'),
        },
        run: async (a: { zone: string; name: string; type: string; ttl: number; values: string[] }) => {
            const serial = await zoneSerial(r, a.zone);
            await client.uapi('DNS', 'mass_edit_zone', {
                zone: a.zone, serial, add: JSON.stringify({ dname: a.name, ttl: a.ttl, record_type: a.type, data: a.values }),
            });
            return `${a.type} ${a.name} ajouté dans ${a.zone}.`;
        },
    });

    r.add('write', 'cpanel_edit_dns_record', {
        title: 'Modifier un enregistrement DNS',
        description: 'Modifie l\'enregistrement d\'une ligne donnée (numéro « ligne » de cpanel_dns_zone).',
        inputSchema: {
            zone: z.string(), line: z.number().int(), name: z.string(), type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA']),
            ttl: z.number().int().min(60).default(14400), values: z.array(z.string()).min(1),
        },
        run: async (a: { zone: string; line: number; name: string; type: string; ttl: number; values: string[] }) => {
            const serial = await zoneSerial(r, a.zone);
            await client.uapi('DNS', 'mass_edit_zone', {
                zone: a.zone, serial, edit: JSON.stringify({ line_index: a.line, dname: a.name, ttl: a.ttl, record_type: a.type, data: a.values }),
            });
            return `Ligne ${a.line} de ${a.zone} modifiée.`;
        },
    });

    // ── SSL ────────────────────────────────────────────────────────────────
    r.add('write', 'cpanel_run_autossl', {
        title: 'Lancer AutoSSL',
        description: 'Lance une vérification AutoSSL pour émettre ou renouveler les certificats du compte.',
        run: async () => {
            await client.uapi('SSL', 'start_autossl_check');
            return 'Vérification AutoSSL lancée. Consultez cpanel_ssl_status dans quelques minutes.';
        },
    });

    r.add('write', 'cpanel_autossl_exclusion', {
        title: 'Exclure / réinclure des domaines d\'AutoSSL',
        description: 'Exclut des domaines d\'AutoSSL (ex. domaines servis par Cloudflare) ou les réinclut.',
        inputSchema: { action: z.enum(['exclude', 'include']), domains: z.array(z.string()).min(1) },
        run: async ({ action, domains }: { action: string; domains: string[] }) => {
            const fn = action === 'exclude' ? 'add_autossl_excluded_domains' : 'remove_autossl_excluded_domains';
            await client.uapi('SSL', fn, { domains: domains.join(',') });
            return `${domains.join(', ')} : ${action === 'exclude' ? 'exclus' : 'réinclus'} d'AutoSSL.`;
        },
    });

    r.add('write', 'cpanel_install_ssl', {
        title: 'Installer un certificat SSL',
        description: 'Installe un certificat fourni (PEM) pour un domaine. La clé privée n\'est jamais journalisée.',
        inputSchema: { domain: z.string(), cert: z.string(), key: z.string(), cabundle: z.string().optional() },
        run: async (a: { domain: string; cert: string; key: string; cabundle?: string }) => {
            await client.uapi('SSL', 'install_ssl', { domain: a.domain, cert: a.cert, key: a.key, cabundle: a.cabundle });
            return `Certificat installé pour ${a.domain}.`;
        },
    });

    // ── PHP ────────────────────────────────────────────────────────────────
    r.add('write', 'cpanel_set_php_version', {
        title: 'Changer la version PHP d\'un domaine',
        description: 'Change la version PHP (MultiPHP) d\'un domaine, ex. ea-php83. Voir cpanel_php_versions pour les valeurs possibles.',
        inputSchema: { domain: z.string(), version: z.string().describe('ex. ea-php83, ou « inherit »') },
        run: async ({ domain, version }: { domain: string; version: string }) => {
            await client.uapi('LangPHP', 'php_set_vhost_versions', { vhost: domain, version });
            return `${domain} : PHP ${version}.`;
        },
    });

    // ── Applications Node.js / Python ──────────────────────────────────────
    r.add('write', 'cpanel_register_app', {
        title: 'Déclarer une application Node.js / Python',
        description: 'Déclare une application Passenger (le code doit déjà être dans le dossier).',
        inputSchema: {
            name: z.string(), path: z.string().describe('Dossier de l\'application relatif au home'), domain: z.string(),
            base_uri: z.string().default('/'), mode: z.enum(['production', 'development']).default('production'),
        },
        run: async (a: { name: string; path: string; domain: string; base_uri: string; mode: string }) => {
            await client.uapi('PassengerApps', 'register_application', {
                name: a.name, path: home(a.path), domain: a.domain, base_uri: a.base_uri, deployment_mode: a.mode,
            });
            return `Application ${a.name} déclarée sur ${a.domain}${a.base_uri}.`;
        },
    });

    r.add('write', 'cpanel_app_state', {
        title: 'Activer / désactiver / redémarrer une application',
        description: 'Active, désactive ou redémarre une application Passenger (redémarrage = fichier tmp/restart.txt).',
        inputSchema: { name: z.string(), action: z.enum(['enable', 'disable', 'restart']), path: z.string().optional().describe('Requis pour restart : dossier de l\'application') },
        run: async ({ name, action, path }: { name: string; action: string; path?: string }) => {
            if (action === 'restart') {
                if (!path) throw new CpanelError('path requis pour restart.');
                await client.uapi('Fileman', 'save_file_content', { dir: home(`${path}/tmp`), file: 'restart.txt', content: new Date().toISOString() });
                return `Redémarrage de ${name} demandé.`;
            }
            await client.uapi('PassengerApps', action === 'enable' ? 'enable_application' : 'disable_application', { name });
            return `${name} : ${action === 'enable' ? 'activée' : 'désactivée'}.`;
        },
    });

    // ── Git ────────────────────────────────────────────────────────────────
    r.add('write', 'cpanel_git_clone', {
        title: 'Cloner un dépôt Git dans cPanel',
        description: 'Crée un dépôt géré par cPanel en clonant une URL (dépôt public, ou privé avec clé de déploiement configurée).',
        inputSchema: { url: z.string(), path: z.string().describe('Dossier cible relatif au home'), name: z.string() },
        run: async ({ url, path, name }: { url: string; path: string; name: string }) => {
            await client.uapi('VersionControl', 'create', {
                type: 'git', name, repository_root: home(path), source_repository: JSON.stringify({ remote_name: 'origin', url }),
            });
            return `Clonage de ${url} dans ${path} lancé.`;
        },
    });

    r.add('write', 'cpanel_git_pull_deploy', {
        title: 'Mettre à jour / déployer un dépôt Git cPanel',
        description: '« pull » récupère la branche ; « deploy » exécute le déploiement défini dans .cpanel.yml.',
        inputSchema: { path: z.string(), action: z.enum(['pull', 'deploy']), branch: z.string().optional() },
        run: async ({ path, action, branch }: { path: string; action: string; branch?: string }) => {
            const root = home(path);
            if (action === 'pull') await client.uapi('VersionControl', 'update', { repository_root: root, ...(branch ? { branch } : {}) });
            else await client.uapi('VersionControlDeployment', 'create', { repository_root: root });
            return `${action} effectué sur ${path}.`;
        },
    });

    // ── FTP ────────────────────────────────────────────────────────────────
    r.add('write', 'cpanel_create_ftp', {
        title: 'Créer un compte FTP',
        description: 'Crée un compte FTP limité à un dossier.',
        inputSchema: {
            user: z.string().regex(/^[A-Za-z0-9._-]+$/), domain: z.string(), password: z.string().min(12),
            dir: z.string().describe('Dossier autorisé relatif au home'), quota_mb: z.number().int().min(0).default(0),
        },
        run: async (a: { user: string; domain: string; password: string; dir: string; quota_mb: number }) => {
            await client.uapi('Ftp', 'add_ftp', { user: a.user, domain: a.domain, pass: a.password, homedir: home(a.dir), quota: a.quota_mb });
            return `Compte FTP ${a.user}@${a.domain} créé (dossier ${a.dir}).`;
        },
    });

    // ── Cron ───────────────────────────────────────────────────────────────
    const cronFields = {
        command: z.string().min(1),
        minute: z.string().default('0'), hour: z.string().default('*'), day: z.string().default('*'),
        month: z.string().default('*'), weekday: z.string().default('*'),
    };
    r.add('write', 'cpanel_add_cron_job', {
        title: 'Ajouter une tâche cron',
        description: 'Ajoute une tâche planifiée (champs au format cron).',
        inputSchema: cronFields,
        run: async (a: Record<string, string>) => {
            await client.api2('Cron', 'add_line', a);
            return `Tâche ajoutée : ${a.minute} ${a.hour} ${a.day} ${a.month} ${a.weekday} ${a.command}`;
        },
    });
    r.add('write', 'cpanel_edit_cron_job', {
        title: 'Modifier une tâche cron',
        description: 'Remplace une tâche existante (numéro « ligne » de cpanel_list_cron_jobs).',
        inputSchema: { line: z.union([z.string(), z.number()]), ...cronFields },
        run: async ({ line, ...a }: Record<string, any>) => {
            await client.api2('Cron', 'edit_line', { linekey: line, ...a });
            return `Tâche ${line} modifiée.`;
        },
    });

    // ── Sauvegarde ─────────────────────────────────────────────────────────
    r.add('write', 'cpanel_create_backup', {
        title: 'Lancer une sauvegarde complète',
        description: 'Génère une sauvegarde complète du compte dans le home (fichiers, bases, emails). Recommandé AVANT toute suppression importante.',
        inputSchema: { notify_email: z.string().email().optional() },
        run: async ({ notify_email }: { notify_email?: string }) => {
            await client.uapi('Backup', 'fullbackup_to_homedir', notify_email ? { email: notify_email } : {});
            return 'Sauvegarde complète lancée ; voir cpanel_list_backups dans quelques minutes.';
        },
    });

    // ── Universel ──────────────────────────────────────────────────────────
    r.add('write', 'cpanel_uapi_write', {
        title: 'Appel UAPI en écriture (universel)',
        description: 'Appelle n\'importe quelle fonction UAPI qui crée ou modifie (toutes les fonctionnalités de cPanel non couvertes ailleurs). Les fonctions de suppression sont refusées ici : utilisez cpanel_uapi_destructive. Modules sensibles (Tokens, Passwd, TwoFactorAuth, Session, SSH) bloqués.',
        inputSchema: { module: z.string(), function: z.string(), params: z.record(scalar).optional() },
        run: async ({ module, function: fn, params }: { module: string; function: string; params?: Record<string, any> }) => {
            assertModuleAllowed(module);
            refuseDestructive(fn);
            return (await client.uapi(module, fn, params || {})).data ?? 'OK';
        },
    });

    r.add('write', 'cpanel_api2_write', {
        title: 'Appel API 2 en écriture (universel)',
        description: 'Comme cpanel_uapi_write, pour les fonctions qui n\'existent qu\'en API 2 (ex. AddonDomain, Park, Fileman::fileop). Suppressions refusées ici.',
        inputSchema: { module: z.string(), function: z.string(), params: z.record(scalar).optional() },
        run: async ({ module, function: fn, params }: { module: string; function: string; params?: Record<string, any> }) => {
            assertModuleAllowed(module);
            refuseDestructive(fn);
            if (params?.op && /trash|unlink|delete/i.test(String(params.op))) refuseDestructive(String(params.op));
            return (await client.api2(module, fn, params || {})) ?? 'OK';
        },
    });
}
