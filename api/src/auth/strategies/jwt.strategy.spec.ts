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

const mockPrisma = {
  // updateMany drives the fire-and-forget sliding-session bump; default to a resolved
  // promise so the guard's `.catch(...)` always has a thenable to attach to.
  userSession: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Far-future expiry so the slide guard is a no-op in tests that don't exercise it
// (expiresAt already beyond now + 6d → no bump).
const freshExpiry = () => new Date(Date.now() + 7 * DAY_MS);

const mockActivity = { markActive: jest.fn() };

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
      const result  = await strategy.validate(payload as any);
      expect(result).toEqual(payload);
    });

    it('S5: stamps the user active (fire-and-forget) on a valid session', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: freshExpiry() });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await strategy.validate(payload as any);
      expect(mockActivity.markActive).toHaveBeenCalledWith('user_1', 'deoleo');
    });

    // ── Sliding-session bump (SESSION_TTL_DAYS = 7) ─────────────────────────────
    it('SL1: slides expiresAt to ≈ now + 7d when the session has decayed by > 1 day', async () => {
      // expiresAt only 2 days out → decayed well past the 1-day throttle → bump fires.
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + 2 * DAY_MS) });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await strategy.validate(payload as any);

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.userSession.updateMany.mock.calls[0][0];
      // Scoped to THIS live session; only ever touches expiresAt (never clientId/scope).
      expect(arg.where).toMatchObject({ id: 'sess_1', revokedAt: null });
      expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
      expect(Object.keys(arg.data)).toEqual(['expiresAt']);
      const target: Date = arg.data.expiresAt;
      expect(target.getTime()).toBeGreaterThanOrEqual(Date.now() + 7 * DAY_MS - 2000);
      expect(target.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 2000);
    });

    it('SL2: does NOT slide when the session is still fresh (decayed < 1 day)', async () => {
      // expiresAt 6.5 days out → within the 1-day throttle band → no write.
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + 6.5 * DAY_MS) });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await strategy.validate(payload as any);

      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('SL3: does NOT slide a revoked/expired session (guard 401s before the bump)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null); // revoked/expired → no row
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      await expect(strategy.validate(payload as any)).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('SL4: the slide is fire-and-forget — a rejected updateMany never fails validate', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1', expiresAt: new Date(Date.now() + 2 * DAY_MS) });
      mockPrisma.userSession.updateMany.mockRejectedValueOnce(new Error('db down'));
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9', name: 'T' };

      // Must still resolve with the payload despite the slide write rejecting.
      await expect(strategy.validate(payload as any)).resolves.toEqual(payload);
    });

    it('S6: does NOT stamp activity when the session is invalid', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await expect(strategy.validate(payload as any)).rejects.toThrow(UnauthorizedException);
      expect(mockActivity.markActive).not.toHaveBeenCalled();
    });

    it('S4: throws UnauthorizedException when session is revoked or expired', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await expect(strategy.validate(payload as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
