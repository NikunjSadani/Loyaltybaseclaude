import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ROLES, AUTH_DIR, type RoleKey } from '../fixtures/roles';
import { login } from '../helpers/login';

/**
 * Log each role in through the real form and persist its storageState for the role projects to
 * reuse. As the matrix fans out, add role keys here. GIFSY is intentionally NOT here yet (#39 —
 * login is broken until the subdomain/dev-clientId fix); a dedicated login-matrix spec asserts
 * that expected-broken state so it can't be silently forgotten.
 */
mkdirSync(AUTH_DIR, { recursive: true });

const SESSION_ROLES: RoleKey[] = ['partner'];

for (const key of SESSION_ROLES) {
  const role = ROLES[key];
  setup(`authenticate ${role.key}`, async ({ page }) => {
    await login(page, role);
    await page.context().storageState({ path: role.storageStatePath });
  });
}
