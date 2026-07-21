import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ROLES, AUTH_DIR, type RoleKey } from '../fixtures/roles';
import { login } from '../helpers/login';

/**
 * Log each role in through the real form and persist its storageState for the role projects to
 * reuse. GIFSY logs in via the dev clientId override (#39) — the same real-login path as the rest.
 * Each setup test runs login(), which asserts the right backendRole + dashboard route, so this IS
 * the per-role login+routing assertion (no separate login-matrix needed).
 */
mkdirSync(AUTH_DIR, { recursive: true });

const SESSION_ROLES: RoleKey[] = ['partner', 'partnerApproved', 'clientAdmin', 'sales', 'gifsy', 'clientbAdmin', 'mis', 'salesManager'];

for (const key of SESSION_ROLES) {
  const role = ROLES[key];
  setup(`authenticate ${role.key}`, async ({ page }) => {
    await login(page, role);
    await page.context().storageState({ path: role.storageStatePath });
  });
}
