// RBAC Option-X — GifsyRoleService (per-request permission resolver + TTL cache).
// Run: npx jest src/common/rbac/gifsy-role.service.spec.ts

import { GifsyRoleService } from './gifsy-role.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrisma(findFirst: jest.Mock): PrismaService {
  return { gifsyRole: { findFirst } } as unknown as PrismaService;
}

describe('GifsyRoleService', () => {
  it('resolves a role to its validated permission set', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      permissions: ['kyc:read', 'visibility:approve'],
    });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    const perms = await svc.getPermissions('role-1');
    expect(perms.has('kyc:read')).toBe(true);
    expect(perms.has('visibility:approve')).toBe(true);
    expect(perms.size).toBe(2);
  });

  it('drops unknown / stale permission strings stored on the role', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      permissions: ['kyc:read', 'not:a:real:key', ''],
    });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    const perms = await svc.getPermissions('role-1');
    expect(perms.has('kyc:read')).toBe(true);
    expect(perms.size).toBe(1);
  });

  it('honors a reserved permission if the role explicitly holds it (resolution only)', async () => {
    // The resolver does NOT filter reserved keys — that is a route/editor concern.
    const findFirst = jest.fn().mockResolvedValue({ permissions: ['wallet:adjust'] });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    const perms = await svc.getPermissions('role-1');
    expect(perms.has('wallet:adjust')).toBe(true);
  });

  it('returns an empty set for a null/empty roleId WITHOUT hitting the DB', async () => {
    const findFirst = jest.fn();
    const svc = new GifsyRoleService(makePrisma(findFirst));

    expect((await svc.getPermissions(null)).size).toBe(0);
    expect((await svc.getPermissions(undefined)).size).toBe(0);
    expect((await svc.getPermissions('')).size).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns an empty set for an unknown / soft-deleted role (findFirst → null)', async () => {
    // The query filters deletedAt: null, so a soft-deleted role returns null here.
    const findFirst = jest.fn().mockResolvedValue(null);
    const svc = new GifsyRoleService(makePrisma(findFirst));

    const perms = await svc.getPermissions('gone');
    expect(perms.size).toBe(0);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'gone', deletedAt: null } }),
    );
  });

  it('caches within the TTL — a second lookup does not re-query', async () => {
    const findFirst = jest.fn().mockResolvedValue({ permissions: ['kyc:read'] });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    await svc.getPermissions('role-1');
    await svc.getPermissions('role-1');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a miss (no repeated DB hits for a bad id)', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const svc = new GifsyRoleService(makePrisma(findFirst));

    await svc.getPermissions('bad');
    await svc.getPermissions('bad');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('re-queries after the TTL elapses (staleness bound)', async () => {
    const findFirst = jest.fn().mockResolvedValue({ permissions: ['kyc:read'] });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    await svc.getPermissions('role-1');
    // advance past the 30s TTL
    nowSpy.mockReturnValue(1_000_000 + GifsyRoleService.CACHE_TTL_MS + 1);
    await svc.getPermissions('role-1');
    expect(findFirst).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('clearCache() forces a re-query', async () => {
    const findFirst = jest.fn().mockResolvedValue({ permissions: ['kyc:read'] });
    const svc = new GifsyRoleService(makePrisma(findFirst));

    await svc.getPermissions('role-1');
    svc.clearCache();
    await svc.getPermissions('role-1');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
