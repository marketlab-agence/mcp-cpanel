import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { CpanelClient } from './cpanel.js';
import { registerTools, safeDir } from './tools.js';

const TOKEN = 'TESTTOKEN1234567890';
const env = { CPANEL_HOST: 'https://example.o2switch.net/', CPANEL_USER: 'acme', CPANEL_TOKEN: TOKEN };

/** Faux serveur cPanel : enregistre les requêtes et répond selon la fonction appelée. */
function fakeFetch(calls: { url: string; auth: string; body: string }[]) {
    return (async (url: any, init: any) => {
        const body = String(init?.body ?? '');
        calls.push({ url: String(url), auth: init?.headers?.Authorization, body });
        const u = String(url);
        const reply = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
        if (u.endsWith('/execute/DomainInfo/list_domains')) return reply({ status: 1, data: { main_domain: 'acme.fr' }, errors: null, messages: null });
        if (u.endsWith('/execute/Email/list_pops_with_disk')) return reply({ status: 1, data: [{ email: 'a@acme.fr', humandiskquota: '1 GB', humandiskused: '2 MB', suspended_login: 0 }], errors: null, messages: null });
        if (u.endsWith('/execute/Fail/get_x')) return reply({ status: 0, data: null, errors: [`bad token ${TOKEN}`], messages: null });
        if (u.endsWith('/json-api/cpanel')) return reply({ cpanelresult: { data: [{ linekey: 1, minute: '0', hour: '3', day: '*', month: '*', weekday: '*', command: 'php x.php' }, { count: 2 }], event: { result: 1 } } });
        if (u.includes('/Unauthorized/')) return reply({}, 401);
        return reply({ status: 1, data: [], errors: null, messages: null });
    }) as typeof fetch;
}

async function connect(extraEnv: Record<string, string> = {}) {
    const calls: { url: string; auth: string; body: string }[] = [];
    const cfg = loadConfig({ ...env, ...extraEnv });
    const client = new CpanelClient(cfg, fakeFetch(calls));
    const server = new McpServer({ name: 't', version: '0' });
    registerTools(server, client, cfg);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return { mcp, calls };
}

const text = (r: any) => r.content[0].text as string;

test('config : hôte nettoyé, port par défaut 2083, lecture seule par défaut', () => {
    const cfg = loadConfig(env);
    assert.equal(cfg.host, 'example.o2switch.net');
    assert.equal(cfg.port, 2083);
    assert.equal(cfg.allowWrites, false);
    assert.throws(() => loadConfig({}), /CPANEL_HOST, CPANEL_USER, CPANEL_TOKEN/);
});

test('lecture seule par défaut : aucun outil d\'écriture exposé', async () => {
    const { mcp } = await connect();
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('cpanel_list_domains'));
    assert.ok(!names.some((n) => /create|write|add_cron|run_autossl/.test(n)), names.join(','));
    assert.ok(!names.some((n) => /delete|remove|destroy/.test(n)));
});

test('écritures uniquement avec CPANEL_ALLOW_WRITES=1, jamais de suppression', async () => {
    const { mcp } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('cpanel_create_subdomain') && names.includes('cpanel_write_file'));
    assert.ok(!names.some((n) => /delete|remove|destroy/.test(n)));
});

test('appel UAPI : URL, en-tête d\'authentification et paramètres en POST', async () => {
    const { mcp, calls } = await connect();
    const r = await mcp.callTool({ name: 'cpanel_list_email_accounts', arguments: { domain: 'acme.fr' } });
    assert.match(text(r), /a@acme\.fr/);
    assert.equal(calls[0].url, 'https://example.o2switch.net:2083/execute/Email/list_pops_with_disk');
    assert.equal(calls[0].auth, `cpanel acme:${TOKEN}`);
    assert.equal(calls[0].body, 'domain=acme.fr');
});

test('API 2 (cron) : lignes vides filtrées', async () => {
    const { mcp } = await connect();
    const rows = JSON.parse(text(await mcp.callTool({ name: 'cpanel_list_cron_jobs', arguments: {} })));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].commande, 'php x.php');
});

test('le jeton n\'apparaît jamais dans une erreur renvoyée au modèle', async () => {
    const { mcp } = await connect();
    const r: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Fail', function: 'get_x' } });
    assert.equal(r.isError, true);
    assert.ok(!text(r).includes(TOKEN), text(r));
    assert.match(text(r), /\*\*\*/);
});

test('appel générique : écritures et modules sensibles refusés', async () => {
    const { mcp, calls } = await connect();
    const w: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Email', function: 'delete_pop' } });
    const s: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Tokens', function: 'list' } });
    assert.equal(w.isError, true);
    assert.equal(s.isError, true);
    assert.equal(calls.length, 0, 'aucune requête ne doit partir');
});

test('chemins : sortie du compte refusée', () => {
    assert.equal(safeDir('public_html', 'acme'), 'public_html');
    assert.equal(safeDir('/home/acme/public_html', 'acme'), '/home/acme/public_html');
    assert.throws(() => safeDir('../etc', 'acme'));
    assert.throws(() => safeDir('/etc', 'acme'));
    assert.throws(() => safeDir('/home/acmeX/x', 'acme'));
});

test('401 : message clair, sans jeton', async () => {
    const cfg = loadConfig(env);
    const client = new CpanelClient(cfg, fakeFetch([]));
    await assert.rejects(client.uapi('Unauthorized', 'get_x'), (e: Error) => /Authentification refusée/.test(e.message) && !e.message.includes(TOKEN));
});
