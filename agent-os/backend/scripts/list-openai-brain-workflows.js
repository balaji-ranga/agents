/**
 * List workflows with Brain nodes using OpenAI endpoint + inline API key.
 * Usage: node scripts/list-openai-brain-workflows.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import Database from 'better-sqlite3';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseGraph(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function isOpenAiBrainWithKey(node) {
  if (node?.type !== 'brain') return false;
  const cfg = node.data?.taskConfig || node.data?.config || {};
  const source = String(cfg.modelSource || cfg.model_source || '').toLowerCase();
  const endpoint = String(cfg.apiEndpoint || cfg.api_endpoint || '').toLowerCase();
  const hasKey = !!(cfg.apiKey || cfg.api_key);
  const isOpenAi =
    source === 'openai' || endpoint.includes('api.openai.com') || endpoint.includes('openai.com/v1');
  return isOpenAi && hasKey;
}

function scanWorkflows(rows, dbLabel) {
  const hits = [];
  for (const row of rows) {
    for (const [graphField, graphType] of [
      ['draft_graph_json', 'draft'],
      ['published_graph_json', 'published'],
    ]) {
      const g = parseGraph(row[graphField]);
      if (!g?.nodes) continue;
      const brainNodes = g.nodes.filter(isOpenAiBrainWithKey);
      if (!brainNodes.length) continue;
      hits.push({
        db: dbLabel,
        workflow_id: row.id,
        name: row.name,
        owner_user_id: row.owner_user_id,
        status: row.status,
        graph: graphType,
        brain_nodes: brainNodes.map((n) => ({
          id: n.id,
          label: n.data?.label,
          modelSource: n.data?.taskConfig?.modelSource,
          apiEndpoint: n.data?.taskConfig?.apiEndpoint,
          model: n.data?.taskConfig?.model,
          hasApiKey: !!(n.data?.taskConfig?.apiKey),
        })),
      });
    }
  }
  return hits;
}

initDb();
const db = getDb();

const ceos = db
  .prepare(`SELECT id, name, email, ceo_db_mode FROM platform_users WHERE role = 'ceo'`)
  .all();

const all = [];
const sharedRows = db
  .prepare(
    `SELECT id, name, owner_user_id, status, draft_graph_json, published_graph_json FROM agent_workflow_definitions`
  )
  .all();
all.push(...scanWorkflows(sharedRows, 'shared:agent-os.db'));

const dataDir = join(__dirname, '../data/tenants');
if (existsSync(dataDir)) {
  for (const tenantId of readdirSync(dataDir)) {
    const ceoDbPath = join(dataDir, tenantId, 'ceo.db');
    if (!existsSync(ceoDbPath)) continue;
    const tdb = new Database(ceoDbPath, { readonly: true });
    const hasTable = tdb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_workflow_definitions'`)
      .get();
    if (!hasTable) {
      tdb.close();
      continue;
    }
    const rows = tdb
      .prepare(
        `SELECT id, name, owner_user_id, status, draft_graph_json, published_graph_json FROM agent_workflow_definitions`
      )
      .all();
    all.push(...scanWorkflows(rows, `tenant:${tenantId}`));
    tdb.close();
  }
}

const seen = new Set();
const workflows = [];
for (const h of all) {
  const k = `${h.db}|${h.workflow_id}|${h.graph}`;
  if (seen.has(k)) continue;
  seen.add(k);
  workflows.push(h);
}

console.log(JSON.stringify({ ceo_count: ceos.length, ceos, workflows }, null, 2));

// Also report OpenAI brain nodes (inline key OR env fallback)
const openAiBrains = [];
for (const row of sharedRows) {
  for (const [graphField, graphType] of [
    ['draft_graph_json', 'draft'],
    ['published_graph_json', 'published'],
  ]) {
    const g = parseGraph(row[graphField]);
    if (!g?.nodes) continue;
    for (const n of g.nodes) {
      if (n.type !== 'brain') continue;
      const cfg = n.data?.taskConfig || {};
      const source = String(cfg.modelSource || '').toLowerCase();
      const endpoint = String(cfg.apiEndpoint || '').toLowerCase();
      const isOpenAi =
        source === 'openai' || endpoint.includes('api.openai.com') || endpoint.includes('openai.com');
      if (!isOpenAi) continue;
      openAiBrains.push({
        ceo_id: row.owner_user_id,
        ceo_name: ceos.find((c) => c.id === row.owner_user_id)?.name || row.owner_user_id,
        workflow_id: row.id,
        workflow_name: row.name,
        status: row.status,
        graph: graphType,
        brain_node: n.id,
        brain_label: n.data?.label,
        modelSource: cfg.modelSource,
        apiEndpoint: cfg.apiEndpoint || 'https://api.openai.com/v1 (default)',
        model: cfg.model || 'gpt-4o-mini (default)',
        inline_api_key: !!(cfg.apiKey || cfg.api_key),
        key_source: cfg.apiKey || cfg.api_key ? 'node config' : 'missing (required — no .env fallback)',
      });
    }
  }
}

if (openAiBrains.length) {
  console.log('\n--- OpenAI Brain workflows (all) ---');
  console.log(JSON.stringify(openAiBrains, null, 2));
}

