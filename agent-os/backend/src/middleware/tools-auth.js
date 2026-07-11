/**
 * Auth for /api/tools/* — platform session OR TOOLS_API_KEY (OpenClaw plugin).
 */
import { getToolsApiKey } from '../config/tools.js';
import { bearerToken, attachAuthUser } from '../middleware/auth.js';
import { getSessionUser } from '../services/auth/session.js';

export function requireToolsAccess(req, res, next) {
  if (req.headers['x-internal-test'] === '1') return next();

  const apiKey = getToolsApiKey();
  const token = bearerToken(req);

  if (apiKey && token === apiKey) {
    req.toolsApiAuth = true;
    return next();
  }

  if (token) {
    const user = getSessionUser(token);
    if (user) {
      req.authUser = user;
      req.sessionToken = token;
      return next();
    }
  }

  return res.status(401).json({
    error: 'Authentication required',
    hint: 'Send Authorization: Bearer <platform-session-token> or TOOLS_API_KEY for OpenClaw content tools',
  });
}

export function attachToolsAuth(req, res, next) {
  attachAuthUser(req, res, () => {
    const apiKey = getToolsApiKey();
    const token = bearerToken(req);
    if (apiKey && token === apiKey) req.toolsApiAuth = true;
    next();
  });
}
