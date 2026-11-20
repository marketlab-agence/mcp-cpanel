import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { CpanelClient } from './cpanel.js';
import { registerTools, safeDir } from './tools.js';

const TOKEN = 'TESTTOKEN1234567890';
type Call = { url: string; auth: string; body: string; form?: FormData };

const tmpJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-')), 'journal.log');
const baseEnv = (extra: Record<string, string> = {}) => ({
    CPANEL_HOST: 'https://example.o2switch.net/', CPANEL_USER: 'acme', CPANEL_TOKEN: TOKEN, CPANEL_JOURNAL: 'off', ...extra,
});

const ok = (data: unknown = []) => ({ status: 1, data, errors: null, messages: null });
const SOA = { type: 'record', record_type: 'SOA', line_index: 1, data_b64: ['bnMx', 'aG9zdG1hc3Rlcg==', 'MjAyNjExMjAwMQ=='] }; // serial 2026112001

function fakeFetch(calls: Call[]) {
    return (async (url: any, init: any) => {
        const u = String(url);
        const form = init?.body instanceof FormData ? init.body : undefined;
        calls.push({ url: u, auth: init?.headers?.Authorization, body: form ? '' : String(init?.body ?? ''), form });
        const reply = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
        if (u.endsWith('/execute/Email/list_pops_with_disk')) return reply(ok([{ email: 'a@acme.fr', humandiskquota: '1 GB', humandiskused: '2 MB', suspended_login: 0 }]));
        if (u.endsWith('/execute/Fail/get_x')) return reply({ status: 0, data: null, errors: [`bad token ${TOKEN}`], messages: null });
        if (u.endsWith('/execute/DNS/parse_zone')) return reply(ok([SOA, { type: 'record', record_type: 'A', line_index: 7, dname_b64: 'd3d3', data_b64: ['MS4yLjMuNA=='], ttl: 300 }]));
        if (u.endsWith('/json-api/cpanel')) return reply({ cpanelresult: { data: [{ linekey: 1, minute: '0', hour: '3', day: '*', month: '*', weekday: '*', command: 'php x.php' }, { count: 2 }], event: { result: 1 } } });
        if (u.includes('/Unauthorized/')) return reply({}, 401);
        return reply(ok());
    }) as typeof fetch;
}

async function connect(extra: Record<string, string> = {}) {
    const calls: Call[] = [];
    const cfg = loadConfig(baseEnv(extra));
    const client = new CpanelClient(cfg, fakeFetch(calls));
    const server = new McpServer({ name: 't', version: '0' });
    registerTools(server, client, cfg);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    return { mcp, calls, names, cfg };
}

const text = (r: any) => r.content[0].text as string;
const body = (c: Call) => new URLSearchParams(c.body);

// ── Configuration et niveaux ────────────────────────────────────────────────
test('config : hôte nettoyé, port 2083, lecture seule par défaut', () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.host, 'example.o2switch.net');
    assert.equal(cfg.port, 2083);
    assert.equal(cfg.allowWrites, false);
    assert.equal(cfg.allowDestructive, false);
    assert.throws(() => loadConfig({}), /CPANEL_HOST, CPANEL_USER, CPANEL_TOKEN/);
});

test('suppression ignorée sans écriture', () => {
    assert.equal(loadConfig(baseEnv({ CPANEL_ALLOW_DESTRUCTIVE: '1' })).allowDestructive, false);
    assert.equal(loadConfig(baseEnv({ CPANEL_ALLOW_DESTRUCTIVE: '1', CPANEL_ALLOW_WRITES: '1' })).allowDestructive, true);
});

test('niveau 1 (défaut) : aucun outil d\'écriture ni de suppression', async () => {
    const { names } = await connect();
    assert.ok(names.includes('cpanel_list_domains') && names.includes('cpanel_dns_zone'));
    assert.ok(!names.some((n) => /create|write|add_|delete|trash|destructive|upload|set_|edit_|grant|run_/.test(n)), names.join(','));
});

test('niveau 2 : écriture sans aucune suppression', async () => {
    const { names } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    for (const n of ['cpanel_create_email', 'cpanel_create_database', 'cpanel_upload_file', 'cpanel_add_dns_record', 'cpanel_uapi_write']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /delete|trash|destructive|unregister/.test(n)), names.join(','));
});

test('niveau 3 : outils de suppression exposés et annotés destructifs', async () => {
    const { mcp, names } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1' });
    for (const n of ['cpanel_delete_email', 'cpanel_delete_database', 'cpanel_trash_file', 'cpanel_uapi_destructive']) assert.ok(names.includes(n), n);
    const t = (await mcp.listTools()).tools.find((x) => x.name === 'cpanel_delete_database')!;
    assert.equal(t.annotations?.destructiveHint, true);
    assert.match(t.description || '', /SUPPRESSION/);
});

// ── Lecture ─────────────────────────────────────────────────────────────────
test('UAPI : URL, en-tête et paramètres en POST', async () => {
    const { mcp, calls } = await connect();
    const r = await mcp.callTool({ name: 'cpanel_list_email_accounts', arguments: { domain: 'acme.fr' } });
    assert.match(text(r), /a@acme\.fr/);
    assert.equal(calls[0].url, 'https://example.o2switch.net:2083/execute/Email/list_pops_with_disk');
    assert.equal(calls[0].auth, `cpanel acme:${TOKEN}`);
    assert.equal(calls[0].body, 'domain=acme.fr');
});

test('DNS : zone décodée depuis base64', async () => {
    const { mcp } = await connect();
    const rows = JSON.parse(text(await mcp.callTool({ name: 'cpanel_dns_zone', arguments: { zone: 'acme.fr' } })));
    const a = rows.find((x: any) => x.type === 'A');
    assert.deepEqual([a.nom, a.valeur[0], a.ligne], ['www', '1.2.3.4', 7]);
});

test('le jeton n\'apparaît jamais dans une erreur', async () => {
    const { mcp } = await connect();
    const r: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Fail', function: 'get_x' } });
    assert.equal(r.isError, true);
    assert.ok(!text(r).includes(TOKEN));
});

test('lecture générique : écritures et modules sensibles refusés sans requête', async () => {
    const { mcp, calls } = await connect();
    const w: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Email', function: 'add_pop' } });
    const s: any = await mcp.callTool({ name: 'cpanel_uapi_read', arguments: { module: 'Tokens', function: 'list' } });
    assert.equal(w.isError, true);
    assert.equal(s.isError, true);
    assert.equal(calls.length, 0);
});

// ── Écriture ────────────────────────────────────────────────────────────────
test('écriture universelle : suppressions et modules sensibles refusés', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    for (const [module, fn] of [['Email', 'delete_pop'], ['Mysql', 'delete_database'], ['Tokens', 'create_full_access'], ['Passwd', 'change_password']]) {
        const r: any = await mcp.callTool({ name: 'cpanel_uapi_write', arguments: { module, function: fn } });
        assert.equal(r.isError, true, `${module}::${fn}`);
    }
    const t: any = await mcp.callTool({ name: 'cpanel_api2_write', arguments: { module: 'Fileman', function: 'fileop', params: { op: 'trash', sourcefiles: 'x' } } });
    assert.equal(t.isError, true);
    assert.equal(calls.length, 0);
});

test('création de boîte mail : bons paramètres', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    await mcp.callTool({ name: 'cpanel_create_email', arguments: { user: 'info', domain: 'acme.fr', password: 'Tr3s-Long-Secret!', quota_mb: 500 } });
    assert.ok(calls[0].url.endsWith('/execute/Email/add_pop'));
    const p = body(calls[0]);
    assert.deepEqual([p.get('email'), p.get('domain'), p.get('quota')], ['info', 'acme.fr', '500']);
});

test('DNS : ajout avec le serial SOA courant', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    await mcp.callTool({ name: 'cpanel_add_dns_record', arguments: { zone: 'acme.fr', name: 'test', type: 'TXT', values: ['hello'] } });
    const edit = calls.find((c) => c.url.endsWith('/execute/DNS/mass_edit_zone'))!;
    const p = body(edit);
    assert.equal(p.get('serial'), '2026112001');
    assert.deepEqual(JSON.parse(p.get('add')!), { dname: 'test', ttl: 14400, record_type: 'TXT', data: ['hello'] });
});

test('envoi de fichier : multipart, contenu décodé', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    await mcp.callTool({ name: 'cpanel_upload_file', arguments: { dir: 'public_html', file: 'a.bin', base64: Buffer.from('ABC').toString('base64') } });
    const form = calls[0].form!;
    assert.ok(calls[0].url.endsWith('/execute/Fileman/upload_files'));
    assert.equal(form.get('dir'), 'public_html');
    const f = form.get('file-1') as File;
    assert.equal(f.name, 'a.bin');
    assert.equal(await f.text(), 'ABC');
});

test('chemins : sortie du compte refusée', async () => {
    assert.equal(safeDir('public_html', 'acme'), 'public_html');
    assert.throws(() => safeDir('../etc', 'acme'));
    assert.throws(() => safeDir('/etc', 'acme'));
    assert.throws(() => safeDir('/home/acmeX/x', 'acme'));
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1' });
    const r: any = await mcp.callTool({ name: 'cpanel_file_operation', arguments: { op: 'copy', source: 'public_html/a', destination: '/etc/passwd' } });
    assert.equal(r.isError, true);
    assert.equal(calls.length, 0);
});

// ── Suppression ─────────────────────────────────────────────────────────────
test('suppression sans confirmation exacte : refusée, aucune requête', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1' });
    for (const confirm of ['', 'oui', 'acme_autre', 'ACME_SITE', 'acme']) {
        const r: any = await mcp.callTool({ name: 'cpanel_delete_database', arguments: { name: 'acme_site', confirm } });
        assert.equal(r.isError, true, `confirm=${JSON.stringify(confirm)}`);
    }
    assert.equal(calls.length, 0, 'aucune requête ne doit partir sans confirmation exacte');
    const okTrim: any = await mcp.callTool({ name: 'cpanel_delete_database', arguments: { name: 'acme_site', confirm: ' acme_site ' } });
    assert.ok(!okTrim.isError, 'espaces de bord tolérés');
    assert.equal(calls.length, 1);
});

test('suppression confirmée : requête envoyée', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1' });
    const r: any = await mcp.callTool({ name: 'cpanel_delete_email', arguments: { address: 'old@acme.fr', confirm: 'old@acme.fr' } });
    assert.ok(!r.isError, text(r));
    assert.ok(calls[0].url.endsWith('/execute/Email/delete_pop'));
    assert.deepEqual([body(calls[0]).get('email'), body(calls[0]).get('domain')], ['old', 'acme.fr']);
});

test('corbeille : dossiers racines du compte refusés même confirmés', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1' });
    for (const p of ['public_html', '/home/acme', '/home/acme/public_html/']) {
        const r: any = await mcp.callTool({ name: 'cpanel_trash_file', arguments: { path: p, confirm: p } });
        assert.equal(r.isError, true, p);
    }
    assert.equal(calls.length, 0);
    const ok2: any = await mcp.callTool({ name: 'cpanel_trash_file', arguments: { path: 'public_html/vieux', confirm: 'public_html/vieux' } });
    assert.ok(!ok2.isError, text(ok2));
    assert.equal(body(calls[0]).get('cpanel_jsonapi_func'), 'fileop');
    assert.equal(body(calls[0]).get('op'), 'trash');
});

test('suppression universelle : confirm = Module::fonction, modules sensibles bloqués', async () => {
    const { mcp, calls } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1' });
    const bad: any = await mcp.callTool({ name: 'cpanel_uapi_destructive', arguments: { module: 'Email', function: 'delete_pop', confirm: 'oui' } });
    const tok: any = await mcp.callTool({ name: 'cpanel_uapi_destructive', arguments: { module: 'Tokens', function: 'revoke', confirm: 'Tokens::revoke' } });
    assert.equal(bad.isError, true);
    assert.equal(tok.isError, true);
    assert.equal(calls.length, 0);
    const good: any = await mcp.callTool({ name: 'cpanel_uapi_destructive', arguments: { module: 'Email', function: 'delete_pop', params: { email: 'x', domain: 'acme.fr' }, confirm: 'Email::delete_pop' } });
    assert.ok(!good.isError);
});

// ── Journal ─────────────────────────────────────────────────────────────────
test('journal : écritures et suppressions consignées, secrets masqués, lectures non consignées', async () => {
    const file = tmpJournal();
    const { mcp } = await connect({ CPANEL_ALLOW_WRITES: '1', CPANEL_ALLOW_DESTRUCTIVE: '1', CPANEL_JOURNAL: file });
    await mcp.callTool({ name: 'cpanel_list_domains', arguments: {} });
    await mcp.callTool({ name: 'cpanel_create_email', arguments: { user: 'info', domain: 'acme.fr', password: 'Tr3s-Long-Secret!', quota_mb: 1 } });
    await mcp.callTool({ name: 'cpanel_delete_database', arguments: { name: 'acme_x', confirm: 'non' } });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].tool, 'cpanel_create_email');
    assert.equal(lines[0].level, 'write');
    assert.equal(lines[0].ok, true);
    assert.match(lines[0].args.password, /^\*\*\*\(\d+ car\.\)$/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('Tr3s-Long-Secret!'));
    assert.equal(lines[1].level, 'destructive');
    assert.equal(lines[1].ok, false);
    assert.equal(lines[0].account, 'acme@example.o2switch.net');
});

test('401 : message clair, sans jeton', async () => {
    const client = new CpanelClient(loadConfig(baseEnv()), fakeFetch([]));
    await assert.rejects(client.uapi('Unauthorized', 'get_x'), (e: Error) => /Authentification refusée/.test(e.message) && !e.message.includes(TOKEN));
});
