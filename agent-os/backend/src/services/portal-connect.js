/**
 * Portal login registry + profile portal_auth for Connect Portals flow.
 */
import { warmupManagedBrowser, getBrowserAuthStatus, markPortalLoggedIn } from './job-browser-auth.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { getDbForCeo } from '../db/request-db.js';
import {
  buildDiscoverySearchUrls,
  formatDiscoverySearchUrlsForPrompt,
  DEFAULT_PORTAL_SEARCH_PATTERNS,
} from './job-portal-search-urls.js';
import {
  PORTAL_REGISTRY,
  normalizePortalKey,
  portalInfo,
  portalsFromProfileSources,
} from './portal-registry.js';

export {
  buildDiscoverySearchUrls,
  formatDiscoverySearchUrlsForPrompt,
  DEFAULT_PORTAL_SEARCH_PATTERNS,
  PORTAL_REGISTRY,
  normalizePortalKey,
  portalInfo,
  portalsFromProfileSources,
};

export function getProfilePortalAuth(intake = {}) {
  return intake.portal_auth && typeof intake.portal_auth === 'object' ? { ...intake.portal_auth } : {};
}

export function mergePortalAuth(intake, portalKey, patch) {
  const auth = getProfilePortalAuth(intake);
  auth[portalKey] = { ...(auth[portalKey] || {}), ...patch, updated_at: new Date().toISOString() };
  return auth;
}

export async function connectPortalsForProfile(ceoUserId, profileId, opts = {}) {
  const dbFn = () => getDbForCeo(ceoUserId);
  const profileSvc = createJobSearchProfileService(dbFn);
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id || profile.status === 'none') throw new Error(`Profile not found: ${profileId}`);

  const intake = profile.intake || {};
  const portals = opts.portals?.length
    ? opts.portals.map((p) => portalInfo(p))
    : portalsFromProfileSources(intake.sources || []);

  if (portals.length === 0) throw new Error('No sources/portals configured on profile');

  let browser = null;
  if (opts.warmup !== false) {
    try {
      await warmupManagedBrowser();
      browser = { ok: true };
    } catch (e) {
      browser = { ok: false, error: e.message };
    }
  }

  const globalAuth = getBrowserAuthStatus();
  let portalAuth = getProfilePortalAuth(intake);

  for (const p of portals) {
    const sessionOk =
      p.key.includes('linkedin') && globalAuth.linkedin_logged_in
        ? true
        : p.key.includes('jobstreet') && globalAuth.jobstreet_logged_in
          ? true
          : Boolean(portalAuth[p.key]?.session_ok);

    portalAuth = mergePortalAuth({ portal_auth: portalAuth }, p.key, {
      label: p.label,
      login_url: p.login_url,
      requires_login: p.requires_login,
      session_ok: sessionOk,
      connect_status: sessionOk ? 'connected' : 'login_required',
    });
  }

  const saved = profileSvc.savePatch(ceoUserId, profileId, {
    portal_auth: portalAuth,
    browser_session_ok: Object.values(portalAuth).some((v) => v?.session_ok) || intake.browser_session_ok,
  });

  return {
    ok: true,
    profile_id: profileId,
    ceo_user_id: ceoUserId,
    portals: portals.map((p) => ({
      key: p.key,
      label: p.label,
      login_url: p.login_url,
      requires_login: p.requires_login,
      session_ok: portalAuth[p.key]?.session_ok || false,
      connect_status: portalAuth[p.key]?.connect_status || 'login_required',
    })),
    browser,
    global_browser_auth: globalAuth,
    login_script: 'node scripts/openclaw-browser-login.js',
    manual_steps: [
      'Run: node scripts/openclaw-browser-login.js from agent-os folder',
      'Log in to each portal in the OpenClaw Playwright Chromium window',
      'Press Enter in the terminal when done',
      'Call POST .../connect-portals again or mark-logged-in to refresh status',
    ],
    profile: saved,
  };
}

export function markProfilePortalsLoggedIn(ceoUserId, profileId, { linkedin, jobstreet, portal_keys = [] } = {}) {
  markPortalLoggedIn({ linkedin, jobstreet, notes: `profile ${profileId}` });

  const dbFn = () => getDbForCeo(ceoUserId);
  const profileSvc = createJobSearchProfileService(dbFn);
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id) throw new Error('Profile not found');

  let portalAuth = getProfilePortalAuth(profile.intake || {});
  const keys = portal_keys.length ? portal_keys : Object.keys(portalAuth);
  for (const key of keys) {
    const isLinkedin = key.includes('linkedin');
    const isJobstreet = key.includes('jobstreet');
    const ok =
      (isLinkedin && linkedin) ||
      (isJobstreet && jobstreet) ||
      (isLinkedin && linkedin == null && portalAuth[key]) ||
      false;
    if (isLinkedin && linkedin != null) {
      portalAuth = mergePortalAuth({ portal_auth: portalAuth }, key, {
        session_ok: !!linkedin,
        connect_status: linkedin ? 'connected' : 'login_required',
      });
    } else if (isJobstreet && jobstreet != null) {
      portalAuth = mergePortalAuth({ portal_auth: portalAuth }, key, {
        session_ok: !!jobstreet,
        connect_status: jobstreet ? 'connected' : 'login_required',
      });
    }
  }

  return profileSvc.savePatch(ceoUserId, profileId, {
    portal_auth: portalAuth,
    browser_session_ok: true,
    linkedin_session_ok: linkedin ?? profile.intake?.linkedin_session_ok,
    jobstreet_session_ok: jobstreet ?? profile.intake?.jobstreet_session_ok,
  });
}
