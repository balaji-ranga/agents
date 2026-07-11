/**
 * MCP integration smoke test — connect + call get_available_symbols on Aarna.
 * Run: node backend/scripts/test-mcp-aarna.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import { connectMcpServer, callMcpServerTool, getMcpServer } from '../src/services/mcp-servers.js';

initDb();
const db = getDb();
const MCP_ID = 'mcp-aarna-crypto';

const admin = db.prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
if (!admin) {
  console.error('No admin user');
  process.exit(1);
}
const authUser = { id: admin.id, role: admin.role };

let server = getMcpServer(MCP_ID, authUser);
if (!server) {
  console.error('Run: node backend/scripts/seed-aarna-mcp.js first');
  process.exit(1);
}

console.log('Connecting...');
await connectMcpServer(MCP_ID, authUser);

console.log('Calling get_available_symbols...');
const out = await callMcpServerTool(MCP_ID, 'get_available_symbols', {}, authUser);
console.log('Text preview:', out.text?.slice(0, 300));
console.log('Latency ms:', out.latency_ms);
console.log('OK');
