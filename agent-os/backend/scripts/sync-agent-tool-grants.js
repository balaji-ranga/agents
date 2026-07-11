/**
 * One-shot: import grants from openclaw.json → DB → agent-tool-allowlists.json
 * Run: node scripts/sync-agent-tool-grants.js
 */
import { initDb } from '../src/db/schema.js';
import { importGrantsFromOpenClawConfig, syncAllowlistsFile, readAllowlistsFile } from '../src/services/openclaw-agent-tools.js';

initDb();
const imported = importGrantsFromOpenClawConfig();
syncAllowlistsFile();
console.log('Imported grant rows:', imported);
console.log('Allowlists:', JSON.stringify(readAllowlistsFile(), null, 2));
