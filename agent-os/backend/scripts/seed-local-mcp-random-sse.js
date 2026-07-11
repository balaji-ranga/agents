/**
 * Seed local MCP random SSE server into registry.
 * Run local server first: node tools/local-mcp-random-sse/server.js
 * Then: node backend/scripts/seed-local-mcp-random-sse.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import { connectMcpServer, createMcpServer, getMcpServer } from '../src/services/mcp-servers.js';

initDb();
const db = getDb();

const MCP_ID = 'mcp-local-random-sse';
const URL = process.env.MCP_RANDOM_URL || 'http://127.0.0.1:3099/mcp';

const admin = db.prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
if (!admin) {
  console.error('No admin user');
  process.exit(1);
}
const authUser = { id: admin.id, role: admin.role };

let server = getMcpServer(MCP_ID, authUser);
if (!server) {
  server = createMcpServer(authUser, {
    id: MCP_ID,
    name: 'Local Random SSE (test)',
    description: 'Generates random numbers and SSE random_number events for workflow testing',
    url: URL,
    transport: 'sse',
  });
  console.log('Created MCP:', server.id);
} else {
  console.log('MCP already exists:', server.id);
}

console.log('Connecting to', URL, '...');
const result = await connectMcpServer(MCP_ID, authUser);
console.log('Status:', result.status);
console.log('Tools:', result.tools?.map((t) => t.name).join(', '));
console.log('Events stream: http://127.0.0.1:3099/events/stream');
