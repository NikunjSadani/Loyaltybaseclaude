// Per-client "Ticket remarks email" — Gifsy console get/set, validation, audit, owner-only guard,
// and the generic settings PUT refusing the key. Run: npx jest src/gifsy/ticket-remarks-email.spec.ts

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { GifsyController } from './gifsy.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  parseTicketRemarksEmailInput,
  parseTicketRemarksRecipientsInput,
  readTicketRemarksEmail,
  readTicketRemarksRecipients,
} from '../tickets/ticket-remarks-inbox';

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
      create: expect.objectContaining({ clientId: 'bajaj', settingValue: { to: ['tickets@bajaj.example'], cc: [], email: 'tickets@bajaj.example' } }),
      update: expect.objectContaining({ settingValue: { to: ['tickets@bajaj.example'], cc: [], email: 'tickets@bajaj.example' } }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      entityType: 'TICKET_REMARKS_EMAIL', entityId: 'bajaj', actorId: 'admin1',
      oldValues: { to: [], cc: [] }, newValues: { to: ['tickets@bajaj.example'], cc: [] },
    }) });
    expect(res).toMatchObject({ email: 'tickets@bajaj.example', to: ['tickets@bajaj.example'], cc: [], lastChange: { byName: 'Owner' } });
  });

  it('clear: blank removes the row (back to emailing the chosen admin) + audit', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { email: 'tickets@bajaj.example' } }).mockResolvedValueOnce(null);
    const res = await svc.setTicketRemarksEmail(owner, 'bajaj', { email: '' });
    expect(tx.programSetting.deleteMany).toHaveBeenCalledWith({ where: { clientId: 'bajaj', settingKey: 'ticketRemarksEmail' } });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ oldValues: { to: ['tickets@bajaj.example'], cc: [] }, newValues: { to: [], cc: [] } });
    expect(res.email).toBeNull();
    expect(res).toMatchObject({ to: [], cc: [] });
  });

  it('lists: To + CC normalised (trim, lowercase, dedupe) and stored with email = To[0]', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await svc.setTicketRemarksEmail(owner, 'bajaj', {
      to: [' A@Bajaj.Example ', 'a@bajaj.example', 'b@bajaj.example', ''],
      cc: ['C@bajaj.example', 'c@bajaj.example '],
    });
    const value = { to: ['a@bajaj.example', 'b@bajaj.example'], cc: ['c@bajaj.example'], email: 'a@bajaj.example' };
    expect(tx.programSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ settingValue: value }) }));
    expect(tx.auditLog.create.mock.calls[0][0].data.newValues).toEqual({ to: value.to, cc: value.cc });
  });

  it('CC only (To blank) is stored WITHOUT `email` (a rolled-back reader never treats it as an inbox)', async () => {
    const { svc, prisma, tx } = makeService();
    await svc.setTicketRemarksEmail(owner, 'bajaj', { to: [], cc: ['ops@bajaj.example'] });
    expect(tx.programSetting.upsert.mock.calls[0][0].create.settingValue).toEqual({ to: [], cc: ['ops@bajaj.example'] });
    expect(prisma.programSetting.findUnique).toHaveBeenCalled();
  });

  it('both lists empty removes the row', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { to: ['a@b.com'], cc: ['c@d.com'] } });
    await svc.setTicketRemarksEmail(owner, 'bajaj', { to: [], cc: [] });
    expect(tx.programSetting.deleteMany).toHaveBeenCalled();
    expect(tx.programSetting.upsert).not.toHaveBeenCalled();
  });

  it('legacy {email} body keeps the existing CC list (never silently wiped)', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { to: ['old@b.com'], cc: ['c@d.com'] } });
    await svc.setTicketRemarksEmail(owner, 'bajaj', { email: 'new@b.com' });
    expect(tx.programSetting.upsert.mock.calls[0][0].update.settingValue).toEqual({ to: ['new@b.com'], cc: ['c@d.com'], email: 'new@b.com' });
  });

  it('{ to } alone keeps the stored CC; { cc } alone keeps the stored To', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { to: ['a@b.com'], cc: ['c@d.com'] } });
    await svc.setTicketRemarksEmail(owner, 'bajaj', { to: ['x@b.com'] });
    expect(tx.programSetting.upsert.mock.calls[0][0].update.settingValue).toEqual({ to: ['x@b.com'], cc: ['c@d.com'], email: 'x@b.com' });

    const second = makeService();
    second.prisma.programSetting.findUnique.mockResolvedValueOnce({ settingValue: { to: ['a@b.com'], cc: ['c@d.com'] } });
    await second.svc.setTicketRemarksEmail(owner, 'bajaj', { cc: ['e@f.com'] });
    expect(second.tx.programSetting.upsert.mock.calls[0][0].update.settingValue).toEqual({ to: ['a@b.com'], cc: ['e@f.com'], email: 'a@b.com' });
  });

  it('{ cc } alone that collides with the stored To → 400 (no silent removal)', () => {
    expect(() => parseTicketRemarksRecipientsInput({ cc: ['a@b.com'] }, { to: ['a@b.com'], cc: [] }))
      .toThrow('a@b.com cannot be in both To and CC — keep it in one list.');
  });

  it('old single-address record reads as To = [email], CC = [] (GET)', async () => {
    const { svc, prisma } = makeService();
    prisma.programSetting.findUnique.mockResolvedValue({ settingValue: { email: 'Tickets@Bajaj.Example' } });
    expect(await svc.getTicketRemarksEmail(owner, 'bajaj')).toMatchObject({
      to: ['tickets@bajaj.example'], cc: [], email: 'tickets@bajaj.example',
    });
  });

  it('re-saving an old single-address record as lists with the same To is a no-op', async () => {
    const { svc, prisma, tx } = makeService();
    prisma.programSetting.findUnique.mockResolvedValue({ settingValue: { email: 'tickets@bajaj.example' } });
    await svc.setTicketRemarksEmail(owner, 'bajaj', { to: ['tickets@bajaj.example'], cc: [] });
    expect(tx.programSetting.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
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

describe('ticket remarks email — strict printable-ASCII validation (follow-up)', () => {
  it.each([
    ['zero-width space U+200B', 'tickets\u200B@bajaj.example'],
    ['zero-width joiner U+200D', 'tickets@baj\u200Daj.example'],
    ['BOM U+FEFF inside', 'tick\uFEFFets@bajaj.example'],
    ['control char', 'tickets\u0007@bajaj.example'],
    ['backslash', 'tick\\ets@bajaj.example'],
    ['colon', 'mailto:tickets@bajaj.example'],
    ['angle brackets', '<tickets@bajaj.example>'],
    ['quotes', '"tickets"@bajaj.example'],
    ['non-ASCII letter', 'tickéts@bajaj.example'],
    ['no TLD', 'tickets@bajaj'],
    ['leading-dash label', 'tickets@-bajaj.example'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseTicketRemarksEmailInput(raw)).toThrow(BadRequestException);
  });

  it('a stored value with an invisible char is never used', () => {
    expect(readTicketRemarksEmail({ email: 'tickets\u200B@bajaj.example' })).toBeNull();
  });

  it('list validation: invalid entry named by list + position; limits; overlap; mixing legacy + lists', () => {
    const msg = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'no error'; };
    expect(msg(() => parseTicketRemarksRecipientsInput({ to: ['a@b.com', 'nope'] }))).toBe('To address 2: "nope" is not a valid email address.');
    expect(msg(() => parseTicketRemarksRecipientsInput({ cc: ['x@y.com, z@y.com'] }))).toMatch(/^CC address 1: Enter ONE email address/);
    expect(msg(() => parseTicketRemarksRecipientsInput({ to: ['1@b.com', '2@b.com', '3@b.com', '4@b.com', '5@b.com', '6@b.com'] })))
      .toBe('At most 5 To addresses are allowed (got 6).');
    expect(msg(() => parseTicketRemarksRecipientsInput({ cc: Array.from({ length: 11 }, (_, i) => `c${i}@b.com`) })))
      .toBe('At most 10 CC addresses are allowed (got 11).');
    expect(msg(() => parseTicketRemarksRecipientsInput({ to: ['a@b.com'], cc: ['A@B.com'] })))
      .toBe('a@b.com cannot be in both To and CC — keep it in one list.');
    expect(msg(() => parseTicketRemarksRecipientsInput({ to: ['a@b.com'], email: 'c@d.com' }))).toMatch(/not both/);
    expect(msg(() => parseTicketRemarksRecipientsInput({ to: 'a@b.com' as never }))).toMatch(/must be a list/);
    // Exactly 5 / 10 is fine; duplicates collapse BEFORE the limit is checked.
    expect(parseTicketRemarksRecipientsInput({ to: ['1@b.com', '2@b.com', '3@b.com', '4@b.com', '5@b.com', '5@B.com'] }).to).toHaveLength(5);
  });

  it('readTicketRemarksRecipients: new shape, legacy shape, junk dropped, overlap kept in To only', () => {
    expect(readTicketRemarksRecipients({ email: 'a@b.com' })).toEqual({ to: ['a@b.com'], cc: [] });
    expect(readTicketRemarksRecipients({ to: ['a@b.com', 'junk'], cc: ['a@b.com', 'c@d.com'] })).toEqual({ to: ['a@b.com'], cc: ['c@d.com'] });
    expect(readTicketRemarksRecipients({ to: [], cc: ['c@d.com'], email: 'ignored@x.com' })).toEqual({ to: [], cc: ['c@d.com'] });
    expect(readTicketRemarksRecipients(null)).toEqual({ to: [], cc: [] });
    expect(readTicketRemarksEmail({ to: ['x@y.com'], cc: [] })).toBe('x@y.com');
  });

  it('still accepts ordinary addresses (plus, dots, hyphens, apostrophe, sub-domains)', () => {
    for (const ok of ['support+tickets@bajaj.example', "o'neil@mail.bajaj-consumer.co.in", 'a.b_c-d%x@sub.domain.in']) {
      expect(parseTicketRemarksEmailInput(ok)).toBe(ok.toLowerCase());
    }
  });
});
