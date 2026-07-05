/**
 * Smoke: profile rename + delete via service layer.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';

initDb();

const profile = createJobSearchProfileService(getDb);
const CEO = `delete-rename-smoke-${Date.now()}`;
const PID = `orig-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

profile.createProfile(CEO, { profile_id: PID, display_name: 'Original name' });
profile.savePatch(CEO, PID, {
  locations: ['SG'],
  work_mode: 'remote',
  target_titles: ['Engineer'],
  sources: ['linkedin'],
  master_resume_path: 'C:\\test\\resume.pdf',
  linkedin_profile: 'https://www.linkedin.com/in/test',
  fit_threshold: 70,
  honesty_ack: true,
});

const renamed = profile.renameProfile(CEO, PID, { display_name: 'Renamed display' });
assert(renamed.display_name === 'Renamed display', 'display_name renamed');
assert(renamed.id === PID, 'profile_id unchanged when only display_name');

const slugRenamed = profile.renameProfile(CEO, PID, {
  new_profile_id: `new-${Date.now()}`,
  display_name: 'Slug renamed',
});
const newId = slugRenamed.id;
assert(newId !== PID, 'profile_id slug changed');
assert(slugRenamed.display_name === 'Slug renamed', 'display_name on slug rename');
const oldRow = getDb().prepare('SELECT id FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?').get(CEO, PID);
assert(!oldRow, 'old profile_id gone after slug rename');

try {
  profile.deleteProfile(CEO, newId, false);
  throw new Error('delete without confirm should fail');
} catch (e) {
  assert(String(e.message).includes('confirm'), 'delete requires confirm');
}

const deleted = profile.deleteProfile(CEO, newId, true);
assert(deleted.deleted === true, 'profile deleted');
const goneRow = getDb().prepare('SELECT id FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?').get(CEO, newId);
assert(!goneRow, 'profile row removed');

console.log('\nOK — delete/rename smoke passed\n');
