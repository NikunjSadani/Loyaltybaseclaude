// TenantGuard — app-layer tenant chokepoint (Phase S, S5).
// Run: npx jest src/common/guards/tenant.guard.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantGuard } from './tenant.guard';
import type { ExecutionContext } from '@nestjs/common';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReflector(isPublic: boolean | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
}

/** Builds a context whose request carries `user` (or none); returns the request
 *  object too so tests can assert what the guard stamped onto it. */
function makeContext(user: unknown): { ctx: ExecutionContext; request: any } {
  const request: any = { user };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass:   () => ({}),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('TenantGuard', () => {
  // ── A. Public routes are skipped entirely ─────────────────────────────────
  describe('A – public routes', () => {
    it('A1: allows a @Public() route even with no user', () => {
      const guard = new TenantGuard(makeReflector(true));
      const { ctx } = makeContext(undefined);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('A2: does not stamp tenantId on a public route', () => {
      const guard = new TenantGuard(makeReflector(true));
      const { ctx, request } = makeContext(undefined);
      guard.canActivate(ctx);
      expect(request.tenantId).toBeUndefined();
    });
  });

  // ── B. Tenant resolved → pass + stamp ─────────────────────────────────────
  describe('B – authenticated request with a tenant', () => {
    it('B1: allows when user.clientId is a non-empty string', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx } = makeContext({ sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'deoleo' });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('B2: stamps req.tenantId from the JWT clientId', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx, request } = makeContext({ sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'deoleo' });
      guard.canActivate(ctx);
      expect(request.tenantId).toBe('deoleo');
    });

    it('B3: GIFSY_ADMIN passes too — it carries a clientId (cross-tenant routes scope by path slug)', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx, request } = makeContext({ sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy' });
      expect(guard.canActivate(ctx)).toBe(true);
      expect(request.tenantId).toBe('gifsy');
    });
  });

  // ── C. No tenant resolved → loud 403 ──────────────────────────────────────
  describe('C – authenticated request without a resolvable tenant', () => {
    it('C1: throws when user is missing entirely', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx } = makeContext(undefined);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('C2: throws when clientId is missing from the payload', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx } = makeContext({ sub: 'u1', role: 'CLIENT_ADMIN' });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('C3: throws when clientId is an empty / whitespace string', () => {
      const guard = new TenantGuard(makeReflector(false));
      expect(() => guard.canActivate(makeContext({ clientId: '' }).ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(makeContext({ clientId: '   ' }).ctx)).toThrow(ForbiddenException);
    });

    it('C4: throws when clientId is a non-string (defends against a malformed token)', () => {
      const guard = new TenantGuard(makeReflector(false));
      expect(() => guard.canActivate(makeContext({ clientId: 123 }).ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(makeContext({ clientId: null }).ctx)).toThrow(ForbiddenException);
    });

    it('C5: does not stamp tenantId when it rejects', () => {
      const guard = new TenantGuard(makeReflector(false));
      const { ctx, request } = makeContext({ sub: 'u1', role: 'CLIENT_ADMIN' });
      expect(() => guard.canActivate(ctx)).toThrow();
      expect(request.tenantId).toBeUndefined();
    });
  });
});
