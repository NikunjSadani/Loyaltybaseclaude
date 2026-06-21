/**
 * Shared cross-role token / auth helpers for write-persistence specs.
 *
 * This is the reusable, exported form of the inline `tokenFor('gifsy')` helper
 * that was first written in `partner/visibility-write.e2e.ts` (lines ~26-35).
 * Write-persistence specs need to act as one role and then read back the
 * persisted result as a second role (e.g. partner writes → gifsy reads, or
 * clientAdmin writes → partner reads). Rather than each spec duplicating the
 * storageState-parse logic, import `tokenFor` / `authHeader` from here.
 *
 * Usage example:
 *   import { authHeader } from '../helpers/write';
 *   const gifsyAuth = authHeader('gifsy');
 *   const r = await page.request.get('/api/visibility/submissions', { headers: gifsyAuth });
 *
 * Do NOT modify `partner/visibility-write.e2e.ts` — it has its own inline copy
 * so the green spec stays untouched. New specs should import from here instead.
 */

import { readFileSync } from 'node:fs';
import { ROLES, type RoleKey } from '../fixtures/roles';

/** Shape of a Playwright storageState JSON file (subset we need). */
interface StorageState {
  origins?: {
    localStorage?: { name: string; value: string }[];
  }[];
}

/**
 * Read the JWT that a role's persisted storageState carries (localStorage key
 * `token`). Throws a clear error if the storageState file is absent or the
 * token is missing — which almost always means `npm run e2e` was invoked
 * without running the `setup` project first.
 */
export function tokenFor(roleKey: RoleKey): string {
  const filePath = ROLES[roleKey].storageStatePath;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(
      `tokenFor('${roleKey}'): could not read storageState at ${filePath}. ` +
        `Run the 'setup' project first (npm run e2e -- --project=setup).`,
    );
  }

  const ss = JSON.parse(raw) as StorageState;
  for (const origin of ss.origins ?? []) {
    const entry = (origin.localStorage ?? []).find((x) => x.name === 'token');
    if (entry?.value) return entry.value;
  }

  throw new Error(
    `tokenFor('${roleKey}'): no 'token' entry found in localStorage of ${filePath}. ` +
      `The login for this role may have failed during setup.`,
  );
}

/**
 * Return a ready-to-use Authorization header object for the given role.
 * Convenience wrapper around `tokenFor` for use with `page.request.*` calls:
 *
 *   const r = await page.request.get('/api/tickets', { headers: authHeader('clientAdmin') });
 */
export function authHeader(roleKey: RoleKey): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(roleKey)}` };
}
