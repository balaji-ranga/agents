/**
 * Quick test: jobdiscovery agent uses browser on JobStreet.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const CEO = 'default';
const PROFILE = 'banking-svp-cloud-sg';

const message = `[ceo_user_id: ${CEO}]
Profile ${PROFILE} is active. Use browser tool with profile=openclaw only:
1. Navigate to https://www.jobstreet.com.sg/jobs?keywords=SVP%20technology%20banking&location=Singapore
2. Open the first job listing and report its exact URL, company, and title.
Do not use jobs_append yet — just confirm browser works.`;

async function main() {
  console.log('Testing jobdiscovery browser...');
  const res = await fetch(`${BASE}/api/agents/jobdiscovery/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ceo-user-id': CEO },
    body: JSON.stringify({ message, user_id: CEO }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json().catch(() => ({}));
  console.log('Status:', res.status);
  console.log('Reply:', data.reply || data.error);
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
