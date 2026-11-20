export class CpanelError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'CpanelError';
    }
}
/** Nom de module ou de fonction cPanel : lettres, chiffres, soulignés. Empêche toute injection de chemin. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * Client minimal UAPI / API 2 cPanel, authentifié par jeton API.
 * Documentation : https://api.docs.cpanel.net/cpanel/introduction
 */
export class CpanelClient {
    cfg;
    fetchImpl;
    constructor(cfg, fetchImpl = fetch) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
    }
    get base() {
        return `https://${this.cfg.host}:${this.cfg.port}`;
    }
    headers() {
        return { Authorization: `cpanel ${this.cfg.user}:${this.cfg.token}`, Accept: 'application/json' };
    }
    /** Retire le jeton de tout texte susceptible de remonter au modèle. */
    redact(text) {
        return this.cfg.token ? text.split(this.cfg.token).join('***') : text;
    }
    async request(url, init) {
        let res;
        try {
            res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
        }
        catch (err) {
            throw new CpanelError(this.redact(`Connexion à ${this.cfg.host}:${this.cfg.port} impossible : ${err?.message || err}`));
        }
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
            throw new CpanelError('Authentification refusée par cPanel : vérifiez CPANEL_USER et CPANEL_TOKEN (jeton révoqué ou expiré ?).', res.status);
        }
        if (!res.ok)
            throw new CpanelError(this.redact(`HTTP ${res.status} : ${text.slice(0, 300)}`), res.status);
        try {
            return JSON.parse(text);
        }
        catch {
            throw new CpanelError(this.redact(`Réponse non JSON (HTTP ${res.status}) : ${text.slice(0, 200)}`), res.status);
        }
    }
    /** Appel UAPI. Les paramètres passent en POST (form-urlencoded) pour ne jamais apparaître dans une URL. */
    async uapi(module, fn, params = {}) {
        if (!SAFE_NAME.test(module) || !SAFE_NAME.test(fn))
            throw new CpanelError(`Nom de module/fonction invalide : ${module}::${fn}`);
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                body.append(k, String(v));
        const json = (await this.request(`${this.base}/execute/${module}/${fn}`, {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }));
        if (json?.status !== 1) {
            const errs = (json?.errors || []).join(' ; ') || 'erreur inconnue';
            throw new CpanelError(this.redact(`${module}::${fn} a échoué : ${errs}`));
        }
        return json;
    }
    /** Appel API 2 (nécessaire pour Cron, qui n'a pas d'équivalent UAPI complet). */
    async api2(module, fn, params = {}) {
        if (!SAFE_NAME.test(module) || !SAFE_NAME.test(fn))
            throw new CpanelError(`Nom de module/fonction invalide : ${module}::${fn}`);
        const body = new URLSearchParams({
            cpanel_jsonapi_user: this.cfg.user,
            cpanel_jsonapi_apiversion: '2',
            cpanel_jsonapi_module: module,
            cpanel_jsonapi_func: fn,
        });
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                body.append(k, String(v));
        const json = await this.request(`${this.base}/json-api/cpanel`, {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const result = json?.cpanelresult;
        if (!result || result.error || result.event?.result === 0) {
            throw new CpanelError(this.redact(`${module}::${fn} (API 2) a échoué : ${result?.error || 'réponse inattendue'}`));
        }
        return result.data;
    }
}
