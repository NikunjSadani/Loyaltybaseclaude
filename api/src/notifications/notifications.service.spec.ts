import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Msg91Service } from './msg91.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedChannelConfig } from '../notification-templates/notification-templates.config';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import { AdminCoreService } from '../admin-core/admin-core.service';

/**
 * NotificationsService — enqueue seam + the in-app "bell feed" (Phase 1).
 *
 * The feed tests run against a small in-memory fake of `prisma.notificationQueue` that
 * implements exactly the query shapes the service uses (create / findMany with the
 * keyset OR cursor / count / findFirst / update / updateMany). This exercises real
 * behaviour — ownership isolation, unread counting, idempotent mark-read, read-all and
 * cursor pagination — rather than only asserting call args.
 */

interface Row {
  id: string;
  userId: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string;
  variables: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

/** Evaluate a (subset of) Prisma `where` against a row. */
function matchesWhere(row: Row, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(v as any[]).some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    const rowVal = (row as any)[k];
    if (v === null) {
      if (rowVal !== null && rowVal !== undefined) return false;
    } else if (v instanceof Date) {
      if (!(rowVal instanceof Date) || rowVal.getTime() !== v.getTime()) return false;
    } else if (typeof v === 'object' && 'lt' in (v as any)) {
      if (!(rowVal < (v as any).lt)) return false;
    } else {
      if (rowVal !== v) return false;
    }
  }
  return true;
}

class FakeQueue {
  rows: Row[] = [];
  private seq = 0;

  create({ data, select }: any) {
    const row: Row = {
      id: data.id ?? `id-${String(++this.seq).padStart(4, '0')}`,
      userId: data.userId,
      channel: data.channel,
      status: data.status,
      subject: data.subject ?? null,
      body: data.body,
      variables: data.variables ?? null,
      readAt: data.readAt ?? null,
      createdAt: data.createdAt ?? new Date(),
      processedAt: data.processedAt ?? null,
    };
    this.rows.push(row);
    return Promise.resolve(this.project(row, select));
  }

  findMany({ where, orderBy, take, select }: any) {
    let out = this.rows.filter((r) => matchesWhere(r, where));
    const orders: any[] = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    out = out.sort((a, b) => {
      for (const o of orders) {
        const [key, dir] = Object.entries(o)[0] as [string, string];
        const av = (a as any)[key];
        const bv = (b as any)[key];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
    if (typeof take === 'number') out = out.slice(0, take);
    return Promise.resolve(out.map((r) => this.project(r, select)));
  }

  count({ where }: any) {
    return Promise.resolve(this.rows.filter((r) => matchesWhere(r, where)).length);
  }

  findFirst({ where, select }: any) {
    const row = this.rows.find((r) => matchesWhere(r, where));
    return Promise.resolve(row ? this.project(row, select) : null);
  }

  update({ where, data, select }: any) {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) return Promise.reject(new Error('not found'));
    Object.assign(row, data);
    return Promise.resolve(this.project(row, select));
  }

  updateMany({ where, data }: any) {
    const hits = this.rows.filter((r) => matchesWhere(r, where));
    for (const r of hits) Object.assign(r, data);
    return Promise.resolve({ count: hits.length });
  }

  private project(row: Row, select?: Record<string, boolean>) {
    if (!select) return { ...row };
    const out: any = {};
    for (const k of Object.keys(select)) out[k] = (row as any)[k];
    return out;
  }
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let fake: FakeQueue;

  beforeEach(async () => {
    fake = new FakeQueue();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: { notificationQueue: fake } },
        { provide: Msg91Service, useValue: { sendWhatsappTemplate: jest.fn(), sendSms: jest.fn() } },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  // ── enqueue (unchanged seam) ───────────────────────────────────────────────
  describe('enqueue', () => {
    it('enqueues a QUEUED notification row and returns its id', async () => {
      const res = await service.enqueue({
        userId: 'u1',
        channel: 'WHATSAPP',
        body: 'Your KYC is approved',
        recipientPhone: '+919999999999',
        variables: { name: 'Asha' },
      });
      expect(res.id).toBeDefined();
      const row = fake.rows[0];
      expect(row.status).toBe('QUEUED');
      expect(row.channel).toBe('WHATSAPP');
      expect(row.userId).toBe('u1');
    });
  });

  // ── writeInApp ─────────────────────────────────────────────────────────────
  describe('writeInApp', () => {
    it('writes an IN_APP row as SENT with processedAt and folds url into variables', async () => {
      await service.writeInApp({ userId: 'u1', subject: 'Hi', body: 'body', url: '/x' });
      const row = fake.rows[0];
      expect(row.channel).toBe('IN_APP');
      expect(row.status).toBe('SENT');
      expect(row.processedAt).toBeInstanceOf(Date);
      expect(row.readAt).toBeNull();
      expect(row.variables).toEqual({ url: '/x' });
    });

    it('is best-effort: a DB failure is swallowed and returns null', async () => {
      jest.spyOn(fake, 'create').mockRejectedValueOnce(new Error('db down'));
      const res = await service.writeInApp({ userId: 'u1', body: 'b' });
      expect(res).toBeNull();
    });

    it('leaves variables null when neither url nor variables are given', async () => {
      await service.writeInApp({ userId: 'u1', body: 'b' });
      expect(fake.rows[0].variables).toBeNull();
    });
  });

  // ── notifyUser (fan-out) ────────────────────────────────────────────────────
  describe('notifyUser', () => {
    it('writes an IN_APP feed row AND a QUEUED PUSH row, folding event + url into variables', async () => {
      await service.notifyUser({ userId: 'u1', event: 'X', subject: 'S', body: 'B', url: '/p', variables: { a: 1 } });
      const inApp = fake.rows.find((r) => r.channel === 'IN_APP')!;
      const push = fake.rows.find((r) => r.channel === 'PUSH')!;
      expect(inApp.status).toBe('SENT');
      expect(push.status).toBe('QUEUED');
      expect(inApp.variables).toEqual({ event: 'X', a: 1, url: '/p' });
      expect(push.variables).toEqual({ event: 'X', a: 1, url: '/p' });
    });

    it('does not throw when the PUSH enqueue fails (best-effort)', async () => {
      // first create (IN_APP) ok, second create (PUSH) throws
      const spy = jest.spyOn(fake, 'create');
      spy.mockImplementationOnce((args: any) => FakeQueue.prototype.create.call(fake, args));
      spy.mockRejectedValueOnce(new Error('push db down'));
      await expect(service.notifyUser({ userId: 'u1', body: 'B' })).resolves.toBeUndefined();
    });
  });

  // ── feed: seed helper ───────────────────────────────────────────────────────
  const seed = (userId: string, body: string, opts: Partial<Row> = {}) =>
    fake.create({
      data: {
        userId,
        channel: 'IN_APP',
        status: 'SENT',
        body,
        subject: opts.subject ?? null,
        variables: opts.variables ?? null,
        readAt: opts.readAt ?? null,
        createdAt: opts.createdAt ?? new Date(),
        processedAt: new Date(),
      },
      select: { id: true },
    });

  // ── listFeed ────────────────────────────────────────────────────────────────
  describe('listFeed', () => {
    it('returns only the calling user IN_APP rows, newest first (ownership isolation)', async () => {
      await seed('userA', 'a1', { createdAt: new Date('2026-01-01') });
      await seed('userA', 'a2', { createdAt: new Date('2026-01-02') });
      await seed('userB', 'b1', { createdAt: new Date('2026-01-03') });
      // A PUSH row for userA must never appear in the feed.
      await fake.create({ data: { userId: 'userA', channel: 'PUSH', status: 'QUEUED', body: 'push', createdAt: new Date('2026-01-04') }, select: { id: true } });

      const page = await service.listFeed('userA', undefined, 25);
      expect(page.items.map((i) => i.body)).toEqual(['a2', 'a1']);
      expect(page.nextCursor).toBeNull();
    });

    it('paginates with a stable cursor across pages', async () => {
      for (let i = 1; i <= 5; i++) {
        await seed('userA', `n${i}`, { createdAt: new Date(`2026-02-0${i}`) });
      }
      const p1 = await service.listFeed('userA', undefined, 2);
      expect(p1.items.map((i) => i.body)).toEqual(['n5', 'n4']);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await service.listFeed('userA', p1.nextCursor!, 2);
      expect(p2.items.map((i) => i.body)).toEqual(['n3', 'n2']);
      expect(p2.nextCursor).not.toBeNull();

      const p3 = await service.listFeed('userA', p2.nextCursor!, 2);
      expect(p3.items.map((i) => i.body)).toEqual(['n1']);
      expect(p3.nextCursor).toBeNull();
    });

    it('surfaces the deep-link url from variables and defaults limit past the cap', async () => {
      await seed('userA', 'a1', { variables: { url: '/deep' } });
      const page = await service.listFeed('userA', undefined, 999);
      expect(page.items[0].url).toBe('/deep');
    });

    it('a malformed cursor pages from the top rather than erroring', async () => {
      await seed('userA', 'a1');
      const page = await service.listFeed('userA', 'not-a-real-cursor', 25);
      expect(page.items).toHaveLength(1);
    });
  });

  // ── unreadCount ───────────────────────────────────────────────────────────--
  describe('unreadCount', () => {
    it('counts only unread IN_APP rows for the caller', async () => {
      await seed('userA', 'unread1');
      await seed('userA', 'unread2');
      await seed('userA', 'read', { readAt: new Date() });
      await seed('userB', 'other-unread');

      expect(await service.unreadCount('userA')).toEqual({ count: 2 });
      expect(await service.unreadCount('userB')).toEqual({ count: 1 });
    });
  });

  // ── markRead ──────────────────────────────────────────────────────────────--
  describe('markRead', () => {
    it('marks an owned unread row read and returns its readAt', async () => {
      const { id } = await seed('userA', 'a1');
      const res = await service.markRead('userA', id);
      expect(res.id).toBe(id);
      expect(res.readAt).toBeInstanceOf(Date);
      expect(fake.rows.find((r) => r.id === id)!.readAt).toBeInstanceOf(Date);
    });

    it('is idempotent: a second mark-read keeps the original readAt', async () => {
      const { id } = await seed('userA', 'a1');
      const first = await service.markRead('userA', id);
      const second = await service.markRead('userA', id);
      expect(second.readAt).toEqual(first.readAt);
    });

    it("404s when the row belongs to another user and does NOT mutate it (isolation)", async () => {
      const { id } = await seed('userB', 'b1');
      const updateSpy = jest.spyOn(fake, 'update');
      await expect(service.markRead('userA', id)).rejects.toBeInstanceOf(NotFoundException);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(fake.rows.find((r) => r.id === id)!.readAt).toBeNull();
    });

    it('404s when the row does not exist', async () => {
      await expect(service.markRead('userA', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── markAllRead ─────────────────────────────────────────────────────────────
  describe('markAllRead', () => {
    it('marks all the caller unread rows read and reports the count, leaving others alone', async () => {
      await seed('userA', 'a1');
      await seed('userA', 'a2');
      await seed('userA', 'a3', { readAt: new Date() }); // already read → not counted
      const bRow = await seed('userB', 'b1');

      const res = await service.markAllRead('userA');
      expect(res).toEqual({ updated: 2 });
      expect(await service.unreadCount('userA')).toEqual({ count: 0 });
      // userB's row untouched (isolation).
      expect(fake.rows.find((r) => r.id === bRow.id)!.readAt).toBeNull();
    });
  });

  // ── notifyUserWithChannels (config-driven paid-channel fan-out) ───────────────
  describe('notifyUserWithChannels', () => {
    // Build a service wired to a stub templates resolver + msg91 mock. `templates` is set
    // directly (onModuleInit is not triggered by TestingModule.compile()).
    function makeFanout(cfg: ResolvedChannelConfig) {
      const q = new FakeQueue();
      const msg91 = { sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined), sendSms: jest.fn() };
      const templates = { getChannelConfig: jest.fn().mockResolvedValue(cfg) };
      const svc = new NotificationsService(
        { notificationQueue: q } as unknown as PrismaService,
        msg91 as unknown as Msg91Service,
        {} as never,
      );
      (svc as unknown as { templates: unknown }).templates = templates;
      return { svc, q, msg91, templates };
    }

    // POINTS_CREDITED contract → whatsapp [ownerName, pointsCredited, redeemableBalance, monthYear,
    // dateCredited]; sms [ownerName, pointsCredited, redeemableBalance].
    const baseVars = {
      ownerName: 'Asha',
      pointsCredited: 120,
      redeemableBalance: 500,
      monthYear: 'July 2026',
      dateCredited: '06 Jul 2026',
    };
    const call = (svc: NotificationsService, extra: Record<string, unknown> = {}) =>
      svc.notifyUserWithChannels({
        clientId: 'deoleo',
        userId: 'u1',
        eventKey: 'POINTS_CREDITED',
        recipientPhone: '9990000001',
        vars: baseVars,
        subject: 'Points credited',
        body: 'You earned 120 points.',
        url: '/partner/wallet',
        ...extra,
      });

    const cfg = (o: Partial<ResolvedChannelConfig>): ResolvedChannelConfig => ({
      mode: 'OFF',
      whatsappTemplate: 'deoleo_points_credit',
      smsTemplateId: 'sms-tpl-1',
      masterSms: false,
      masterWhatsapp: false,
      ...o,
    });

    it('always writes the free channels (IN_APP + PUSH) regardless of paid config', async () => {
      const { svc, q } = makeFanout(cfg({ mode: 'OFF' }));
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'IN_APP')).toBe(true);
      expect(q.rows.some((r) => r.channel === 'PUSH')).toBe(true);
    });

    it('OFF → no SMS row, no WhatsApp send (even with masters + templates on)', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'OFF', masterSms: true, masterWhatsapp: true }));
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('SMS + masterSms → enqueues an SMS row with the template id and mapped named vars; no WhatsApp', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'SMS', masterSms: true, masterWhatsapp: true }));
      await call(svc);
      const sms = q.rows.find((r) => r.channel === 'SMS');
      expect(sms).toBeDefined();
      expect(sms!.status).toBe('QUEUED');
      // SMS contract for POINTS_CREDITED → ownerName, pointsCredited, redeemableBalance (as strings).
      expect(sms!.variables).toEqual({ ownerName: 'Asha', pointsCredited: '120', redeemableBalance: '500' });
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('WHATSAPP + masterWhatsapp → sends the WhatsApp template with ordered values; no SMS row', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'WHATSAPP', masterSms: true, masterWhatsapp: true }));
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledWith('9990000001', 'deoleo_points_credit', [
        'Asha',
        '120',
        '500',
        'July 2026',
        '06 Jul 2026',
      ]);
    });

    it('BOTH + both masters → enqueues SMS AND sends WhatsApp', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true }));
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(true);
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    });

    it('master OFF gates the channel even when the mode selects it', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'BOTH', masterSms: false, masterWhatsapp: false }));
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('blank template → that channel is skipped', async () => {
      const { svc, q, msg91 } = makeFanout(
        cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true, smsTemplateId: '', whatsappTemplate: '' }),
      );
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('missing phone → paid channels skipped, free channels still written', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true }));
      await call(svc, { recipientPhone: null });
      expect(q.rows.some((r) => r.channel === 'IN_APP')).toBe(true);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('includeFreeChannels:false → paid channels only (no IN_APP/PUSH)', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'WHATSAPP', masterWhatsapp: true }));
      await call(svc, { includeFreeChannels: false });
      expect(q.rows.some((r) => r.channel === 'IN_APP')).toBe(false);
      expect(q.rows.some((r) => r.channel === 'PUSH')).toBe(false);
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    });

    it('a thrown WhatsApp send never rejects the caller (fail-safe)', async () => {
      const { svc, msg91 } = makeFanout(cfg({ mode: 'WHATSAPP', masterWhatsapp: true }));
      (msg91.sendWhatsappTemplate as jest.Mock).mockRejectedValueOnce(new Error('MSG91 down'));
      await expect(call(svc)).resolves.toBeUndefined();
    });

    it('no templates resolver wired → paid channels skipped, free channels still written', async () => {
      const { svc, q, msg91 } = makeFanout(cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true }));
      (svc as unknown as { templates: unknown }).templates = null;
      await call(svc);
      expect(q.rows.some((r) => r.channel === 'IN_APP')).toBe(true);
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('null resolver + a WhatsApp-defaults-on tenant/event → logs at ERROR (silent live dark-out is observable)', async () => {
      // deoleo is a WHATSAPP_KYC tenant; POINTS_CREDITED defaults to WhatsApp-on. With a null
      // resolver the paid WhatsApp is silently skipped — that is a LIVE dark-out, so it MUST surface
      // at error level (with tenant + event). Behaviour otherwise identical (no throw, free written).
      const { svc } = makeFanout(cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true }));
      (svc as unknown as { templates: unknown }).templates = null;
      const errorSpy = jest
        .spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      await call(svc); // clientId 'deoleo', eventKey POINTS_CREDITED, phone present
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/deoleo/);
      expect(errorSpy.mock.calls[0][0]).toMatch(/POINTS_CREDITED/);
    });

    it('null resolver + a NON-WhatsApp tenant → no ERROR (nothing was going to fire)', async () => {
      // acme is not a WHATSAPP_KYC tenant → defaults are all OFF → no live channel to dark → no error.
      const { svc } = makeFanout(cfg({ mode: 'BOTH', masterSms: true, masterWhatsapp: true }));
      (svc as unknown as { templates: unknown }).templates = null;
      const errorSpy = jest
        .spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      await call(svc, { clientId: 'acme' });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    // ── DEOLEO PRESERVATION (end-to-end): the REAL resolver + fan-out, no DB row ──
    it('deoleo KYC_APPROVED with NO stored config still fires WhatsApp deoleo_kyc_approval [ownerName, programName]; SMS stays OFF', async () => {
      const q = new FakeQueue();
      const msg91 = { sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined), sendSms: jest.fn() };
      // REAL resolver over a prisma that returns NO stored row → the typed defaults apply.
      const prismaForTemplates = { programSetting: { findUnique: jest.fn().mockResolvedValue(null) } };
      const templates = new NotificationTemplatesService(
        prismaForTemplates as unknown as PrismaService,
        { upsertSetting: jest.fn() } as unknown as AdminCoreService,
      );
      const svc = new NotificationsService(
        { notificationQueue: q } as unknown as PrismaService,
        msg91 as unknown as Msg91Service,
        {} as never,
      );
      (svc as unknown as { templates: unknown }).templates = templates;

      await svc.notifyUserWithChannels({
        clientId: 'deoleo',
        userId: 'u1',
        eventKey: 'KYC_APPROVED',
        recipientPhone: '9000000001',
        vars: { ownerName: 'Acme Owner', programName: 'Olive Oil' },
        subject: 'KYC approved',
        body: 'Your KYC is approved.',
        url: '/sales/kyc',
      });

      // The live approval WhatsApp is preserved exactly (template + ordered body values).
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
      expect(msg91.sendWhatsappTemplate).toHaveBeenCalledWith('9000000001', 'deoleo_kyc_approval', [
        'Acme Owner',
        'Olive Oil',
      ]);
      // SMS is OFF by default (new channel) → no SMS row enqueued.
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
      // Free channels still written.
      expect(q.rows.some((r) => r.channel === 'IN_APP')).toBe(true);
    });

    it('a NON-WHATSAPP_KYC tenant KYC_APPROVED with no config sends NOTHING paid (all default OFF)', async () => {
      const q = new FakeQueue();
      const msg91 = { sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined), sendSms: jest.fn() };
      const prismaForTemplates = { programSetting: { findUnique: jest.fn().mockResolvedValue(null) } };
      const templates = new NotificationTemplatesService(
        prismaForTemplates as unknown as PrismaService,
        { upsertSetting: jest.fn() } as unknown as AdminCoreService,
      );
      const svc = new NotificationsService(
        { notificationQueue: q } as unknown as PrismaService,
        msg91 as unknown as Msg91Service,
        {} as never,
      );
      (svc as unknown as { templates: unknown }).templates = templates;

      await svc.notifyUserWithChannels({
        clientId: 'acme',
        userId: 'u1',
        eventKey: 'KYC_APPROVED',
        recipientPhone: '9000000001',
        vars: { ownerName: 'A', programName: 'P' },
        body: 'Your KYC is approved.',
      });

      expect(msg91.sendWhatsappTemplate).not.toHaveBeenCalled();
      expect(q.rows.some((r) => r.channel === 'SMS')).toBe(false);
    });
  });
});
