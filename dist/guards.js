import { CpanelError } from './cpanel.js';
/** Fonctions UAPI de lecture autorisées pour l'appel générique en lecture. */
export const READ_PREFIX = /^(list|get|fetch|is|has|check|show|count|parse|retrieve|query)_/;
/** Une fonction dont le nom évoque une suppression exige le niveau Suppression + confirmation. */
export const DESTRUCTIVE_NAME = /(delete|remove|unlink|trash|destroy|unpark|unregister|revoke|terminate|drop|purge|wipe|^del|_del|deladdon|delsub)/i;
/**
 * Modules jamais accessibles, même en écriture : création de jetons, mot de passe du compte,
 * double authentification, sessions. Les toucher permettrait de prendre le contrôle du compte.
 */
export const BLOCKED_MODULES = new Set(['Tokens', 'Passwd', 'TwoFactorAuth', 'Session', 'SSH']);
/** Refuse toute sortie de l'arborescence du compte. */
export function safeDir(dir, user) {
    const d = dir.trim() || '/';
    if (d.includes('..') || d.includes('\0'))
        throw new CpanelError('Chemin refusé : « .. » interdit.');
    if (d.startsWith('/') && d !== `/home/${user}` && !d.startsWith(`/home/${user}/`)) {
        throw new CpanelError(`Chemin refusé : il doit être relatif au compte ou commencer par /home/${user}/.`);
    }
    return d;
}
/** Nom de fichier seul (pas de chemin). */
export function safeName(file) {
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) {
        throw new CpanelError('Nom de fichier invalide.');
    }
    return file;
}
/**
 * Confirmation obligatoire de toute suppression : le modèle doit recopier exactement la cible.
 * Empêche une suppression « par élan » ou déclenchée par un texte piégé imprécis.
 */
export function requireConfirm(target, confirm) {
    if (!confirm || confirm.trim() !== target.trim()) {
        throw new CpanelError(`Suppression refusée : pour confirmer, renvoyez exactement confirm="${target}". ` +
            `Vérifiez d'abord avec l'utilisateur que c'est bien la cible voulue.`);
    }
}
export function assertModuleAllowed(module) {
    if (BLOCKED_MODULES.has(module))
        throw new CpanelError(`Module ${module} bloqué (sécurité du compte).`);
}
