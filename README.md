# mcp-cpanel

Serveur MCP **local** pour gérer un compte cPanel (o2switch ou tout hébergeur cPanel) depuis
**Claude Code**, **OpenCode** ou n'importe quel client MCP.

- Appels directs à l'API UAPI de votre hébergeur : **aucun service tiers**, le jeton reste sur votre machine.
- **Lecture seule par défaut.** Les outils d'écriture n'existent que si `CPANEL_ALLOW_WRITES=1`.
- **Aucun outil de suppression**, volontairement.
- Le jeton n'est jamais renvoyé au modèle (masqué dans toutes les erreurs).
- Paquet autonome : il ne dépend d'aucun projet, il s'installe une fois pour toute la machine.

## Outils

| Outil | Rôle | Mode |
|---|---|---|
| `cpanel_account_overview` | Quota, ressources (CPU, RAM, inodes), domaines | lecture |
| `cpanel_list_domains` | Domaines, sous-domaines, alias et dossiers racines | lecture |
| `cpanel_ssl_status` | Certificats, émetteur, jours avant expiration | lecture |
| `cpanel_autossl_problems` | Erreurs AutoSSL | lecture |
| `cpanel_list_email_accounts` | Boîtes mail et espace utilisé | lecture |
| `cpanel_list_email_forwarders` | Redirections email | lecture |
| `cpanel_list_databases` | Bases MySQL | lecture |
| `cpanel_list_cron_jobs` | Tâches cron | lecture |
| `cpanel_list_files` | Contenu d'un dossier du compte | lecture |
| `cpanel_read_file` | Lire un fichier texte (`.htaccess`, `robots.txt`…) | lecture |
| `cpanel_uapi_read` | Appel UAPI générique **limité aux fonctions de lecture** (`list_*`, `get_*`…) ; modules sensibles bloqués | lecture |
| `cpanel_create_subdomain` | Créer un sous-domaine | écriture |
| `cpanel_run_autossl` | Lancer AutoSSL | écriture |
| `cpanel_write_file` | Créer/remplacer un fichier texte | écriture |
| `cpanel_add_cron_job` | Ajouter une tâche cron | écriture |

Tous les chemins sont confinés au home du compte (`..` et chemins hors `/home/<user>/` refusés).

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

## 2. Installer (une fois par machine)

Prérequis : Node.js ≥ 20.

```bash
cd tools/mcp-cpanel        # ou le dossier où vous avez cloné ce paquet
npm install
npm run build
npm test                   # 9 tests, sans réseau
npm install -g .           # rend la commande `mcp-cpanel` disponible partout
```

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
`CPANEL_ALLOW_WRITES=1` (active les 4 outils d'écriture).

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
        "CPANEL_TOKEN": "{env:CPANEL_TOKEN}"
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

## Publier comme dépôt indépendant

Ce dossier est autonome. Pour en faire un dépôt à part en conservant l'historique :

```bash
git subtree split --prefix tools/mcp-cpanel -b mcp-cpanel
git push git@github.com:<vous>/mcp-cpanel.git mcp-cpanel:main
```

## Licence

MIT
