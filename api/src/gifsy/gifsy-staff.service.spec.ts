// Unit tests for GifsyStaffService (RBAC Option-X P1 — Gifsy staff management).
// Focus: the AUTH invariant — deactivate AND reassign must stamp sessionsInvalidBefore
// and revoke sessions, with the stamp COMMITTED BEFORE the sweep (two separate statements,
// NOT one $transaction); pure edits must NOT revoke; owner-only gating; target scoping.
// Run: npx jest --no-coverage src/gifsy/gifsy-staff.service.spec.ts

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GifsyStaffService } from './gifsy-staff.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ACTIVE_PHONE_IN_USE_MSG } from '../common/phone-conflict';

const mockPrisma = {
  user: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  userSession: { updateMany: jest.fn() },
  gifsyRole: { findFirst: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
};

const owner: JwtPayload = {
  sub: 'owner_1',
  role: 'GIFSY_ADMIN',
  clientId: 'gifsy',
  phone: '9999999999',
  name: 'Owner',
};

// A GIFSY_ADMIN ASSUMED into a tenant — must be rejected by platformWide().
const assumed: JwtPayload = { ...owner, assumed: true, clientId: 'deoleo' };

// Build a P2002 shaped like the ACTIVE-phone partial-index violation.
function phoneP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'users_clientId_phone_active_key' },
  });
}

describe('GifsyStaffService', () => {
  let service: GifsyStaffService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GifsyStaffService(mockPrisma as unknown as PrismaService);
  });

  describe('owner gating (platformWide)', () => {
    it('rejects an assumed GIFSY operator on every method', async () => {
      await expect(service.listStaff(assumed)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createStaff(assumed, { name: 'A', phone: '9000000000', gifsyRoleId: 'r1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.updateStaff(assumed, 'u1', { name: 'A' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Nothing touched the DB.
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('listStaff', () => {
    it('scopes to live GIFSY_STAFF of the gifsy tenant', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      await service.listStaff(owner);
      const arg = mockPrisma.user.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({
        clientId: 'gifsy',
        role: 'GIFSY_STAFF',
        deletedAt: null,
      });
    });
  });

  describe('createStaff', () => {
    it('creates a GIFSY_STAFF user when the role exists', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue({ id: 'r1', name: 'Ops' });
      mockPrisma.user.create.mockResolvedValue({ id: 'u1', name: 'Alice' });

      const res = await service.createStaff(owner, {
        name: '  Alice  ',
        phone: '9000000001',
        email: 'a@x.com',
        gifsyRoleId: 'r1',
      });

      expect(res).toEqual({ id: 'u1', name: 'Alice' });
      const arg = mockPrisma.user.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        clientId: 'gifsy',
        role: 'GIFSY_STAFF',
        status: 'ACTIVE',
        name: 'Alice', // trimmed
        phone: '9000000001',
        gifsyRoleId: 'r1',
      });
    });

    it('rejects an invalid gifsyRoleId with BadRequest', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue(null);
      await expect(
        service.createStaff(owner, { name: 'A', phone: '9000000002', gifsyRoleId: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('maps an ACTIVE-phone conflict to BadRequest with the shared message', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue({ id: 'r1' });
      mockPrisma.user.create.mockRejectedValue(phoneP2002());
      await expect(
        service.createStaff(owner, { name: 'A', phone: '9000000003', gifsyRoleId: 'r1' }),
      ).rejects.toThrow(ACTIVE_PHONE_IN_USE_MSG);
    });
  });

  describe('updateStaff — session revocation invariant', () => {
    const target = {
      id: 'u1',
      name: 'Alice',
      phone: '9000000001',
      status: 'ACTIVE',
      gifsyRoleId: 'r1',
    };

    beforeEach(() => {
      mockPrisma.user.findFirst.mockResolvedValue(target);
      mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
    });

    it('looks the target up scoped to role GIFSY_STAFF + clientId gifsy (no cross-tenant / non-staff)', async () => {
      await service.updateStaff(owner, 'u1', { name: 'Alice B' });
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'u1', clientId: 'gifsy', role: 'GIFSY_STAFF' },
      });
    });

    it('DEACTIVATE stamps sessionsInvalidBefore AND revokes sessions, stamp COMMITTED BEFORE the sweep', async () => {
      await service.updateStaff(owner, 'u1', { status: 'INACTIVE' });

      // Row update carries the status change AND the session high-water stamp.
      const updateArg = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'u1' });
      expect(updateArg.data.status).toBe('INACTIVE');
      expect(updateArg.data.sessionsInvalidBefore).toBeInstanceOf(Date);
      // All live sessions revoked as a SEPARATE statement.
      const revokeArg = mockPrisma.userSession.updateMany.mock.calls[0][0];
      expect(revokeArg.where).toEqual({ userId: 'u1', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
      // Stamp and revoke share the same timestamp instant.
      expect(updateArg.data.sessionsInvalidBefore).toEqual(revokeArg.data.revokedAt);
      // CRITICAL: the stamp (user.update) must be committed BEFORE the sweep (updateMany) —
      // NOT wrapped in one $transaction — so the refresh path's post-mint re-read observes it.
      const stampOrder = mockPrisma.user.update.mock.invocationCallOrder[0];
      const sweepOrder = mockPrisma.userSession.updateMany.mock.invocationCallOrder[0];
      expect(stampOrder).toBeLessThan(sweepOrder);
    });

    it('REASSIGN to a different valid role validates it, stamps, and revokes (stamp before sweep)', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue({ id: 'r2', name: 'PM' });

      await service.updateStaff(owner, 'u1', { gifsyRoleId: 'r2' });

      // New role validated against clientId 'gifsy', not soft-deleted.
      expect(mockPrisma.gifsyRole.findFirst).toHaveBeenCalledWith({
        where: { id: 'r2', clientId: 'gifsy', deletedAt: null },
      });
      const updateArg = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArg.data.gifsyRole).toEqual({ connect: { id: 'r2' } });
      expect(updateArg.data.sessionsInvalidBefore).toBeInstanceOf(Date);
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      const stampOrder = mockPrisma.user.update.mock.invocationCallOrder[0];
      const sweepOrder = mockPrisma.userSession.updateMany.mock.invocationCallOrder[0];
      expect(stampOrder).toBeLessThan(sweepOrder);
    });

    it('REASSIGN to a non-existent role → BadRequest, no writes', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue(null);
      await expect(
        service.updateStaff(owner, 'u1', { gifsyRoleId: 'ghost' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('pure name edit does NOT revoke sessions and never smuggles a role change', async () => {
      mockPrisma.user.update.mockResolvedValue({ id: 'u1', name: 'Alice B' });

      await service.updateStaff(owner, 'u1', { name: 'Alice B' });

      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      const arg = mockPrisma.user.update.mock.calls[0][0];
      expect(arg.data.name).toBe('Alice B');
      expect(arg.data.sessionsInvalidBefore).toBeUndefined();
      expect(arg.data.role).toBeUndefined();
    });

    it('404 when the target staff member is missing', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.updateStaff(owner, 'ghost', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a racing phone conflict to BadRequest (phone change goes through the revoke path)', async () => {
      mockPrisma.user.update.mockRejectedValue(phoneP2002());
      await expect(
        service.updateStaff(owner, 'u1', { phone: '9000000009' }),
      ).rejects.toThrow(ACTIVE_PHONE_IN_USE_MSG);
    });

    it('writes an audit row on deactivate recording sessionsRevoked', async () => {
      await service.updateStaff(owner, 'u1', { status: 'INACTIVE' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.auditLog.create.mock.calls[0][0];
      expect(arg.data.action).toBe('UPDATE');
      expect(arg.data.entityType).toBe('GIFSY_STAFF');
      expect(arg.data.targetUserId).toBe('u1');
      expect(arg.data.metadata.sessionsRevoked).toBe(true);
      expect(arg.data.metadata.deactivated).toBe('INACTIVE');
    });

    it('records the role reassignment (from → to) in the audit row', async () => {
      mockPrisma.gifsyRole.findFirst.mockResolvedValue({ id: 'r2', name: 'PM' });

      await service.updateStaff(owner, 'u1', { gifsyRoleId: 'r2' });

      const arg = mockPrisma.auditLog.create.mock.calls[0][0];
      expect(arg.data.metadata.reassignedRole).toEqual({ from: 'r1', to: 'r2' });
      expect(arg.data.metadata.sessionsRevoked).toBe(true);
    });
  });
});
