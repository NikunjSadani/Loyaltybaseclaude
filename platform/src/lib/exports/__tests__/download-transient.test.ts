/**
 * LOW (2026-11-20): while the session is alive but the server is unreachable, SessionExpiryGuard hands callers a
 * typed transient 503 `{ error: 'Connection problem — please retry.', transient: true }` instead of the raw 401.
 * The download message must show that text — never "Your session has expired".
 */
import { describe, it, expect } from 'vitest';
import { downloadErrorMessage } from '@/lib/exports/download';
import { CONNECTION_PROBLEM_MESSAGE } from '@/components/auth/SessionExpiryGuard';

describe('downloadErrorMessage — guard transient error', () => {
  it.each([false, true])('staff=%s: shows "Connection problem — please retry", not a session-expiry text', (staff) => {
    const msg = downloadErrorMessage(503, CONNECTION_PROBLEM_MESSAGE, { staff });
    expect(msg).toBe(CONNECTION_PROBLEM_MESSAGE);
    expect(msg).not.toMatch(/session has expired/i);
  });
});
