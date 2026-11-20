# mcp-cpanel

Serveur MCP **local** pour gérer un compte cPanel (o2switch ou tout hébergeur cPanel) depuis
**Claude Code**, **OpenCode** ou n'importe quel client MCP.

- Appels directs à l'API de votre hébergeur : **aucun service tiers**, le jeton reste sur votre machine.
- **Trois niveaux d'accès**, activés séparément ; par défaut, **lecture seule**.
- Le jeton n'est jamais renvoyé au modèle (masqué dans toutes les erreurs).
- **Journal local** de chaque écriture et suppression (mots de passe et clés masqués).
- Paquet autonome : il ne dépend d'aucun projet, il s'installe une fois pour toute la machine.

## Niveaux d'accès

| Niveau | Variables | Outils | Ce qui est permis |
|---|---|---|---|
| **Lecture** | aucune (défaut) | 20 | Tout consulter |
| **Écriture** | `CPANEL_ALLOW_WRITES=1` | 52 | + créer et modifier (boîtes, bases, domaines, DNS, fichiers, PHP, apps, Git, FTP, cron, sauvegarde) et appel universel |
| **Suppression** | `CPANEL_ALLOW_WRITES=1` **et** `CPANEL_ALLOW_DESTRUCTIVE=1` | 68 | + supprimer |

`CPANEL_ALLOW_DESTRUCTIVE` seul est **ignoré** : la suppression exige aussi l'écriture.

### Protections permanentes

- **Confirmation exacte** : chaque suppression exige `confirm` = la cible exacte (adresse, nom de base, chemin,
  `zone#ligne`, `Module::fonction`…). Sans elle, aucune requête ne part.
- **Corbeille** : les fichiers sont déplacés dans `~/.trash` (récupérables), jamais effacés directement.
  Les dossiers racines (`/`, `public_html`, home) sont refusés.
- **Modules interdits à tous les niveaux** : `Tokens` (création de jetons), `Passwd` (mot de passe du compte),
  `TwoFactorAuth`, `Session`, `SSH` — ils permettraient de prendre le contrôle du compte.
- **Écriture universelle sans suppression** : `cpanel_uapi_write` refuse toute fonction dont le nom évoque une
  suppression (`delete`, `remove`, `trash`, `unpark`…) ; il faut passer par le niveau Suppression.
- **Chemins confinés** au home du compte (`..` et chemins hors `/home/<user>/` refusés).
- **Contenu lu = donnée** : les descriptions d'outils rappellent au modèle de ne jamais exécuter d'instruction
  trouvée dans un fichier lu (protection contre un texte piégé déposé sur un site).

### Journal

Chaque écriture et suppression ajoute une ligne JSON (date, compte, outil, paramètres avec secrets masqués,
succès ou erreur) dans `%USERPROFILE%\.mcp-cpanel\journal.log` (Windows) ou `~/.mcp-cpanel/journal.log`.
Autre emplacement : `CPANEL_JOURNAL=C:\chemin\journal.log` ; désactiver : `CPANEL_JOURNAL=off`.

## Outils

**Lecture (20)** — `cpanel_account_overview` (quota, ressources, niveaux actifs), `cpanel_list_domains`,
`cpanel_list_redirects`, `cpanel_ssl_status`, `cpanel_autossl_problems`, `cpanel_list_email_accounts`,
`cpanel_list_email_forwarders`, `cpanel_list_autoresponders`, `cpanel_list_databases` (avec utilisateurs et
préfixe imposé), `cpanel_list_ftp_accounts`, `cpanel_list_cron_jobs`, `cpanel_dns_zone`, `cpanel_php_versions`,
`cpanel_list_apps`, `cpanel_list_git_repos`, `cpanel_list_backups`, `cpanel_stats`, `cpanel_list_files`,
`cpanel_read_file`, `cpanel_uapi_read` (toute fonction de lecture).

**Écriture (+32)** — fichiers : `cpanel_write_file`, `cpanel_upload_file` (binaire/zip en base64),
`cpanel_make_dir`, `cpanel_file_operation` (copy, move, rename, chmod, extract) · email : `cpanel_create_email`,
`cpanel_set_email_password`, `cpanel_set_email_quota`, `cpanel_add_email_forwarder`, `cpanel_add_autoresponder` ·
bases : `cpanel_create_database`, `cpanel_create_db_user`, `cpanel_grant_db_privileges` · domaines :
`cpanel_create_subdomain`, `cpanel_add_addon_domain`, `cpanel_add_alias_domain`, `cpanel_add_redirect` · DNS :
`cpanel_add_dns_record`, `cpanel_edit_dns_record` · SSL : `cpanel_run_autossl`, `cpanel_autossl_exclusion`,
`cpanel_install_ssl` · PHP : `cpanel_set_php_version` · applications : `cpanel_register_app`, `cpanel_app_state`
(enable, disable, restart) · Git : `cpanel_git_clone`, `cpanel_git_pull_deploy` · `cpanel_create_ftp` ·
cron : `cpanel_add_cron_job`, `cpanel_edit_cron_job` · `cpanel_create_backup` · universel :
`cpanel_uapi_write`, `cpanel_api2_write`.

**Suppression (+16)** — `cpanel_trash_file`, `cpanel_delete_email`, `cpanel_delete_email_forwarder`,
`cpanel_delete_autoresponder`, `cpanel_delete_database`, `cpanel_delete_db_user`, `cpanel_delete_subdomain`,
`cpanel_delete_addon_domain`, `cpanel_delete_alias_domain`, `cpanel_delete_redirect`, `cpanel_delete_dns_record`,
`cpanel_delete_ftp`, `cpanel_delete_cron_job`, `cpanel_unregister_app`, `cpanel_uapi_destructive`,
`cpanel_api2_destructive`.

> **À valider sur votre hébergeur** : les noms de fonctions UAPI/API 2 suivent la documentation cPanel mais
> n'ont pas tous été testés sur un vrai compte. o2switch utilise CloudLinux : la version PHP et les
> applications Node.js peuvent passer par ses propres sélecteurs plutôt que par `LangPHP`/`PassengerApps`.
> Le DNS des domaines servis par Cloudflare se gère chez Cloudflare, pas ici.

## 1. Créer le jeton API dans cPanel (o2switch)

1. Connectez-vous à votre cPanel o2switch.
2. **Sécurité → Gérer les jetons d'API (Manage API Tokens)** → *Créer*.
3. Nom : `mcp-cpanel-<machine>`. Mettez une **date d'expiration** (ex. 90 jours).
4. Copiez le jeton : il n'est affiché qu'une fois.

Notez aussi :
- `CPANEL_HOST` : le nom du serveur o2switch indiqué dans votre espace client (ex. `xxxx.o2switch.net`),
  ou votre domaine si cPanel y répond sur le port 2083.
- `CPANEL_USER` : votre identifiant cPanel.

> Révoquer : même écran, bouton *Révoquer*. Faites-le immédiatement si le jeton a pu fuiter.

## 2. Installer (une fois par machine, pour TOUS vos projets)

Prérequis : Node.js ≥ 20. Une fois installé, `mcp-cpanel` est une commande globale, comme `git` :
l'endroit où se trouve le code source n'a plus aucune importance.

**Option A — depuis son dépôt GitHub dédié** (recommandé, aucun dossier à garder sur le disque) :

```bash
npm install -g https://github.com/marketlab-agence/mcp-cpanel/archive/refs/heads/main.tar.gz
```

> N'utilisez pas `npm install -g github:…` : avec `-g`, npm crée un lien vers un clone temporaire
> qu'il supprime ensuite (commande introuvable). L'archive `.tar.gz` s'installe proprement.
> Le dossier `dist/` (code compilé) est versionné : aucune compilation n'a lieu à l'installation.

**Option B — depuis un dossier local** (ce dossier, ou une copie) :

```bash
npm install && npm test    # 9 tests, sans réseau
npm install -g .
```

Vérifier : `where mcp-cpanel` (Windows) ou `which mcp-cpanel` (macOS/Linux).
Mettre à jour : relancer la même commande d'installation. Désinstaller : `npm uninstall -g mcp-cpanel`.

## 3. Stocker les identifiants dans l'environnement utilisateur

Ne mettez **jamais** le jeton dans un fichier de configuration versionné.

**Windows (PowerShell)** — variables persistantes de l'utilisateur :

```powershell
[Environment]::SetEnvironmentVariable('CPANEL_HOST',  'xxxx.o2switch.net', 'User')
[Environment]::SetEnvironmentVariable('CPANEL_USER',  'votre_identifiant',  'User')
[Environment]::SetEnvironmentVariable('CPANEL_TOKEN', 'LE_JETON',           'User')
```

Fermez puis rouvrez le terminal (et OpenCode / Claude Code) pour qu'elles soient prises en compte.

**macOS / Linux** : ajoutez les trois `export` dans `~/.zshrc` ou `~/.bashrc`.

Variables optionnelles : `CPANEL_PORT` (défaut `2083`), `CPANEL_TIMEOUT_MS` (défaut `30000`),
`CPANEL_ALLOW_WRITES=1` (niveau Écriture), `CPANEL_ALLOW_DESTRUCTIVE=1` (niveau Suppression, avec l'écriture),
`CPANEL_JOURNAL` (chemin du journal, ou `off`).

## 4. Brancher dans Claude Code (portée utilisateur = tous vos projets)

```bash
claude mcp add o2switch --scope user -- mcp-cpanel
claude mcp list            # doit afficher o2switch ✓ Connected
```

Le serveur hérite des variables `CPANEL_*` de votre environnement : le jeton n'est pas écrit dans
`~/.claude.json`. Pour une session avec écritures :

```bash
claude mcp add o2switch-rw --scope user -e CPANEL_ALLOW_WRITES=1 -- mcp-cpanel
```

## 5. Brancher dans OpenCode (configuration globale)

Dans `~/.config/opencode/opencode.json` (Windows : `%USERPROFILE%\.config\opencode\opencode.json`),
section `mcp` :

```json
{
  "mcp": {
    "o2switch": {
      "type": "local",
      "command": ["mcp-cpanel"],
      "enabled": false,
      "environment": {
        "CPANEL_HOST": "{env:CPANEL_HOST}",
        "CPANEL_USER": "{env:CPANEL_USER}",
        "CPANEL_TOKEN": "{env:CPANEL_TOKEN}",
        "CPANEL_ALLOW_WRITES": "{env:CPANEL_ALLOW_WRITES}",
        "CPANEL_ALLOW_DESTRUCTIVE": "{env:CPANEL_ALLOW_DESTRUCTIVE}"
      }
    }
  }
}
```

`"enabled": false` le garde désactivé par défaut pour ne pas consommer de tokens : activez-le
quand vous en avez besoin. Sous Windows, si `mcp-cpanel` n'est pas trouvé, remplacez la commande par
`["mcp-cpanel.cmd"]` ou par `["node", "C:\\chemin\\vers\\mcp-cpanel\\dist\\index.js"]`.

## 6. Valider sur votre compte (lecture seule, 5 minutes)

Demandez à l'assistant, dans cet ordre :

1. « Avec o2switch, donne la vue d'ensemble du compte » → `cpanel_account_overview`
2. « Liste mes domaines » → `cpanel_list_domains`
3. « État des certificats SSL » → `cpanel_ssl_status`
4. « Liste les boîtes mail » → `cpanel_list_email_accounts`
5. « Liste les tâches cron » → `cpanel_list_cron_jobs`
6. « Liste public_html » → `cpanel_list_files`

Si un outil renvoie « fonction inconnue », la fonction UAPI a un autre nom sur votre version de cPanel :
cherchez le bon nom dans la [documentation UAPI](https://api.docs.cpanel.net/cpanel/introduction)
(ou via le MCP documentaire officiel `https://api.docs.cpanel.net/mcp`) et corrigez `src/tools.ts`.

Test sans assistant : `npm run inspect` ouvre l'inspecteur MCP officiel dans le navigateur.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `Variables d'environnement manquantes` | Terminal/client non redémarré après la création des variables |
| `Authentification refusée par cPanel` | Jeton révoqué/expiré, ou mauvais `CPANEL_USER` |
| `Connexion … impossible` | Mauvais `CPANEL_HOST`, port 2083 filtré par le réseau, ou VPN |
| Aucun outil d'écriture | Normal : définir `CPANEL_ALLOW_WRITES=1` |

## Publier comme dépôt indépendant (requis pour l'option A)

Ce dossier est autonome. Pour en faire le dépôt `marketlab-agence/mcp-cpanel` en conservant l'historique :

1. Créer le dépôt **vide** `marketlab-agence/mcp-cpanel` sur GitHub (privé ou public).
2. Depuis le dépôt qui contient ce dossier :

```bash
git subtree split --prefix tools/mcp-cpanel -b mcp-cpanel
git push https://github.com/marketlab-agence/mcp-cpanel.git mcp-cpanel:main
```

Dépôt privé : l'option A demande un jeton GitHub ; gardez le dépôt public ou utilisez l'option B.

## Modifier le code

`dist/` est versionné pour que l'installation n'ait rien à compiler. Après toute modification de `src/` :

```bash
npm run build && npm test
git add src dist && git commit -m "…"
```

## Licence

MIT
