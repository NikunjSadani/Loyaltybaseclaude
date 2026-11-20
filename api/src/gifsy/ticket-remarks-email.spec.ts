// Per-client "Ticket remarks email" — Gifsy console get/set, validation, audit, owner-only guard,
// and the generic settings PUT refusing the key. Run: npx jest src/gifsy/ticket-remarks-email.spec.ts

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { GifsyController } from './gifsy.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { parseTicketRemarksEmailInput, readTicketRemarksEmail } from '../tickets/ticket-remarks-inbox';

const owner: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Owner' };
const staff: JwtPayload = { sub: 'staff1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: 'Staff' };
const clientAdmin: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'CA' };

function makeService() {
  const tx = {
    programSetting: { upsert: jest.fn(), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    client: { findUnique: jest.fn().mockResolvedValue({ id: 'bajaj' }) },
    programSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const svc = new GifsyService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, prisma, tx };
}

describe('parseTicketRemarksEmailInput / readTicketRemarksEmail', () => {
  it('trims + lowercases one valid address; blank / null clear it', () => {
    expect(parseTicketRemarksEmailInput('  Support@Bajaj.Example ')).toBe('support@bajaj.example');
    expect(parseTicketRemarksEmailInput('')).toBeNull();
    expect(parseTicketRemarksEmailInput('   ')).toBeNull();
    expect(parseTicketRemarksEmailInput(null)).toBeNull();
    expect(parseTicketRemarksEmailInput(undefined)).toBeNull();
  });

  it.each(['not-an-email', 'a@b', '@bajaj.example', 'a b@bajaj.example', 'x@y.com, z@y.com', 'x@y.com;z@y.com', `${'a'.repeat(250)}@b.com`])(
    'rejects %j',
    (raw) => {
      expect(() => parseTicketRemarksEmailInput(raw)).toThrow(BadRequestException);
    },
  );

  it('rejects non-text', () => {
    expect(() => parseTicketRemarksEmailInput(42 as never)).toThrow(BadRequestException);
  });

  it('reads only a valid stored address', () => {
    expect(readTicketRemarksEmail({ email: 'a@b.com' })).toBe('a@b.com');
    expect(readTicketRemarksEmail({ email: 'junk' })).toBeNull();
    expect(readTicketRemarksEmail(null)).toBeNull();
  });
});

describe('GifsyService ticket remarks email', () => {
  it('set: validated address upserted on the TENANT row + audit (old → new); returns last change', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique
      .mockResolvedValueOnce(null) // prior
      .mockResolvedValueOnce({ settingValue: { email: 'tickets@bajaj.example' } }); // view
    prisma.auditLog.findFirst.mockResolvedValue({ createdAt: new Date(), actor: { name: 'Owner' } });
    const res = await svc.setTicketRemarksEmail(owner, 'bajaj', { email: ' Tickets@Bajaj.Example ' });
    expect(tx.programSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientId_settingKey: { clientId: 'bajaj', settingKey: 'ticketRemarksEmail' } },
      create: expect.objectContaining({ clientId: 'bajaj', settingValue: { email: 'tickets@bajaj.example' } }),
      update: expect.objectContaining({ settingValue: { email: 'tickets@bajaj.example' } }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      entityType: 'TICKET_REMARKS_EMAIL', entityId: 'bajaj', actorId: 'admin1',
      oldValues: { email: null }, newValues: { email: 'tickets@bajaj.example' },
    }) });
    expect(res).toMatchObject({ email: 'tickets@bajaj.example', lastChange: { byName: 'Owner' } });
  });

  it('clear: blank removes the row (back to emailing the chosen admin) + audit', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { email: 'tickets@bajaj.example' } }).mockResolvedValueOnce(null);
    const res = await svc.setTicketRemarksEmail(owner, 'bajaj', { email: '' });
    expect(tx.programSetting.deleteMany).toHaveBeenCalledWith({ where: { clientId: 'bajaj', settingKey: 'ticketRemarksEmail' } });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ oldValues: { email: 'tickets@bajaj.example' }, newValues: { email: null } });
    expect(res.email).toBeNull();
  });

  it('no-op when unchanged (no write, no audit row)', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValue({ settingValue: { email: 'tickets@bajaj.example' } });
    await svc.setTicketRemarksEmail(owner, 'bajaj', { email: 'TICKETS@bajaj.example' });
    expect(tx.programSetting.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('invalid / list input is rejected before any write', async () => {
    const { svc, tx } = makeService();
    await expect(svc.setTicketRemarksEmail(owner, 'bajaj', { email: 'a@b.com, c@d.com' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setTicketRemarksEmail(owner, 'bajaj', { email: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.programSetting.upsert).not.toHaveBeenCalled();
  });

  it('GIFSY_ADMIN only — GIFSY_STAFF and CLIENT_ADMIN are refused for read AND write', async () => {
    const { svc, tx } = makeService();
    for (const u of [staff, clientAdmin]) {
      await expect(svc.getTicketRemarksEmail(u, 'bajaj')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.setTicketRemarksEmail(u, 'bajaj', { email: 'a@b.com' })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(tx.programSetting.upsert).not.toHaveBeenCalled();
  });

  it('unknown client → 404', async () => {
    const { svc, prisma } = makeService();
    prisma.client.findUnique.mockResolvedValue(null);
    await expect(svc.getTicketRemarksEmail(owner, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('routes: @Roles(GIFSY_ADMIN) and NO @RequirePermission (a staff can never pass the guard on a permission)', () => {
    for (const m of ['getTicketRemarksEmail', 'setTicketRemarksEmail'] as const) {
      const handler = GifsyController.prototype[m];
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['GIFSY_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBeUndefined();
    }
  });
});
