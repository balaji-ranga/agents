/**
 * Deterministic job listing harvest via OpenClaw Playwright browser (profile=openclaw).
 * One browser session per run; opens profile search URLs (LinkedIn + JobStreet) once each.
 */
import { pickPrimarySearchUrls } from './job-portal-search-urls.js';
import { parseDiscoveryDepth } from './job-candidate-context.js';
import { enrichJobFromUrl } from './job-job-enrichment.js';
import {
  withManagedBrowserSession,
  invokeBrowserAction,
  invokeBrowserOpen,
  parseInvokeText,
  sleep,
} from './job-browser-auth.js';

const LINKEDIN_JOB_RE =
  /https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/jobs\/view\/[a-zA-Z0-9_-]+/gi;
const JOBSTREET_JOB_RE =
  /https?:\/\/(?:[\w.-]+\.)?jobstreet\.com(?:\.sg)?\/[^\s"'<>]*\/job\/[^\s"'<>?#]+/gi;

const HARVEST_JS = {
  linkedin: `() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
      let href = a.href || '';
      href = href.split('?')[0].split('#')[0];
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = a.closest('li, div[class*="job"], div[class*="result"], article') || a;
      const text = (card.innerText || a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      out.push({ href, text });
    }
    return out;
  }`,
  jobstreet: `() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/job/"]')) {
      let href = a.href || '';
      if (!/\\/job\\//.test(href)) continue;
      href = href.split('?')[0].split('#')[0];
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = a.closest('article, div[data-automation], li, div[class*="card"]') || a;
      const text = (card.innerText || a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      out.push({ href, text });
    }
    return out;
  }`,
  scroll: `() => {
    window.scrollBy(0, Math.max(400, window.innerHeight * 0.85));
    return window.scrollY;
  }`,
  clickNext: `() => {
    const candidates = [
      ...document.querySelectorAll('button[aria-label*="Next" i], a[aria-label*="Next" i]'),
      ...document.querySelectorAll('button, a'),
    ];
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
      if (/^next$/i.test(label) || /view next page/i.test(label) || /^\\s*›\\s*$/.test(label)) {
        el.click();
        return { clicked: true, label: label.slice(0, 80) };
      }
    }
    return { clicked: false };
  }`,
};

function normalizeJobUrl(url, source) {
  let u = String(url || '').trim().split('#')[0];
  if (!u) return '';
  if (source === 'linkedin') {
    u = u.split('?')[0];
    if (!/\/jobs\/view\//.test(u)) return '';
  }
  return u;
}

function parseListingFromCardText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let title = lines[0] || '';
  let company = lines[1] || '';
  if (company.includes('·')) company = company.split('·')[0].trim();
  return { title: title.slice(0, 120), company: company.slice(0, 80) };
}

function pageOrigin(pageUrl, source) {
  try {
    if (pageUrl) return new URL(pageUrl).origin;
  } catch (_) {}
  return source === 'linkedin' ? 'https://www.linkedin.com' : 'https://www.jobstreet.com.sg';
}

function resolveSnapshotHref(href, source, pageUrl) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return normalizeJobUrl(h, source);
  const origin = pageOrigin(pageUrl, source);
  if (source === 'linkedin' && /\/jobs\/view\/\d+/.test(h)) {
    const id = h.match(/\/jobs\/view\/(\d+)/)?.[1];
    return id ? `https://www.linkedin.com/jobs/view/${id}` : normalizeJobUrl(`${origin}${h.split('?')[0]}`, source);
  }
  if (source === 'jobstreet' && /\/job\/\d+/.test(h)) {
    const id = h.match(/\/job\/(\d+)/)?.[1];
    return id ? `${origin}/job/${id}` : '';
  }
  if (h.startsWith('/')) return normalizeJobUrl(`${origin}${h.split('?')[0].split('#')[0]}`, source);
  return normalizeJobUrl(h, source);
}

/** Parse OpenClaw accessibility snapshots (`- /url: /jobs/view/123…` relative paths). */
function extractListingsFromAccessibilitySnapshot(text, source, pageUrl) {
  const lines = String(text || '').split('\n');
  const listings = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const urlLine = lines[i].match(/^\s*- \/url:\s*(.+)\s*$/);
    if (!urlLine) continue;

    const href = urlLine[1].trim();
    const isListing =
      source === 'linkedin'
        ? /\/jobs\/view\/\d+/.test(href)
        : /\/job\/\d+/.test(href) && !/-jobs\/in-/.test(href);
    if (!isListing) continue;

    const url = resolveSnapshotHref(href, source, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let title = '';
    let company = '';
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      const titleMatch = lines[j].match(/generic "([^"]{4,140})"/);
      if (titleMatch && !/^(Save|Hide|Skip|Info|New to you|Strong applicant)/i.test(titleMatch[1])) {
        title = titleMatch[1];
        break;
      }
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
      const companyMatch = lines[j].match(/generic \[ref=[^\]]+\]:\s+([A-Za-z][^\n]{1,80})$/);
      if (companyMatch && !/Contract|Region|ago|\$|p\.m\./i.test(companyMatch[1])) {
        company = companyMatch[1].trim();
        break;
      }
    }

    const parsed = parseListingFromCardText(title ? `${title}\n${company}` : '');
    listings.push({
      url,
      title: parsed.title || title,
      company: parsed.company || company,
      source,
    });
  }

  return listings;
}

function extractUrlsFromSnapshot(text, source, pageUrl = '') {
  const fromA11y = extractListingsFromAccessibilitySnapshot(text, source, pageUrl);
  if (fromA11y.length) return fromA11y;

  const re = source === 'linkedin' ? LINKEDIN_JOB_RE : JOBSTREET_JOB_RE;
  const matches = String(text || '').match(re) || [];
  return [...new Set(matches.map((u) => normalizeJobUrl(u, source)).filter(Boolean))].map((url) => ({
    url,
    title: '',
    company: '',
    source,
  }));
}

function parseEvaluatePayload(result) {
  const raw = parseInvokeText(result);
  if (!raw) return null;
  try {
    const outer = JSON.parse(raw);
    if (Array.isArray(outer)) return outer;
    const inner = outer?.result?.content?.[0]?.text ?? outer?.content?.[0]?.text ?? outer?.result;
    if (typeof inner === 'string') {
      try {
        const parsed = JSON.parse(inner);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) return parsed;
      } catch {
        const m = inner.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      }
    }
    if (inner != null && typeof inner === 'object') return inner;
  } catch (_) {}
  const m = String(raw).match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

async function browserEvaluate(fn, agentId = 'jobdiscovery') {
  const result = await invokeBrowserAction('evaluate', agentId, { fn });
  if (!result.ok) return null;
  const parsed = parseEvaluatePayload(result);
  return parsed;
}

async function browserSnapshotUrls(agentId = 'jobdiscovery') {
  const result = await invokeBrowserAction('snapshot', agentId, { urls: true, limit: 8000 });
  if (result.ok) return parseInvokeText(result);
  return '';
}

async function collectLinksOnPage(source, agentId, pageUrl = '') {
  const js = HARVEST_JS[source] || HARVEST_JS.jobstreet;
  const evaluated = await browserEvaluate(js, agentId);
  const fromEval = Array.isArray(evaluated)
    ? evaluated
        .map((row) => {
          const parsed = parseListingFromCardText(row.text || '');
          return {
            url: normalizeJobUrl(row.href || row.url, source),
            title: parsed.title,
            company: parsed.company,
            source,
          };
        })
        .filter((r) => r.url)
    : [];

  if (fromEval.length >= 1) return fromEval;

  const snap = await browserSnapshotUrls(agentId);
  const fromSnap = extractUrlsFromSnapshot(snap, source, pageUrl).map((row) => {
    const parsed = enrichJobFromUrl({
      url: row.url,
      title: row.title || '',
      company: row.company || '',
      source: source === 'linkedin' ? 'linkedin.com' : 'jobstreet.com.sg',
    });
    return {
      url: row.url,
      title: parsed.title || row.title || '',
      company: parsed.company || row.company || '',
      source,
    };
  });

  const merged = new Map();
  for (const row of [...fromEval, ...fromSnap]) {
    if (!merged.has(row.url)) merged.set(row.url, row);
    else if (!merged.get(row.url).title && row.title) merged.set(row.url, row);
  }
  return [...merged.values()];
}

async function scrollPage(scrollSteps, agentId) {
  for (let i = 0; i < scrollSteps; i++) {
    const scrolled = await browserEvaluate(HARVEST_JS.scroll, agentId);
    if (!scrolled) {
      await invokeBrowserAction('act', agentId, { kind: 'scroll', direction: 'down' }).catch(() => {});
    }
    await sleep(700);
  }
}

async function clickNextPage(agentId) {
  const clicked = await browserEvaluate(HARVEST_JS.clickNext, agentId);
  if (clicked?.clicked) {
    await sleep(2000);
    return true;
  }
  return false;
}

function detectLoginWall(snapshotText) {
  const t = String(snapshotText || '').toLowerCase();
  const login = /sign in to view|authwall|login to view|log in to continue|please sign in|join linkedin/i.test(t);
  const jobs = /jobs\/view|\/job\/|view job|apply now/i.test(t);
  return login && !jobs;
}

/**
 * Harvest listings from one profile search URL (scroll + optional pagination).
 * Caller must already have an active browser session (withManagedBrowserSession).
 */
export async function harvestPortalSearchPage({
  url,
  source = 'linkedin',
  maxPages = 2,
  scrollStepsPerPage = 2,
  maxListings = 15,
  agentId = 'jobdiscovery',
} = {}) {
  const open = await invokeBrowserOpen(url, agentId);
  if (!open.ok) {
    return {
      ok: false,
      source,
      search_url: url,
      error: open.text.slice(0, 300),
      listings: [],
    };
  }
  await sleep(3500);

  const all = new Map();
  let pagesVisited = 0;
  let loginWall = false;

  for (let page = 0; page < maxPages; page++) {
    pagesVisited += 1;
    await scrollPage(scrollStepsPerPage, agentId);
    const batch = await collectLinksOnPage(source, agentId, url);
    for (const row of batch) {
      if (!all.has(row.url)) all.set(row.url, { ...row, source, search_url: url });
    }
    if (all.size >= maxListings) break;

    const snap = await browserSnapshotUrls(agentId);
    if (detectLoginWall(snap)) {
      loginWall = true;
      break;
    }

    if (page >= maxPages - 1) break;
    const advanced = await clickNextPage(agentId);
    if (!advanced) break;
  }

  const listings = [...all.values()].slice(0, maxListings);
  return {
    ok: listings.length > 0 || !loginWall,
    source,
    search_url: url,
    pages_visited: pagesVisited,
    scroll_steps_per_page: scrollStepsPerPage,
    login_wall: loginWall,
    listings,
    count: listings.length,
  };
}

/**
 * Harvest profile search URLs — one LinkedIn + one JobStreet URL from job profile config.
 * Single browser session for the entire run (no cyclic Chrome launch).
 */
export async function harvestJobListingsForProfile(intake = {}, opts = {}) {
  const depth = parseDiscoveryDepth(intake);
  const sourceFilter = opts.source ? String(opts.source).toLowerCase() : null;
  let targets = pickPrimarySearchUrls(intake);
  if (sourceFilter) {
    targets = targets.filter((u) => u.source === sourceFilter || u.source.includes(sourceFilter));
  }

  if (!targets.length) {
    return { ok: false, error: 'No search URLs for profile sources', listings: [], by_source: {} };
  }

  const scrollSteps = opts.scroll_steps_per_page ?? 2;
  const maxListings = opts.max_listings ?? depth.max_jobs_per_run;
  const perSourceTimeoutMs = Number(opts.per_source_timeout_ms || process.env.HARVEST_SOURCE_TIMEOUT_MS || 120000);
  const agentId = opts.agent_id || 'jobdiscovery';

  return withManagedBrowserSession(async () => {
    const bySource = {};
    const allListings = [];
    const runs = [];

    for (const entry of targets) {
      const source = entry.source.includes('linkedin') ? 'linkedin' : 'jobstreet';
      const maxPages =
        opts.max_pages ??
        (source === 'linkedin' ? Math.min(depth.linkedin_pages, 3) : Math.min(depth.jobstreet_pages, 3));

      const harvestOne = harvestPortalSearchPage({
        url: entry.url,
        source,
        maxPages,
        scrollStepsPerPage: scrollSteps,
        maxListings: Math.ceil(maxListings / Math.max(1, targets.length)),
        agentId,
      });

      const run = await Promise.race([
        harvestOne,
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                source,
                search_url: entry.url,
                error: `Harvest timed out after ${perSourceTimeoutMs}ms`,
                listings: [],
                timed_out: true,
              }),
            perSourceTimeoutMs
          )
        ),
      ]);

      runs.push(run);
      bySource[source] = [...(bySource[source] || []), ...(run.listings || [])];
      for (const row of run.listings || []) {
        if (!allListings.some((x) => x.url === row.url)) allListings.push(row);
      }
      if (allListings.length >= maxListings) break;
    }

    return {
      ok: allListings.length > 0,
      listings: allListings.slice(0, maxListings),
      count: allListings.length,
      search_urls: targets.map((t) => t.url),
      by_source: Object.fromEntries(
        Object.entries(bySource).map(([k, v]) => [k, { count: v.length, listings: v }])
      ),
      runs,
      hint: 'Listings harvested from profile search URLs. jobs_append with title, company, url, source.',
    };
  });
}
