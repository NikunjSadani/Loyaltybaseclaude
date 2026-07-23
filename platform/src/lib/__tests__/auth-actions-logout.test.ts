/**
 * ALO — logoutAction cookie clearing.
 *
 * logout must drop EVERY session cookie so a shared device / the next login starts clean —
 * including the Wave-3 `active_partner_id` active-outlet selection (else the next user
 * inherits the previous user's selected sibling outlet).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const deleted: string[] = [];
const cookieStore = {
  delete: vi.fn((name: string) => { deleted.push(name); }),
  get: vi.fn(() => undefined),
  set: vi.fn(),
};
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

import { logoutAction } from '@/lib/auth-actions';

beforeEach(() => { deleted.length = 0; cookieStore.delete.mockClear(); });

describe('ALO — logoutAction clears all session cookies', () => {
  it('deletes the auth cookies AND the active-partner selection', async () => {
    const res = await logoutAction();
    expect(res).toEqual({ success: true });
    expect(deleted).toContain('token');
    expect(deleted).toContain('refresh_token');
    expect(deleted).toContain('home_token');
    expect(deleted).toContain('home_refresh_token');
    // The fix: the active-outlet selection cookie is cleared on logout.
    expect(deleted).toContain('active_partner_id');
  });
});
