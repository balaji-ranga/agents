/**
 * Smoke test: multi-profile per CEO.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';

initDb();
const ps = createJobSearchProfileService(getDb);
const ceo = 'default';

ps.createProfile(ceo, {
  profile_id: 'fintech-architect',
  display_name: 'Fintech Architect Search',
  patch: {
    locations: ['Singapore'],
    work_mode: 'hybrid',
    target_titles: ['Principal Architect'],
    sources: ['linkedin'],
    master_resume_path: '1_foundations/me/Bala_resume_latest.pdf',
    fit_threshold: 70,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
  },
});

ps.createProfile(ceo, {
  profile_id: 'banking-vp',
  display_name: 'Banking VP Search',
  patch: {
    locations: ['Remote APAC'],
    work_mode: 'remote',
    target_titles: ['VP Engineering'],
    sources: ['jobstreet'],
    master_resume_path: '1_foundations/me/Bala_resume_latest.pdf',
    fit_threshold: 65,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
  },
});

const list = ps.listProfiles(ceo);
console.log('profiles:', list.count, list.active_profile_id);
console.log(list.profiles.map((p) => `${p.id} (${p.display_name}) active=${p.is_active}`).join('\n'));

ps.setActiveProfile(ceo, 'banking-vp');
ps.confirm(ceo, 'banking-vp', true);
console.log('active after confirm:', ps.getActiveProfileId(ceo));
console.log('OK');
