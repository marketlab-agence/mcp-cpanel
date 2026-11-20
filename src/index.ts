#!/usr/bin/env node
/**
 * mcp-cpanel — serveur MCP local (stdio) pour gérer un compte cPanel (o2switch ou autre).
 *
 * Le jeton reste sur votre machine : aucun service tiers, appels directs à l'UAPI de votre hébergeur.
 * Lecture seule par défaut ; outils d'écriture seulement avec CPANEL_ALLOW_WRITES=1 ; aucune suppression.
 *
 * IMPORTANT : en stdio, stdout est réservé au protocole MCP. Tout log passe par stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CpanelClient } from './cpanel.js';
import { registerTools } from './tools.js';

async function main() {
    const cfg = loadConfig();
    const client = new CpanelClient(cfg);
    const server = new McpServer({ name: 'mcp-cpanel', version: '0.2.0' });
    const tools = registerTools(server, client, cfg);
    await server.connect(new StdioServerTransport());
    const level = cfg.allowDestructive ? 'lecture + écriture + SUPPRESSION' : cfg.allowWrites ? 'lecture + écriture' : 'lecture seule';
    console.error(`[mcp-cpanel] ${cfg.user}@${cfg.host}:${cfg.port} — ${tools.length} outils (${level})${cfg.journalPath ? ` — journal : ${cfg.journalPath}` : ''}`);
    if (process.env.CPANEL_ALLOW_DESTRUCTIVE && !cfg.allowWrites) {
        console.error('[mcp-cpanel] CPANEL_ALLOW_DESTRUCTIVE ignoré : il exige aussi CPANEL_ALLOW_WRITES=1.');
    }
}

main().catch((err) => {
    console.error(`[mcp-cpanel] démarrage impossible : ${err?.message || err}`);
    process.exit(1);
});
