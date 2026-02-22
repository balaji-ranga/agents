import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env from backend folder so OPENAI_API_KEY etc. are set regardless of cwd
config({ path: join(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import workspaceRoutes from './routes/workspace.js';
import agentsRoutes from './routes/agents.js';
import standupsRoutes from './routes/standups.js';
import cronRoutes from './routes/cron.js';
import { initDb } from './db/schema.js';
import { seedDefaultAgentsIfEmpty } from './db/seed-default-agents.js';
import { runScheduledStandup } from './cron/standup.js';
import { processPendingDelegationTasks } from './services/delegation-queue.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.text({ type: 'text/*' }));

initDb();
seedDefaultAgentsIfEmpty();

const healthHandler = (req, res) => {
  res.json({ status: 'ok', service: 'agent-os-backend', timestamp: new Date().toISOString() });
};
app.get('/health', healthHandler);

// Single /api router so all /api/* routes are registered in one place
const apiRouter = express.Router();
apiRouter.get('/health', healthHandler);
apiRouter.use('/workspace', workspaceRoutes);
apiRouter.use('/agents', agentsRoutes);
apiRouter.use('/standups', standupsRoutes);
apiRouter.use('/cron', cronRoutes);
app.use('/api', apiRouter);

// Also mount at root for VITE_API_URL without /api (e.g. http://127.0.0.1:3001)
app.use('/workspace', workspaceRoutes);
app.use('/agents', agentsRoutes);
app.use('/standups', standupsRoutes);
app.use('/cron', cronRoutes);

const standupSchedule = process.env.STANDUP_CRON_SCHEDULE || '0 9 * * *';
if (cron.validate(standupSchedule)) {
  cron.schedule(standupSchedule, async () => {
    try {
      const { standup, error } = await runScheduledStandup();
      if (error) console.error('[cron] Standup run error:', error);
      else console.log('[cron] Standup completed, id:', standup?.id);
    } catch (e) {
      console.error('[cron] Standup failed:', e.message);
    }
  });
  console.log(`Standup cron scheduled: ${standupSchedule}`);
} else {
  console.warn('STANDUP_CRON_SCHEDULE invalid or not set; no automatic standup.');
}

const delegationCronSchedule = process.env.DELEGATION_CRON_SCHEDULE || '* * * * *';
if (cron.validate(delegationCronSchedule)) {
  cron.schedule(delegationCronSchedule, async () => {
    try {
      await processPendingDelegationTasks();
    } catch (e) {
      console.error('[cron] Delegation process error:', e.message);
    }
  });
  console.log('Delegation cron scheduled (COO→agents):', delegationCronSchedule);
}

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Agent OS backend listening on http://127.0.0.1:${PORT}`);
});
