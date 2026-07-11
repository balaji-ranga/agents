import { initDb, getDb } from '../src/db/schema.js';
import { registerCeoUser } from '../src/services/users.js';
import { getDbForCeo } from '../src/db/request-db.js';
import { getCeoDbPath } from '../src/db/ceo-db.js';
import { getCeoDbModeForUser } from '../src/db/ceo-db-config.js';
import { existsSync } from 'fs';

initDb();
const stamp = Date.now().toString(36);
const shared = registerCeoUser({
  email: `shared-${stamp}@test.local`,
  password: 'x',
  name: 'Shared User',
  db_mode: 'shared',
});
const tenant = registerCeoUser({
  email: `tenant-${stamp}@test.local`,
  password: 'x',
  name: 'Tenant User',
  db_mode: 'tenant',
});

const mainDb = getDb();
const sharedDb = getDbForCeo(shared.id);
const tenantDb = getDbForCeo(tenant.id);

console.log('shared mode:', getCeoDbModeForUser(shared.id), sharedDb === mainDb ? 'OK main-db' : 'FAIL');
console.log('tenant mode:', getCeoDbModeForUser(tenant.id), existsSync(getCeoDbPath(tenant.id)) ? 'OK tenant-file' : 'FAIL');
console.log('tenant db !== main:', tenantDb !== mainDb ? 'OK' : 'FAIL');
