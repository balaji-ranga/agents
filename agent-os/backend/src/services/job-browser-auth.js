/**
 * Browser auth status for LinkedIn / JobStreet (OpenClaw managed Playwright profile).
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildDiscoverySearchUrls } from './job-portal-search-urls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..', '..', '..');

function openclawDir() {
  return process.env.OPENCLAW_DIR || join(homedir(), '.openclaw');
}

function storageStatePath() {
  return join(openclawDir(), 'browser', 'openclaw', 'storage-state.json');
}

function persistentProfileDir() {
  return join(openclawDir(), 'browser', 'openclaw', 'user-data');
}

/** OpenClaw stores cookies in Chromium user-data (not storage-state.json). */
function hasPersistentBrowserProfile() {
  const base = persistentProfileDir();
  return existsSync(base) && existsSync(join(base, 'Default'));
}

function sessionMarkedReady(meta = readAuthMeta()) {
  return Boolean(meta.linkedin_logged_in || meta.jobstreet_logged_in);
}

function authMetaPath() {
  return join(openclawDir(), 'browser', 'openclaw', 'portal-auth-meta.json');
}

function readAuthMeta() {
  const p = authMetaPath();
  if (!existsSync(p)) {
    return {
      linkedin_logged_in: false,
      jobstreet_logged_in: false,
      last_login_at: null,
      notes: '',
    };
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { linkedin_logged_in: false, jobstreet_logged_in: false };
  }
}

function writeAuthMeta(patch) {
  const dir = join(openclawDir(), 'browser', 'openclaw');
  mkdirSync(dir, { recursive: true });
  const next = { ...readAuthMeta(), ...patch, updated_at: new Date().toISOString() };
  writeFileSync(authMetaPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function getBrowserAuthStatus() {
  const storageExists = existsSync(storageStatePath());
  const persistentProfile = hasPersistentBrowserProfile();
  const meta = readAuthMeta();
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
  const sessionReady = persistentProfile && sessionMarkedReady(meta);
  return {
    playwright_profile: 'openclaw',
    persistent_profile_path: persistentProfileDir(),
    persistent_profile_exists: persistentProfile,
    storage_state_path: storageStatePath(),
    storage_state_exists: storageExists,
    /** Legacy alias — true when Chromium user-data profile exists (OpenClaw default). */
    session_saved: persistentProfile || storageExists,
    session_ready: sessionReady,
    linkedin_logged_in: Boolean(meta.linkedin_logged_in),
    jobstreet_logged_in: Boolean(meta.jobstreet_logged_in),
    last_login_at: meta.last_login_at || null,
    login_script: 'node scripts/openclaw-browser-login.js',
    manual_steps: [
      'Job Profiles → Connect portals → Open login browser',
      'Log in to LinkedIn and JobStreet in the OpenClaw Chromium window',
      'Click Save & connect (stores cookies in the persistent browser profile)',
    ],
    warmup: `node scripts/warmup-openclaw-browser.js`,
    gateway_url: gatewayUrl,
  };
}

export function markPortalLoggedIn({ linkedin = null, jobstreet = null, notes = '' } = {}) {
  const patch = { last_login_at: new Date().toISOString() };
  if (linkedin != null) patch.linkedin_logged_in = Boolean(linkedin);
  if (jobstreet != null) patch.jobstreet_logged_in = Boolean(jobstreet);
  if (notes) patch.notes = notes;
  return writeAuthMeta(patch);
}

function gatewayConfig() {
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
  let token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const cfgPath = join(openclawDir(), 'openclaw.json');
  if (!token && existsSync(cfgPath)) {
    try {
      token = JSON.parse(readFileSync(cfgPath, 'utf8'))?.gateway?.auth?.token || '';
    } catch (_) {}
  }
  return { gatewayUrl, token };
}

export async function isGatewayReachable(timeoutMs = 8000) {
  const { gatewayUrl } = gatewayConfig();
  const probes = [
    { path: '/health', method: 'GET' },
    { path: '/v1/chat/completions', method: 'OPTIONS' },
  ];
  for (const { path, method } of probes) {
    try {
      const res = await fetch(`${gatewayUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok || res.status < 500) return true;
    } catch (_) {
      /* try next probe */
    }
  }
  return false;
}

async function invokeBrowserAction(action, agentId = 'jobdiscovery', extraArgs = {}) {
  const { gatewayUrl, token } = gatewayConfig();
  const res = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': agentId,
    },
    body: JSON.stringify({ tool: 'browser', args: { action, profile: 'openclaw', ...extraArgs } }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

export { invokeBrowserAction, invokeBrowserOpen, parseInvokeText, sleep };

/** Dedupe concurrent browser starts within a short TTL (avoids cyclic Chrome launch). */
let _browserReadyPromise = null;
let _browserReadyAt = 0;
const BROWSER_READY_TTL_MS = Number(process.env.BROWSER_READY_TTL_MS || 120000);

async function invokeBrowserOpen(url, agentId = 'jobdiscovery') {
  return invokeBrowserAction('open', agentId, { url, targetUrl: url });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseInvokeText(result) {
  if (!result?.text) return '';
  try {
    const outer = JSON.parse(result.text);
    const inner = outer?.result?.content?.[0]?.text ?? outer?.content?.[0]?.text;
    if (typeof inner === 'string') return inner;
  } catch (_) {}
  return result.text;
}

const LOGIN_WALL_RE =
  /sign in to view|join linkedin|authwall|login to view|log in to continue|create an account|sign in to see|please sign in|login required/i;
const JOB_SIGNAL_RE =
  /jobs? in |view job|job listing|full-time|part-time|apply now|job card|linkedin\.com\/jobs\/view|jobstreet\.com/i;

/**
 * Graceful browser stop/start — cookies live in user-data and persist across restarts.
 */
export async function persistBrowserSession() {
  await invokeBrowserAction('stop').catch(() => {});
  await sleep(1500);
  await invokeBrowserAction('start');
  const auth = getBrowserAuthStatus();
  return {
    persistent_profile_exists: auth.persistent_profile_exists,
    storage_state_exists: auth.storage_state_exists,
    session_saved: auth.session_saved,
  };
}

/**
 * Open pre-filtered search URLs and detect login walls vs job listings.
 */
export async function probeDiscoveryPortals(intake = {}) {
  const built = buildDiscoverySearchUrls(intake);
  const bySource = new Map();
  for (const entry of built) {
    if (!bySource.has(entry.source)) bySource.set(entry.source, entry);
  }
  const urls = [...bySource.values()].map((entry) => ({
    source: entry.source,
    url: entry.url,
  }));
  if (!urls.length) return [];

  await ensureManagedBrowserReady({ restartOnFailure: false });
  const results = [];

  for (const entry of urls) {
    await invokeBrowserOpen(entry.url);
    await sleep(2500);
    const snap = await invokeBrowserAction('snapshot', 'jobdiscovery', { limit: 4000 });
    const text = parseInvokeText(snap).toLowerCase();
    const hasJobs = JOB_SIGNAL_RE.test(text);
    const loginWall = LOGIN_WALL_RE.test(text) && !hasJobs;
    results.push({
      source: entry.source,
      url: entry.url,
      login_wall: loginWall,
      has_job_signals: hasJobs,
      ok: hasJobs || (!loginWall && /jobs\/search|jobstreet\.com\/[^/]+-jobs\/in-/i.test(entry.url)),
    });
  }

  return results;
}

export class PortalLoginRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PortalLoginRequiredError';
    this.login_required = true;
    this.details = details;
  }
}

/**
 * Require saved session + live portal access before discovery runs.
 */
export async function assertDiscoveryBrowserReady(intake = {}) {
  const auth = getBrowserAuthStatus();
  if (auth.persistent_profile_exists || auth.session_ready) {
    return { ok: true, auth, probes: [], verified: 'saved_profile' };
  }

  await ensureManagedBrowserReady({ restartOnFailure: false });
  const authLive = getBrowserAuthStatus();

  const probes = await probeDiscoveryPortals(intake);
  const anyOk = probes.some((p) => p.ok);
  if (anyOk) {
    return { ok: true, auth: authLive, probes, verified: 'live_probe' };
  }

  if (authLive.session_ready) {
    return { ok: true, auth: authLive, probes, verified: 'marked_session' };
  }

  if (!authLive.persistent_profile_exists) {
    throw new PortalLoginRequiredError(
      'No OpenClaw browser profile yet. Job Profiles → Connect portals → Open login browser → log in → Save & connect.',
      { auth: authLive, probes }
    );
  }

  const blocked = probes.filter((p) => !p.ok);
  if (blocked.length > 0) {
    if (authLive.persistent_profile_exists || authLive.session_ready) {
      console.warn(
        `[browser-auth] live probe blocked (${blocked.map((b) => b.source).join(', ')}) — continuing with saved browser profile`
      );
      return { ok: true, auth: authLive, probes, verified: 'saved_profile_probe_blocked' };
    }
    throw new PortalLoginRequiredError(
      `Portal login required (${blocked.map((b) => b.source).join(', ')}). Open login browser, sign in, then Save & connect.`,
      { auth: authLive, probes }
    );
  }

  return { ok: true, auth: authLive, probes };
}

export async function completeBrowserLogin({ linkedin = true, jobstreet = true, intake = null, verify = true } = {}) {
  const persisted = await persistBrowserSession();
  const meta = markPortalLoggedIn({
    linkedin,
    jobstreet,
    notes: 'completeBrowserLogin',
  });
  let probes = [];
  if (verify) {
    probes = await probeDiscoveryPortals(intake || {});
  }
  const auth = getBrowserAuthStatus();
  const ready = probes.some((p) => p.ok) || auth.session_ready;
  return {
    ok: ready,
    ...persisted,
    ...meta,
    ...auth,
    probes,
    ready,
  };
}

export function spawnBrowserLoginScript() {
  const script = join(AGENT_OS_ROOT, 'scripts', 'openclaw-browser-login.js');
  if (process.platform === 'win32') {
    spawn(
      'cmd',
      ['/c', 'start', 'cmd', '/k', `cd /d "${AGENT_OS_ROOT}" && node scripts\\openclaw-browser-login.js`],
      { detached: true, stdio: 'ignore', cwd: AGENT_OS_ROOT }
    ).unref();
    return { spawned: true, platform: 'win32', script, cwd: AGENT_OS_ROOT };
  }
  return {
    spawned: false,
    script,
    cwd: AGENT_OS_ROOT,
    hint: `Run from agent-os: node scripts/openclaw-browser-login.js`,
  };
}

/**
 * Warm Playwright, open portal login pages, optionally spawn the interactive login script in a terminal.
 */
export async function startBrowserLoginFlow({ spawnTerminal = false } = {}) {
  const browser = await ensureManagedBrowserReady();
  const loginUrls = [
    { portal: 'linkedin', url: 'https://www.linkedin.com/login' },
    { portal: 'jobstreet', url: 'https://www.jobstreet.com.sg/' },
  ];
  const opened = [];
  for (const { portal, url } of loginUrls) {
    const result = await invokeBrowserOpen(url);
    opened.push({
      portal,
      url,
      ok: result.ok,
      error: result.ok ? null : result.text.slice(0, 200),
    });
  }

  const terminal = spawnTerminal ? spawnBrowserLoginScript() : null;

  return {
    ok: true,
    browser,
    opened,
    terminal,
    login_script: 'node scripts/openclaw-browser-login.js',
    instructions: [
      'Log in to LinkedIn and JobStreet in the OpenClaw Chromium window.',
      'When done, click **Save & connect** on Job Profiles (persists cookies to disk).',
      spawnTerminal
        ? 'A terminal window opened the full login script — complete login there, then Save & connect in the UI.'
        : 'Do not skip Save & connect — metadata alone does not persist cookies.',
    ],
  };
}

export function browserPreflightMessage(status = getBrowserAuthStatus()) {
  if (status.session_ready) {
    return 'Browser session ready (OpenClaw profile=openclaw). Proceed with discovery using pre-filtered search URLs.';
  }
  if (status.persistent_profile_exists && status.linkedin_logged_in) {
    return 'Browser profile exists — use profile=openclaw. Dismiss sign-in modals if job listings are visible.';
  }
  return 'Portal login may be required: Job Profiles → Connect portals → Open login browser → Save & connect.';
}

/**
 * Start (or reuse) the managed Playwright browser. Never stop/restart unless force=true.
 */
export async function ensureManagedBrowserReady({ restartOnFailure = false, force = false } = {}) {
  if (!force && _browserReadyPromise && Date.now() - _browserReadyAt < BROWSER_READY_TTL_MS) {
    return _browserReadyPromise;
  }

  _browserReadyPromise = (async () => {
    const reachable = await isGatewayReachable();
    if (!reachable) {
      throw new Error(
        'OpenClaw gateway is not running (port 18789). Start it: openclaw gateway --port 18789, or run agent-os/start-all.ps1'
      );
    }

    let result = await invokeBrowserAction('start');
    if (!result.ok && restartOnFailure) {
      await invokeBrowserAction('stop').catch(() => {});
      await sleep(1500);
      result = await invokeBrowserAction('start');
    }
    if (!result.ok) {
      const benign =
        /already (?:running|started|open)|browser (?:is )?running|in use|no changes|started \(chrome\)/i.test(
          result.text || ''
        );
      if (benign) {
        const auth = getBrowserAuthStatus();
        return {
          ok: true,
          session_ready: auth.session_ready,
          persistent_profile_exists: auth.persistent_profile_exists,
          linkedin_logged_in: auth.linkedin_logged_in,
          preflight_hint: browserPreflightMessage(auth),
          already_running: true,
        };
      }
      throw new Error(
        `OpenClaw browser control failed (${result.status}): ${result.text.slice(0, 300)}. ` +
          'Try: node scripts/warmup-openclaw-browser.js or restart the gateway.'
      );
    }

    const auth = getBrowserAuthStatus();
    return {
      ok: true,
      session_ready: auth.session_ready,
      persistent_profile_exists: auth.persistent_profile_exists,
      linkedin_logged_in: auth.linkedin_logged_in,
      preflight_hint: browserPreflightMessage(auth),
    };
  })();

  try {
    const out = await _browserReadyPromise;
    _browserReadyAt = Date.now();
    return out;
  } catch (e) {
    _browserReadyPromise = null;
    _browserReadyAt = 0;
    throw e;
  }
}

/** Run work with one shared browser session — start once, never stop until fn completes. */
export async function withManagedBrowserSession(fn, opts = {}) {
  await ensureManagedBrowserReady({ restartOnFailure: false, ...opts });
  return fn();
}

export function resetBrowserReadyCache() {
  _browserReadyPromise = null;
  _browserReadyAt = 0;
}

export async function warmupManagedBrowser() {
  return ensureManagedBrowserReady();
}
