/**
 * Clear all schedule-related data: standups, standup messages/responses, delegation tasks and callbacks.
 * Run from backend: node scripts/clear-schedules.js
 */
import { getDb } from '../src/db/schema.js';

const db = getDb();

db.exec('DELETE FROM delegation_callbacks');
db.exec('DELETE FROM agent_delegation_tasks');
db.exec('DELETE FROM standup_messages');
db.exec('DELETE FROM standup_responses');
db.exec('DELETE FROM standups');

console.log('Cleared: standups, standup_messages, standup_responses, agent_delegation_tasks, delegation_callbacks.');
