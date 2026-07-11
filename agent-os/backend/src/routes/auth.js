import { Router } from 'express';
import { createSession, getSessionRow, revokeSession } from '../services/auth/session.js';
import {
  authenticateUser,
  registerCeoUser,
  getUserById,
  listAgentsForUser,
  updateUserProfile,
} from '../services/users.js';
import { resolveCeoDataUserId, getBalaCeoAuthId } from '../services/job-applicant-ceo.js';
import { getCeoDbModeForUser, usesTenantCeoDb } from '../db/ceo-db-config.js';
import { attachAuthUser, requireAuth, logout } from '../middleware/auth.js';

const router = Router();

router.use(attachAuthUser);

router.post('/register', (req, res) => {
  try {
    const { email, password, name, region, mobile, db_mode, ceo_db_mode } = req.body || {};
    const user = registerCeoUser({ email, password, name, region, mobile, db_mode, ceo_db_mode });
    const session = createSession(user.id);
    res.status(201).json({ user, session, message: 'CEO account created. Standard workspace agents granted.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = authenticateUser(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.role !== 'ceo') return res.status(403).json({ error: 'Use admin login for admin accounts' });
    const session = createSession(user.id);
    res.json({ user, session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/admin/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = authenticateUser(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    const session = createSession(user.id);
    res.json({ user, session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  logout(req, res);
});

router.post('/exit-impersonation', requireAuth, (req, res) => {
  try {
    const row = getSessionRow(req.sessionToken);
    if (!row?.impersonator_user_id) {
      return res.status(400).json({ error: 'Not viewing as another user' });
    }
    revokeSession(req.sessionToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  try {
    const user = getUserById(req.authUser.id);
    const payload = {
      user: req.authUser.impersonation ? { ...user, impersonation: req.authUser.impersonation } : user,
      agents: req.authUser.role === 'ceo' ? listAgentsForUser(req.authUser.id) : [],
      data_ceo_user_id: req.authUser.role === 'ceo' ? resolveCeoDataUserId(req.authUser.id) : null,
      ceo_db_mode: req.authUser.role === 'ceo' ? getCeoDbModeForUser(req.authUser.id) : null,
      uses_shared_db: req.authUser.role === 'ceo' ? !usesTenantCeoDb(req.authUser.id) : null,
      uses_platform_db: req.authUser.role === 'ceo' && req.authUser.id === getBalaCeoAuthId(),
    };
    if (req.authUser.impersonation) {
      payload.impersonation = req.authUser.impersonation;
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/me', requireAuth, (req, res) => {
  try {
    const { name, email, region, mobile, current_password, new_password } = req.body || {};
    const user = updateUserProfile(req.authUser.id, {
      name,
      email,
      region,
      mobile,
      current_password,
      new_password,
    });
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
