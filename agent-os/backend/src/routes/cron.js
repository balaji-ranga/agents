import { Router } from 'express';
import { runScheduledStandup } from '../cron/standup.js';
import { processPendingDelegationTasks } from '../services/delegation-queue.js';

const router = Router();

/** Manual trigger for standup flow (collect from agents + run COO). */
router.post('/run-standup', async (req, res) => {
  try {
    const { standup, error } = await runScheduledStandup();
    if (error) {
      return res.status(502).json({ ok: false, error, standup: standup || null });
    }
    res.json({ ok: true, standup });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Process pending COO→agent delegations and post response callbacks to standup. (Also runs on schedule.) */
router.post('/process-delegations', async (req, res) => {
  try {
    await processPendingDelegationTasks();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
