// TDD: JwtStrategy
// Tests BEFORE implementation — RED first.
//
// S1: constructor throws if JWT_SECRET env var is absent
//       (currently falls back to 'changeme' — should be RED)
// S2: constructs normally when JWT_SECRET is present
// S3: validate() returns payload when session is active
// S4: validate() throws UnauthorizedException when session is revoked/expired

import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { SESSION_TTL_DAYS } from '../auth.constants';
import { ActivityTrackingService } from '../../activity/activity-tracking.service';

const mockPrisma = {
  // updateMany drives the fire-and-forget sliding-session bump; default to a resolved
  // promise so the guard's `.catch(...)` always has a thenable to attach to.
  userSession: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  // S-L2: a failed first-use mark writes an audit row (best-effort).
  auditLog: { create: jest.fn().mockResolvedValue({}) },
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Far-future expiry so the slide guard is a no-op in tests that don't exercise it
// (expiresAt at the full window → decayed 0 → within the 1-day throttle → no bump).
const freshExpiry = () => new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS);

const mockActivity = { markActive: jest.fn() };

/** An installed-app request from an Android phone (how the platform frontend + browser send it). */
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const REQ = { headers: { 'x-client-medium': 'app', 'user-agent': ANDROID_UA } };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(secret: string | undefined) {
  return { get: jest.fn().mockReturnValue(secret) } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JwtStrategy', () => {
  describe('constructor', () => {
    it('S1: throws at startup when JWT_SECRET is not set', () => {
      expect(() => new JwtStrategy(makeConfig(undefined), mockPrisma as any, mockActivity as any))
        .toThrow('JWT_SECRET environment variable is not set');
    });

    it('S2: constructs successfully when JWT_SECRET is present', () => {
      expect(() => new JwtStrategy(makeConfig('supersecret'), mockPrisma as any, mockActivity as any))
        .not.toThrow();
    });
  });

  describe('validate', () => {
    let strategy: JwtStrategy;

    beforeEach(() => {
      strategy = new JwtStrategy(makeConfig('supersecret'), mockPrisma as any, mockActivity as any);
      jest.clearAllMocks();
    });

    it('S3: returns the JWT payload when an active session exists', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      const result  = await strategy.validate(REQ, payload as any);
      expect(result).toEqual(payload);
    });

    // ── H4: first-use mark (set ONCE per session) ─────────────────────────────────
    it('FU1: the FIRST request with a sid-bound token marks firstUsedAt once (set-once WHERE), awaited', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      let marked = false;
      mockPrisma.userSession.updateMany.mockImplementationOnce(async () => {
        marked = true;
        return { count: 1 };
      });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', sid: 'sess_1' };

      await strategy.validate(REQ, payload as any);

      expect(marked).toBe(true); // awaited — the mark lands before the request proceeds
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { id: 'sess_1', firstUsedAt: null },
        data: { firstUsedAt: expect.any(Date) },
      });
    });

    it('FU2: per-instance memo — the 2nd request on the same session makes NO write (never a write per request)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', sid: 'sess_1' };
      await strategy.validate(REQ, payload as any);
      await strategy.validate(REQ, payload as any);
      await strategy.validate(REQ, payload as any);
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledTimes(1);
    });

    it('FU3: a failed first-use write never fails the request, but is LOUD (audit row, S-L2)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      mockPrisma.userSession.updateMany.mockRejectedValueOnce(new Error('db down'));
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', sid: 'sess_1' };
      await expect(strategy.validate(REQ, payload as any)).resolves.toEqual(payload);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityType: 'AUTH_EVENT',
          metadata: expect.objectContaining({ event: 'first_use_mark_failed', sessionId: 'sess_1' }),
        }),
      });
    });

    it('FU4 (M2): a legacy token WITHOUT sid never marks first use (it could match the wrong session)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      await strategy.validate(REQ, { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo' } as any);
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('FU5 (M1): a server-side call flagged x-gifsy-no-first-use (same-request proxy rotation) does NOT count as use', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      await strategy.validate(
        { headers: { ...REQ.headers, 'x-gifsy-no-first-use': '1' } },
        { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', sid: 'sess_1' } as any,
      );
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('FU6 (M3): the session lookup selects only id + expiresAt (no dependency on newer columns)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      await strategy.validate(REQ, { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', sid: 'sess_1' } as any);
      expect(mockPrisma.userSession.findFirst.mock.calls[0][0].select).toEqual({ id: true, expiresAt: true });
    });

    it('S5: stamps the user active (fire-and-forget) on a valid session', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await strategy.validate(REQ, payload as any);
      expect(mockActivity.markActive).toHaveBeenCalledWith('user_1', 'deoleo', { medium: 'app', device: 'phone' });
    });

    it('S5b: passes the request medium/device through (browser on a computer; junk header → unknown)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'CLIENT_ADMIN', clientId: 'bajaj' };
      const pcUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
      await strategy.validate({ headers: { 'x-client-medium': 'browser', 'user-agent': pcUa } }, payload as any);
      expect(mockActivity.markActive).toHaveBeenLastCalledWith('user_1', 'bajaj', { medium: 'browser', device: 'computer' });
      await strategy.validate({ headers: { 'x-client-medium': 'hacker' } }, payload as any);
      expect(mockActivity.markActive).toHaveBeenLastCalledWith('user_1', 'bajaj', { medium: 'unknown', device: 'unknown' });
    });

    it('S5d: a BACKGROUND request (X-Background: 1 — bell poll, badge, beacons) is authenticated but NOT activity', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'SSS', clientId: 'bajaj' };
      await expect(
        strategy.validate({ headers: { ...REQ.headers, 'x-background': '1' } }, payload as any),
      ).resolves.toEqual(payload);
      expect(mockActivity.markActive).not.toHaveBeenCalled();
      // anything but exactly '1' is a normal request
      await strategy.validate({ headers: { ...REQ.headers, 'x-background': 'true' } }, payload as any);
      expect(mockActivity.markActive).toHaveBeenCalledTimes(1);
    });

    it('S5c: HOT PATH — validate resolves even when the activity DB write never settles or throws', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'SSS', clientId: 'bajaj' };
      // A REAL ActivityTrackingService whose DB write hangs forever → validate must not wait for it.
      const hanging = new ActivityTrackingService({ $executeRaw: jest.fn(() => new Promise(() => undefined)) } as any);
      const s1 = new JwtStrategy(makeConfig('supersecret'), mockPrisma as any, hanging);
      await expect(s1.validate(REQ, payload as any)).resolves.toEqual(payload);
      // …and whose DB client throws synchronously → validate must not throw.
      const throwing = new ActivityTrackingService({ $executeRaw: jest.fn(() => { throw new Error('boom'); }) } as any);
      const s2 = new JwtStrategy(makeConfig('supersecret'), mockPrisma as any, throwing);
      await expect(s2.validate(REQ, payload as any)).resolves.toEqual(payload);
      // …and a request object with no headers at all is fine too.
      await expect(s2.validate(undefined, payload as any)).resolves.toEqual(payload);
    });

    // ── Sliding-session bump (SESSION_TTL_DAYS = 30) ────────────────────────────
    it('SL1: slides expiresAt to ≈ now + window when the session has decayed by > 1 day', async () => {
      // expiresAt only 2 days out → decayed well past the 1-day throttle → bump fires.
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + 2 * DAY_MS) });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await strategy.validate(REQ, payload as any);

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.userSession.updateMany.mock.calls[0][0];
      // Scoped to THIS live session; only ever touches expiresAt (never clientId/scope).
      expect(arg.where).toMatchObject({ id: 'sess_1', revokedAt: null });
      expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
      expect(Object.keys(arg.data)).toEqual(['expiresAt']);
      const target: Date = arg.data.expiresAt;
      expect(target.getTime()).toBeGreaterThanOrEqual(Date.now() + SESSION_TTL_DAYS * DAY_MS - 2000);
      expect(target.getTime()).toBeLessThanOrEqual(Date.now() + SESSION_TTL_DAYS * DAY_MS + 2000);
    });

    it('SL2: does NOT slide when the session is still fresh (decayed < 1 day)', async () => {
      // expiresAt half a day inside the full window → decayed < 1 day → within the throttle → no write.
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + (SESSION_TTL_DAYS - 0.5) * DAY_MS) });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await strategy.validate(REQ, payload as any);

      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('SL3: does NOT slide a revoked/expired session (guard 401s before the bump)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null); // revoked/expired → no row
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await expect(strategy.validate(REQ, payload as any)).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('SL4: the slide is fire-and-forget — a rejected updateMany never fails validate', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + 2 * DAY_MS) });
      mockPrisma.userSession.updateMany.mockRejectedValueOnce(new Error('db down'));
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      // Must still resolve with the payload despite the slide write rejecting.
      await expect(strategy.validate(REQ, payload as any)).resolves.toEqual(payload);
    });

    it('S6: does NOT stamp activity when the session is invalid', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await expect(strategy.validate(REQ, payload as any)).rejects.toThrow(UnauthorizedException);
      expect(mockActivity.markActive).not.toHaveBeenCalled();
    });

    it('S4: throws UnauthorizedException when session is revoked or expired', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await expect(strategy.validate(REQ, payload as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
