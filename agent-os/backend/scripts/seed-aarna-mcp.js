/**
 * Seed platform MCP: Aarna crypto technical features.
 * Run: node backend/scripts/seed-aarna-mcp.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import { connectMcpServer, createMcpServer, getMcpServer } from '../src/services/mcp-servers.js';

initDb();
const db = getDb();

const MCP_ID = 'mcp-aarna-crypto';
const URL = 'https://mcp.aarna.ai/mcp';

const admin = db.prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
if (!admin) {
  console.error('No admin user found — run backend first to seed admin.');
  process.exit(1);
}

const authUser = { id: admin.id, role: admin.role };

let server = getMcpServer(MCP_ID, authUser);
if (!server) {
  server = createMcpServer(authUser, {
    id: MCP_ID,
    name: 'Aarna Crypto Technical Features',
    description: 'Crypto OHLCV indicators and daily sentiment scores (BTC, ETH, SOL, etc.)',
    url: URL,
    transport: 'streamable_http',
  });
  console.log('Created MCP:', server.id);
} else {
  console.log('MCP already exists:', server.id);
}

console.log('Connecting to', URL, '...');
const result = await connectMcpServer(MCP_ID, authUser);
console.log('Status:', result.status);
console.log('Tools:', result.tools?.length);
console.log('Server:', result.server_info?.name, result.server_info?.version);
console.log('Sample tools:', result.tools?.slice(0, 5).map((t) => t.name).join(', '));
