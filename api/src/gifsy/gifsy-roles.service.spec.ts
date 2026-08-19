// RBAC Option-X (P1) — GifsyRolesService (self-service role-editor CRUD).
// Run: npx jest src/gifsy/gifsy-roles.service.spec.ts

import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GifsyRolesService } from './gifsy-roles.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

// A real GIFSY_ADMIN in TRUE platform context (not assumed) → passes platformWide.
const OWNER = { sub: 'owner_1', role: 'GIFSY_ADMIN', assumed: false } as unknown as JwtPayload;
// A GIFSY_ADMIN assumed into a tenant → platformWide is false → must be rejected.
const ASSUMED = { role: 'GIFSY_ADMIN', assumed: true } as unknown as JwtPayload;

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('GifsyRolesService', () => {
  let prisma: {
    gifsyRole: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { groupBy: jest.Mock; count: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let cache: { clearCache: jest.Mock };
  let svc: GifsyRolesService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      gifsyRole: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      user: { groupBy: jest.fn(), count: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    cache = { clearCache: jest.fn() };
    svc = new GifsyRolesService(
      prisma as unknown as PrismaService,
      cache as unknown as GifsyRoleService,
    );
  });

  describe('createRole', () => {
    it('creates a role and returns it (non-reserved permissions)', async () => {
      const created = { id: 'r1', name: 'Ops', permissions: ['kyc:read'], isSystem: false };
      prisma.gifsyRole.create.mockResolvedValue(created);

      const result = await svc.createRole(OWNER, {
        name: '  Ops  ',
        permissions: ['kyc:read', 'kyc:read'], // dupe → deduped
      });

      expect(result).toBe(created);
      expect(prisma.gifsyRole.create).toHaveBeenCalledWith({
        data: {
          clientId: 'gifsy',
          name: 'Ops', // trimmed
          description: null,
          permissions: ['kyc:read'], // deduped
          isSystem: false, // owner can never mint a system role
        },
      });
    });

    it('rejects unknown permission keys with BadRequest', async () => {
      await expect(
        svc.createRole(OWNER, { name: 'Bad', permissions: ['kyc:read', 'not:a:real:key'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gifsyRole.create).not.toHaveBeenCalled();
    });

    it('rejects a reserved permission without allowReserved (Lock 1)', async () => {
      await expect(
        svc.createRole(OWNER, { name: 'Money', permissions: ['credits:upload'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gifsyRole.create).not.toHaveBeenCalled();
    });

    it('allows a reserved permission WITH allowReserved:true', async () => {
      const created = { id: 'r2', name: 'Money', permissions: ['credits:upload'] };
      prisma.gifsyRole.create.mockResolvedValue(created);

      const result = await svc.createRole(OWNER, {
        name: 'Money',
        permissions: ['credits:upload'],
        allowReserved: true,
      });

      expect(result).toBe(created);
      expect(prisma.gifsyRole.create).toHaveBeenCalled();
    });

    it('writes an audit row recording the reserved grant', async () => {
      prisma.gifsyRole.create.mockResolvedValue({ id: 'r9', name: 'Money' });

      await svc.createRole(OWNER, {
        name: 'Money',
        permissions: ['credits:upload'],
        allowReserved: true,
      });

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const arg = prisma.auditLog.create.mock.calls[0][0];
      expect(arg.data.action).toBe('CREATE');
      expect(arg.data.entityType).toBe('GIFSY_ROLE');
      expect(arg.data.actorId).toBe(OWNER.sub);
      expect(arg.data.metadata.reservedGranted).toContain('credits:upload');
      expect(arg.data.metadata.allowReserved).toBe(true);
    });

    it('maps a P2002 duplicate-name violation to Conflict', async () => {
      prisma.gifsyRole.create.mockRejectedValue(p2002());

      await expect(
        svc.createRole(OWNER, { name: 'Dupe', permissions: ['kyc:read'] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an empty/whitespace name with BadRequest', async () => {
      await expect(
        svc.createRole(OWNER, { name: '   ', permissions: ['kyc:read'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateRole', () => {
    it('throws NotFound when the role does not exist', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue(null);

      await expect(
        svc.updateRole(OWNER, 'missing', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });

    it('allows editing a SYSTEM role and clears the cache on a permissions change', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'sys1',
        clientId: 'gifsy',
        isSystem: true,
        deletedAt: null,
      });
      const updated = { id: 'sys1', permissions: ['kyc:read', 'visibility:write'] };
      prisma.gifsyRole.update.mockResolvedValue(updated);

      const result = await svc.updateRole(OWNER, 'sys1', {
        permissions: ['kyc:read', 'visibility:write'],
      });

      expect(result).toBe(updated);
      // Allow-listed data — no isSystem field ever passed through.
      const call = prisma.gifsyRole.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'sys1' });
      expect(call.data).toEqual({ permissions: ['kyc:read', 'visibility:write'] });
      expect(call.data.isSystem).toBeUndefined();
      expect(cache.clearCache).toHaveBeenCalledTimes(1);
    });

    it('does NOT clear the cache when only name/description change', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });
      prisma.gifsyRole.update.mockResolvedValue({ id: 'r1' });

      await svc.updateRole(OWNER, 'r1', { name: 'Renamed' });

      expect(cache.clearCache).not.toHaveBeenCalled();
    });

    it('maps a P2002 duplicate-name violation to Conflict', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });
      prisma.gifsyRole.update.mockRejectedValue(p2002());

      await expect(
        svc.updateRole(OWNER, 'r1', { name: 'Taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a reserved permission on UPDATE without allowReserved (Lock 1, the sneak path)', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });

      await expect(
        svc.updateRole(OWNER, 'r1', { permissions: ['credits:upload'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });

    it('allows a reserved permission on UPDATE WITH allowReserved:true', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });
      prisma.gifsyRole.update.mockResolvedValue({ id: 'r1' });

      await svc.updateRole(OWNER, 'r1', {
        permissions: ['credits:upload'],
        allowReserved: true,
      });

      expect(prisma.gifsyRole.update).toHaveBeenCalled();
      expect(cache.clearCache).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown permission key on UPDATE', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });

      await expect(
        svc.updateRole(OWNER, 'r1', { permissions: ['not:a:key'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteRole', () => {
    it('blocks deleting a SYSTEM role with BadRequest', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'sys1',
        clientId: 'gifsy',
        isSystem: true,
        deletedAt: null,
      });

      await expect(svc.deleteRole(OWNER, 'sys1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });

    it('blocks deleting an in-use role with Conflict', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });
      prisma.user.count.mockResolvedValue(3);

      await expect(svc.deleteRole(OWNER, 'r1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });

    it('soft-deletes a not-in-use role, frees its name, and clears the cache', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue({
        id: 'r1',
        name: 'Contractor',
        clientId: 'gifsy',
        isSystem: false,
        deletedAt: null,
      });
      prisma.user.count.mockResolvedValue(0);
      prisma.gifsyRole.updateMany.mockResolvedValue({ count: 1 });

      const result = await svc.deleteRole(OWNER, 'r1');

      expect(result).toEqual({ id: 'r1', deleted: true });
      // Self-guarding where (write-sweep LOW-1): the soft-delete is scoped to the gifsy tenant.
      const call = prisma.gifsyRole.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'r1', clientId: 'gifsy' });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      // The stored name is mangled with the id so the (clientId, name) slot frees up for reuse.
      expect(call.data.name).toContain('Contractor');
      expect(call.data.name).toContain('r1');
      expect(call.data.name).not.toBe('Contractor');
      // In-use count is scoped to LIVE staff (matches the displayed usersCount).
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { gifsyRoleId: 'r1', deletedAt: null },
      });
      expect(cache.clearCache).toHaveBeenCalledTimes(1);
    });

    it('throws NotFound for a missing role', async () => {
      prisma.gifsyRole.findFirst.mockResolvedValue(null);

      await expect(svc.deleteRole(OWNER, 'gone')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listRoles', () => {
    it('attaches usersCount from a single groupBy', async () => {
      prisma.gifsyRole.findMany.mockResolvedValue([
        { id: 'r1', name: 'A', description: null, permissions: [], isSystem: true, createdAt: 1, updatedAt: 2 },
        { id: 'r2', name: 'B', description: 'x', permissions: ['kyc:read'], isSystem: false, createdAt: 3, updatedAt: 4 },
      ]);
      prisma.user.groupBy.mockResolvedValue([{ gifsyRoleId: 'r1', _count: 5 }]);

      const result = await svc.listRoles(OWNER);

      expect(result[0]).toMatchObject({ id: 'r1', usersCount: 5 });
      expect(result[1]).toMatchObject({ id: 'r2', usersCount: 0 });
      expect(prisma.gifsyRole.findMany).toHaveBeenCalledWith({
        where: { clientId: 'gifsy', deletedAt: null },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
    });

    it('skips the groupBy when there are no roles', async () => {
      prisma.gifsyRole.findMany.mockResolvedValue([]);

      const result = await svc.listRoles(OWNER);

      expect(result).toEqual([]);
      expect(prisma.user.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('getPermissionCatalog', () => {
    it('returns groups (each permission flagged reserved) and the reserved list', () => {
      const catalog = svc.getPermissionCatalog(OWNER);

      expect(Array.isArray(catalog.groups)).toBe(true);
      expect(catalog.groups.length).toBeGreaterThan(0);
      expect(Array.isArray(catalog.reserved)).toBe(true);
      // credits:upload is reserved → flagged true somewhere in the catalog.
      const creditsGroup = catalog.groups.find((g) => g.key === 'CREDITS');
      const upload = creditsGroup?.permissions.find((p) => p.key === 'credits:upload');
      expect(upload?.reserved).toBe(true);
      // kyc:read is NOT reserved.
      const kycGroup = catalog.groups.find((g) => g.key === 'KYC');
      const read = kycGroup?.permissions.find((p) => p.key === 'kyc:read');
      expect(read?.reserved).toBe(false);
    });
  });

  describe('assumed-operator re-gate (platformWide)', () => {
    it('rejects an assumed GIFSY operator on every method with Forbidden', async () => {
      await expect(svc.listRoles(ASSUMED)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.createRole(ASSUMED, { name: 'X', permissions: [] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.updateRole(ASSUMED, 'r1', { name: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.deleteRole(ASSUMED, 'r1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(() => svc.getPermissionCatalog(ASSUMED)).toThrow(ForbiddenException);

      // Nothing touched the DB.
      expect(prisma.gifsyRole.findMany).not.toHaveBeenCalled();
      expect(prisma.gifsyRole.create).not.toHaveBeenCalled();
      expect(prisma.gifsyRole.findFirst).not.toHaveBeenCalled();
      expect(prisma.gifsyRole.update).not.toHaveBeenCalled();
    });
  });
});
