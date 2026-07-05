/**
 * Smoke test: harvest uses one browser session and profile search URLs only.
 * Run: node tests/job-portal-harvest-smoke.js
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { pickPrimarySearchUrls } from '../backend/src/services/job-portal-search-urls.js';
import { isJobListingUrl } from '../backend/src/services/job-url-validation.js';

let startCallCount = 0;

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/tools/invoke')) {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const action = body?.args?.action;
    if (action === 'start') startCallCount += 1;
    if (action === 'start') {
      return new Response(JSON.stringify({ ok: true, result: { content: [{ text: '{"ok":true}' }] } }), {
        status: 200,
      });
    }
    if (action === 'open') {
      return new Response(JSON.stringify({ ok: true, result: { content: [{ text: 'opened' }] } }), { status: 200 });
    }
    if (action === 'evaluate') {
      const listings = [
        { href: 'https://www.linkedin.com/jobs/view/svp-head-at-dbs-1234567890', text: 'SVP Head\nDBS Bank' },
        { href: 'https://www.linkedin.com/jobs/view/head-cloud-at-ocbc-9876543210', text: 'Head Cloud\nOCBC' },
        { href: 'https://www.linkedin.com/jobs/view/ed-tech-at-uob-1111111111', text: 'ED Tech\nUOB' },
      ];
      return new Response(
        JSON.stringify({ ok: true, result: { content: [{ text: JSON.stringify(listings) }] } }),
        { status: 200 }
      );
    }
    if (action === 'snapshot') {
      return new Response(JSON.stringify({ ok: true, result: { content: [{ text: 'jobs/view sample' }] } }), {
        status: 200,
      });
    }
  }
  if (u.includes('/health')) return new Response('ok', { status: 200 });
  if (u.includes('/v1/chat/completions') && opts.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return origFetch(url, opts);
};

initDb();
const db = getDb();
const profileSvc = createJobSearchProfileService(() => db);
const profile = profileSvc.getProfile('default', 'banking-svp-cloud-sg');

const urls = pickPrimarySearchUrls(profile.intake || {});
console.log('Profile search URLs (one per source):');
urls.forEach((u) => console.log(`  [${u.source}] ${u.url}`));

const { resetBrowserReadyCache } = await import('../backend/src/services/job-browser-auth.js');
resetBrowserReadyCache();
startCallCount = 0;

const { harvestJobListingsForProfile } = await import('../backend/src/services/job-portal-harvest.js');
const result = await harvestJobListingsForProfile(profile.intake || {}, { max_pages: 1, scroll_steps_per_page: 1 });

console.log('\nHarvest result:');
console.log('  count:', result.count);
console.log('  browser start calls:', startCallCount, '(expect 1)');
console.log('  search_urls:', result.search_urls?.length, '(expect ≤2)');

const listings = result.listings || [];
const valid = listings.filter((l) => isJobListingUrl(l.url) && l.title);
console.log('  valid listings:', valid.length);

let failed = 0;
if (startCallCount !== 1) {
  console.error('  ✗ Expected exactly 1 browser start call, got', startCallCount);
  failed++;
} else {
  console.log('  ✓ Single browser session');
}
if ((result.search_urls?.length || 0) > 2) {
  console.error('  ✗ Too many search URLs opened');
  failed++;
} else {
  console.log('  ✓ Profile URLs only');
}
if (valid.length < 1) {
  console.error('  ✗ No valid listings extracted');
  failed++;
} else {
  console.log('  ✓ Listings extracted');
  valid.slice(0, 3).forEach((l) => console.log(`     → ${l.company || '?'} | ${l.title} | ${l.url.slice(0, 55)}…`));
}

globalThis.fetch = origFetch;
if (failed) process.exit(1);
console.log('\nHARVEST SMOKE OK');
