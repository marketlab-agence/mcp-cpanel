import { z } from 'zod';
import type { Registry } from './registry.js';
import { assertModuleAllowed, requireConfirm, safeDir } from './guards.js';
import { zoneSerial } from './tools-write.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const confirm = z.string().describe('Recopier EXACTEMENT la cible indiquée dans la description, après accord explicite de l\'utilisateur');

/** Rappel ajouté à chaque description de suppression. */
const RULE = ' Avant d\'appeler : montrer la cible à l\'utilisateur et obtenir son accord explicite. Pour une base ou un domaine, proposer d\'abord cpanel_create_backup.';

export function registerDestructiveTools(r: Registry): void {
    const { client, cfg } = r;

    r.add('destructive', 'cpanel_trash_file', {
        title: 'Mettre un fichier ou dossier à la corbeille',
        description: 'Déplace un fichier ou un dossier dans la corbeille du compte (~/.trash), récupérable. confirm = le chemin exact.' + RULE,
        inputSchema: { path: z.string().describe('Chemin relatif au home, ex. public_html/ancien'), confirm },
        run: async ({ path, confirm: c }: { path: string; confirm: string }) => {
            const p = safeDir(path, cfg.user);
            if (['', '/', '.', 'public_html', `/home/${cfg.user}`, `/home/${cfg.user}/public_html`].includes(p.replace(/\/+$/, ''))) {
                throw new Error(`Refusé : ${p} est un dossier racine du compte.`);
            }
            requireConfirm(path, c);
            await client.api2('Fileman', 'fileop', { op: 'trash', sourcefiles: p });
            return `${path} déplacé dans la corbeille (~/.trash).`;
        },
    });

    r.add('destructive', 'cpanel_delete_email', {
        title: 'Supprimer une boîte mail',
        description: 'Supprime une boîte mail ET tous ses messages (irréversible). confirm = l\'adresse complète.' + RULE,
        inputSchema: { address: z.string().describe('ex. contact@mondomaine.fr'), confirm },
        run: async ({ address, confirm: c }: { address: string; confirm: string }) => {
            requireConfirm(address, c);
            const [email, domain] = address.split('@');
            await client.uapi('Email', 'delete_pop', { email, domain });
            return `Boîte ${address} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_delete_email_forwarder', {
        title: 'Supprimer une redirection email',
        description: 'Supprime une redirection. confirm = l\'adresse redirigée.' + RULE,
        inputSchema: { address: z.string(), to: z.string().describe('Destination de la redirection'), confirm },
        run: async ({ address, to, confirm: c }: { address: string; to: string; confirm: string }) => {
            requireConfirm(address, c);
            await client.uapi('Email', 'delete_forwarder', { address, forwarder: to });
            return `Redirection ${address} → ${to} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_delete_autoresponder', {
        title: 'Supprimer un répondeur automatique',
        description: 'Supprime un répondeur. confirm = l\'adresse.' + RULE,
        inputSchema: { address: z.string(), confirm },
        run: async ({ address, confirm: c }: { address: string; confirm: string }) => {
            requireConfirm(address, c);
            await client.uapi('Email', 'delete_auto_responder', { email: address });
            return `Répondeur de ${address} supprimé.`;
        },
    });

    r.add('destructive', 'cpanel_delete_database', {
        title: 'Supprimer une base MySQL',
        description: 'Supprime une base et toutes ses données (irréversible). confirm = le nom de la base.' + RULE,
        inputSchema: { name: z.string(), confirm },
        run: async ({ name, confirm: c }: { name: string; confirm: string }) => {
            requireConfirm(name, c);
            await client.uapi('Mysql', 'delete_database', { name });
            return `Base ${name} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_delete_db_user', {
        title: 'Supprimer un utilisateur MySQL',
        description: 'Supprime un utilisateur MySQL. confirm = son nom.' + RULE,
        inputSchema: { name: z.string(), confirm },
        run: async ({ name, confirm: c }: { name: string; confirm: string }) => {
            requireConfirm(name, c);
            await client.uapi('Mysql', 'delete_user', { name });
            return `Utilisateur ${name} supprimé.`;
        },
    });

    r.add('destructive', 'cpanel_delete_subdomain', {
        title: 'Supprimer un sous-domaine',
        description: 'Supprime un sous-domaine (les fichiers restent sur le disque). confirm = le sous-domaine complet, ex. staging.mondomaine.fr.' + RULE,
        inputSchema: { fqdn: z.string(), confirm },
        run: async ({ fqdn, confirm: c }: { fqdn: string; confirm: string }) => {
            requireConfirm(fqdn, c);
            await client.api2('SubDomain', 'delsubdomain', { domain: fqdn });
            return `Sous-domaine ${fqdn} supprimé (fichiers conservés).`;
        },
    });

    r.add('destructive', 'cpanel_delete_addon_domain', {
        title: 'Supprimer un domaine additionnel',
        description: 'Retire un domaine additionnel (les fichiers restent sur le disque). confirm = le domaine.' + RULE,
        inputSchema: { domain: z.string(), subdomain: z.string().describe('Identifiant interne, ex. monsite.domaineprincipal.fr (voir cpanel_list_domains)'), confirm },
        run: async ({ domain, subdomain, confirm: c }: { domain: string; subdomain: string; confirm: string }) => {
            requireConfirm(domain, c);
            await client.api2('AddonDomain', 'deladdondomain', { domain, subdomain });
            return `Domaine additionnel ${domain} retiré (fichiers conservés).`;
        },
    });

    r.add('destructive', 'cpanel_delete_alias_domain', {
        title: 'Supprimer un alias de domaine',
        description: 'Retire un alias (domaine parqué). confirm = le domaine.' + RULE,
        inputSchema: { domain: z.string(), confirm },
        run: async ({ domain, confirm: c }: { domain: string; confirm: string }) => {
            requireConfirm(domain, c);
            await client.api2('Park', 'unpark', { domain });
            return `Alias ${domain} retiré.`;
        },
    });

    r.add('destructive', 'cpanel_delete_redirect', {
        title: 'Supprimer une redirection web',
        description: 'Supprime une redirection. confirm = « domaine+chemin », ex. mondomaine.fr/ancien.' + RULE,
        inputSchema: { domain: z.string(), path: z.string().default('/'), confirm },
        run: async ({ domain, path, confirm: c }: { domain: string; path: string; confirm: string }) => {
            requireConfirm(`${domain}${path}`, c);
            await client.uapi('Mime', 'delete_redirect', { domain, src: path });
            return `Redirection ${domain}${path} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_delete_dns_record', {
        title: 'Supprimer un enregistrement DNS',
        description: 'Supprime la ligne d\'une zone (numéro « ligne » de cpanel_dns_zone). confirm = « zone#ligne », ex. mondomaine.fr#42.' + RULE,
        inputSchema: { zone: z.string(), line: z.number().int(), confirm },
        run: async ({ zone, line, confirm: c }: { zone: string; line: number; confirm: string }) => {
            requireConfirm(`${zone}#${line}`, c);
            const serial = await zoneSerial(r, zone);
            await client.uapi('DNS', 'mass_edit_zone', { zone, serial, remove: line });
            return `Ligne ${line} de ${zone} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_delete_ftp', {
        title: 'Supprimer un compte FTP',
        description: 'Supprime un compte FTP (ses fichiers sont conservés). confirm = « utilisateur@domaine ».' + RULE,
        inputSchema: { user: z.string(), domain: z.string(), confirm },
        run: async ({ user, domain, confirm: c }: { user: string; domain: string; confirm: string }) => {
            requireConfirm(`${user}@${domain}`, c);
            await client.uapi('Ftp', 'delete_ftp', { user, domain, destroy: 0 });
            return `Compte FTP ${user}@${domain} supprimé (fichiers conservés).`;
        },
    });

    r.add('destructive', 'cpanel_delete_cron_job', {
        title: 'Supprimer une tâche cron',
        description: 'Supprime une tâche (numéro « ligne » de cpanel_list_cron_jobs). confirm = ce numéro.' + RULE,
        inputSchema: { line: z.union([z.string(), z.number()]), confirm },
        run: async ({ line, confirm: c }: { line: string | number; confirm: string }) => {
            requireConfirm(String(line), c);
            await client.api2('Cron', 'remove_line', { line });
            return `Tâche ${line} supprimée.`;
        },
    });

    r.add('destructive', 'cpanel_unregister_app', {
        title: 'Retirer une application Node.js / Python',
        description: 'Retire la déclaration d\'une application Passenger (le code reste sur le disque). confirm = le nom.' + RULE,
        inputSchema: { name: z.string(), confirm },
        run: async ({ name, confirm: c }: { name: string; confirm: string }) => {
            requireConfirm(name, c);
            await client.uapi('PassengerApps', 'unregister_application', { name });
            return `Application ${name} retirée (fichiers conservés).`;
        },
    });

    r.add('destructive', 'cpanel_uapi_destructive', {
        title: 'Appel UAPI de suppression (universel)',
        description: 'Appelle n\'importe quelle fonction UAPI, y compris de suppression, non couverte par les outils dédiés. confirm = « Module::fonction », ex. Email::delete_pop. Modules sensibles bloqués.' + RULE,
        inputSchema: { module: z.string(), function: z.string(), params: z.record(scalar).optional(), confirm },
        run: async ({ module, function: fn, params, confirm: c }: { module: string; function: string; params?: Record<string, any>; confirm: string }) => {
            assertModuleAllowed(module);
            requireConfirm(`${module}::${fn}`, c);
            return (await client.uapi(module, fn, params || {})).data ?? 'OK';
        },
    });

    r.add('destructive', 'cpanel_api2_destructive', {
        title: 'Appel API 2 de suppression (universel)',
        description: 'Comme cpanel_uapi_destructive pour l\'API 2. confirm = « Module::fonction ».' + RULE,
        inputSchema: { module: z.string(), function: z.string(), params: z.record(scalar).optional(), confirm },
        run: async ({ module, function: fn, params, confirm: c }: { module: string; function: string; params?: Record<string, any>; confirm: string }) => {
            assertModuleAllowed(module);
            requireConfirm(`${module}::${fn}`, c);
            return (await client.api2(module, fn, params || {})) ?? 'OK';
        },
    });
}
