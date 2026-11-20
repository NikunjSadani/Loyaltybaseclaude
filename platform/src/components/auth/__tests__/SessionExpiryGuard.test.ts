import { describe, expect, it } from 'vitest';
import { shouldRedirectOnAuth } from '../SessionExpiryGuard';

describe('shouldRedirectOnAuth', () => {
  it('H1: a 401 WITHOUT the session marker (business 401, e.g. a wrong OTP) is never a session expiry', () => {
    expect(shouldRedirectOnAuth(401, '/api/rewards/redeem/confirm', '/partner/rewards', null)).toBe(false);
    expect(shouldRedirectOnAuth(401, '/api/rewards/redeem/confirm', '/partner/rewards', 'other')).toBe(false);
    expect(shouldRedirectOnAuth(401, '/api/rewards/redeem/confirm', '/partner/rewards', 'session')).toBe(true);
  });

  it('redirects on a 401 from a same-origin /api call while on an app page', () => {
    expect(shouldRedirectOnAuth(401, '/api/admin/credits/fields', '/admin/credits-payouts/fields', 'session')).toBe(true);
    expect(shouldRedirectOnAuth(401, 'https://uat.deoleoloyalty.gifsy.in/api/wallet', '/partner/dashboard', 'session')).toBe(true);
  });

  it('does NOT redirect on 403 (Forbidden = authenticated but not permitted)', () => {
    expect(shouldRedirectOnAuth(403, '/api/admin/credits/fields', '/admin/credits-payouts/fields', 'session')).toBe(false);
  });

  it('does NOT redirect on non-401 statuses (400/200/500)', () => {
    expect(shouldRedirectOnAuth(400, '/api/admin/credits/fields', '/admin/x', 'session')).toBe(false);
    expect(shouldRedirectOnAuth(200, '/api/admin/credits/fields', '/admin/x', 'session')).toBe(false);
    expect(shouldRedirectOnAuth(500, '/api/admin/credits/fields', '/admin/x', 'session')).toBe(false);
  });

  it('does NOT redirect for the login flow itself (/api/auth/*)', () => {
    expect(shouldRedirectOnAuth(401, '/api/auth/verify-otp', '/auth/login', 'session')).toBe(false);
    expect(shouldRedirectOnAuth(401, '/api/auth/send-otp', '/auth/login', 'session')).toBe(false);
  });

  it('does NOT redirect for non-/api requests (RSC / static / external)', () => {
    expect(shouldRedirectOnAuth(401, '/_next/data/x.json', '/admin/x', 'session')).toBe(false);
    expect(shouldRedirectOnAuth(401, 'https://other.example/thing', '/admin/x', 'session')).toBe(false);
  });

  it('does NOT redirect when already on an /auth page (no loop)', () => {
    expect(shouldRedirectOnAuth(401, '/api/admin/x', '/auth/login', 'session')).toBe(false);
  });
});
