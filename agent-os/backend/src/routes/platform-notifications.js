import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listNotificationsForUser } from '../services/platform-notifications.js';

const router = Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  try {
    const limit = req.query.limit;
    const notifications = listNotificationsForUser(req.authUser.id, { limit });
    res.json({ notifications });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
