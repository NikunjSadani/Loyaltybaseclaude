import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MAX_ATTEMPTS, OPS_ALERT_FALLBACK, PayoutTrackerSender, STALE_PENDING_MS, XLSX_CONTENT_TYPE, istParts } from './payout-tracker.sender';
import type { TrackerPack } from './payout-tracker.generate';

/** IST wall-clock → UTC instant. */
const ist = (isoLocal: string) => new Date(new Date(`${isoLocal}Z`).getTime() - 330 * 60_000);
const FRI_1005 = ist('2026-11-27T10:05:00'); // Friday
const FRI_0955 = ist('2026-11-27T09:55:00');
const SUN_1100 = ist('2026-11-29T11:00:00');

type RunRow = { id: string; clientId: string; reportKey: string; runDate: string; status: string; attempts: number; updatedAt: Date; error?: string | null; month?: string | null; recipients?: string[]; fileName?: string };

function makeWorld(opts: {
  settings?: Array<{ clientId: string; settingValue: unknown }>;
  clients?: Array<{ id: string; status: string; internalName: string }>;
  salesMonths?: string[];
  holidays?: Array<{ date: string; label: string }>;
  digest?: string[];
} = {}) {
  const runs: RunRow[] = [];
  let seq = 0;
  const settings = opts.settings ?? [{ clientId: 'bajaj', settingValue: { enabled: true, recipients: ['a@bajaj.com'], cc: ['c@bajaj.com'] } }];
  const clients = opts.clients ?? [{ id: 'bajaj', status: 'ACTIVE', internalName: 'Bajaj' }];
  const prisma = {
    programSetting: {
      findMany: jest.fn(async ({ where }: { where: { settingKey: string } }) => (where.settingKey === 'payoutTracker' ? settings : [])),
      findFirst: jest.fn(async ({ where }: { where: { clientId: string; settingKey: string } }) => {
        if (where.settingKey === 'nationalHolidays') return opts.holidays ? { settingValue: opts.holidays } : null;
        if (where.settingKey === 'reportRecipients') return opts.digest ? { settingValue: { dailyDigest: opts.digest } } : null;
        if (where.settingKey === 'payoutTracker') {
          const s = settings.find((x) => x.clientId === where.clientId);
          return s ? { settingValue: s.settingValue } : null;
        }
        return null;
      }),
    },
    client: {
      findMany: jest.fn(async () => clients),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => clients.find((c) => c.id === where.id) ?? null),
    },
    outletSalesRecord: {
      findFirst: jest.fn(async ({ where }: { where: { month: string } }) => ((opts.salesMonths ?? ['2026-11']).includes(where.month) ? { id: 'r' } : null)),
    },
    tenantReportRun: {
      create: jest.fn(async ({ data }: { data: Omit<RunRow, 'id' | 'attempts' | 'updatedAt'> }) => {
        if (runs.some((r) => r.clientId === data.clientId && r.reportKey === data.reportKey && r.runDate === data.runDate)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        const row: RunRow = { ...data, id: `run${++seq}`, attempts: 1, updatedAt: new Date() };
        runs.push(row);
        return { id: row.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { clientId_reportKey_runDate: { clientId: string; reportKey: string; runDate: string } } }) => {
        const k = where.clientId_reportKey_runDate;
        return runs.find((r) => r.clientId === k.clientId && r.reportKey === k.reportKey && r.runDate === k.runDate) ?? null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Partial<RunRow>; data: Record<string, unknown> }) => {
        const r = runs.find((x) => x.id === where.id && x.status === where.status && (where.attempts === undefined || x.attempts === where.attempts) && (where.updatedAt === undefined || x.updatedAt === where.updatedAt));
        if (!r) return { count: 0 };
        apply(r, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = runs.find((x) => x.id === where.id)!;
        apply(r, data);
        return r;
      }),
    },
  };
  function apply(r: RunRow, data: Record<string, unknown>) {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'attempts' && v && typeof v === 'object') r.attempts += (v as { increment: number }).increment;
      else (r as Record<string, unknown>)[k] = v;
    }
    r.updatedAt = new Date();
  }
  const sendEmail = jest.fn().mockResolvedValue({ skipped: false, accepted: [], rejected: [] });
  const source = { buildInput: jest.fn().mockResolvedValue({ clientName: 'Bajaj Consumer Care', month: '2026-11' }) };
  const pack: TrackerPack = {
    rows: { retail: [], ws: [], exceptions: [] },
    summary: {} as TrackerPack['summary'],
    workbook: Buffer.from('xlsx'),
    fileName: 'Bajaj-Payout-Tracker-2026-11-PROVISIONAL.xlsx',
    email: { subject: 'Bajaj Loyalty — Payout tracker', html: '<p>h</p>', text: 't' },
  };
  const sender = new PayoutTrackerSender(prisma as never, { sendEmail } as never, source);
  sender.env = { PAYOUT_TRACKER_EMAIL_LIVE: 'true' };
  sender.generate = jest.fn().mockResolvedValue(pack);
  return { sender, prisma, runs, sendEmail, source, pack };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('istParts', () => {
  it('IST date / ISO weekday / HH:mm (incl. the 00:00–05:30 IST window)', () => {
    expect(istParts(FRI_1005)).toEqual({ date: '2026-11-27', isoWeekday: 5, hhmm: '10:05' });
    expect(istParts(SUN_1100).isoWeekday).toBe(7);
    expect(istParts(new Date('2026-11-30T19:00:00Z'))).toEqual({ date: '2026-12-01', isoWeekday: 2, hhmm: '00:30' });
  });
});

describe('PayoutTrackerSender.runDue', () => {
  it('no enabled tenant (Deoleo: no row / disabled) → nothing read beyond settings, no row, no email', async () => {
    const w = makeWorld({ settings: [{ clientId: 'deoleo', settingValue: { enabled: false, recipients: ['x@deoleo.com'] } }] });
    expect(await w.sender.runDue(FRI_1005)).toEqual({ runDate: '2026-11-27', outcomes: [] });
    expect(w.prisma.client.findMany).not.toHaveBeenCalled();
    expect(w.prisma.tenantReportRun.create).not.toHaveBeenCalled();
    expect(w.sendEmail).not.toHaveBeenCalled();
  });

  it('due → claims the day, builds the current month, sends html + text + xlsx to to/cc, records SENT', async () => {
    const w = makeWorld();
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes).toEqual([{ clientId: 'bajaj', status: 'sent', month: '2026-11', recipients: ['a@bajaj.com', 'c@bajaj.com'] }]);
    expect(w.source.buildInput).toHaveBeenCalledWith('bajaj', '2026-11', FRI_1005);
    expect(w.sendEmail).toHaveBeenCalledTimes(1);
    expect(w.sendEmail).toHaveBeenCalledWith({
      to: ['a@bajaj.com'],
      cc: ['c@bajaj.com'],
      subject: 'Bajaj Loyalty — Payout tracker',
      html: '<p>h</p>',
      text: 't',
      attachments: [{ filename: 'Bajaj-Payout-Tracker-2026-11-PROVISIONAL.xlsx', content: w.pack.workbook, contentType: XLSX_CONTENT_TYPE }],
      detectAmbiguousDelivery: true,
    });
    expect(w.runs).toEqual([
      expect.objectContaining({ clientId: 'bajaj', reportKey: 'payout-tracker', runDate: '2026-11-27', status: 'SENT', month: '2026-11', fileName: 'Bajaj-Payout-Tracker-2026-11-PROVISIONAL.xlsx', recipients: ['a@bajaj.com', 'c@bajaj.com'], error: null }),
    ]);
  });

  it('data-loader notes are carried on the outcome (never dropped)', async () => {
    const w = makeWorld();
    w.source.buildInput.mockResolvedValue({ month: '2026-11', notes: [{ audience: 'ops', text: '3 outlet codes not in the master' }] });
    expect((await w.sender.runDue(FRI_1005)).outcomes[0].notes).toEqual(['3 outlet codes not in the master']);
  });

  it('A3: data notes → an ops heads-up email AFTER the client email (internal recipients only), never blocking it', async () => {
    const w = makeWorld({ digest: ['ops@gifsy.in', 'x@acme.com'] });
    w.source.buildInput.mockResolvedValue({
      clientName: 'Bajaj Consumer Care',
      month: '2026-11',
      notes: [
        { audience: 'ops', text: '3 outlet codes <x> not in the master' },
        { audience: 'client', text: 'Bonus not computed: Oct imported' },
      ],
    });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('sent');
    expect(w.sendEmail).toHaveBeenCalledTimes(2);
    expect(w.sendEmail.mock.calls[0][0].to).toEqual(['a@bajaj.com']); // the client email first
    const heads = w.sendEmail.mock.calls[1][0];
    expect(heads.to).toEqual(['ops@gifsy.in']);
    expect(heads.subject).toBe('Payout tracker Bajaj Consumer Care 2026-11: 2 data note(s)');
    // EVERYTHING goes to ops, each labelled with who else saw it.
    expect(heads.html).toContain('[ops only] 3 outlet codes &lt;x&gt; not in the master');
    expect(heads.html).toContain('[also shown to the client] Bonus not computed: Oct imported');
    expect(heads).not.toHaveProperty('attachments');

    // The heads-up failing never fails / un-sends the run — it is reported on the outcome.
    const w2 = makeWorld();
    w2.source.buildInput.mockResolvedValue({ month: '2026-11', notes: [{ audience: 'ops', text: 'n1' }, { audience: 'client', text: 'n2' }] });
    w2.sendEmail.mockResolvedValueOnce({ skipped: false, accepted: [], rejected: [] }).mockRejectedValueOnce(new Error('relay down'));
    const r2 = await w2.sender.runDue(FRI_1005);
    expect(r2.outcomes[0]).toEqual(expect.objectContaining({ status: 'sent', alertError: expect.stringMatching(/relay down/) }));
    expect(w2.runs[0].status).toBe('SENT');
    expect(w2.sendEmail.mock.calls[1][0].subject).toBe('Payout tracker Bajaj 2026-11: 2 data note(s)');

    // No notes → no heads-up.
    const w3 = makeWorld();
    await w3.sender.runDue(FRI_1005);
    expect(w3.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('A6: SMTP lost AFTER the message was handed over (ambiguous) → FAILED, never auto-resent, alert says it may have gone', async () => {
    const w = makeWorld();
    const amb = Object.assign(new Error('Failed to send email "S": Timeout'), { deliveryAmbiguous: true });
    w.sendEmail.mockRejectedValueOnce(amb).mockResolvedValue({ skipped: false, accepted: [], rejected: [] });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(r.outcomes[0].error).toMatch(/MAY have been delivered/);
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    const alert = w.sendEmail.mock.calls[1][0];
    expect(alert.subject).toBe('Bajaj payout tracker: delivery UNCERTAIN — check before resending');
    expect(alert.html).toMatch(/check before resending/i);
    expect((await w.sender.runDue(ist('2026-11-27T10:20:00'))).outcomes[0].status).toBe('already-done');
    expect(w.sendEmail).toHaveBeenCalledTimes(2); // never re-sent
  });

  it('before the send time / not a configured day → not-due, no row', async () => {
    const w = makeWorld();
    expect((await w.sender.runDue(FRI_0955)).outcomes[0].status).toBe('not-due');
    expect((await w.sender.runDue(SUN_1100)).outcomes[0].status).toBe('not-due'); // default days Mon–Sat
    expect(w.runs).toHaveLength(0);
    const w2 = makeWorld({ settings: [{ clientId: 'bajaj', settingValue: { enabled: true, recipients: ['a@b.com'], days: [7], sendTimeIst: '10:30' } }] });
    expect((await w2.sender.runDue(SUN_1100)).outcomes[0].status).toBe('sent');
    expect((await w2.sender.runDue(FRI_1005)).outcomes[0].status).toBe('not-due');
  });

  it('idempotent: a second hit the same day (sequential or concurrent) never sends again', async () => {
    const w = makeWorld();
    await w.sender.runDue(FRI_1005);
    expect((await w.sender.runDue(ist('2026-11-27T10:20:00'))).outcomes[0].status).toBe('already-done');
    expect(w.sendEmail).toHaveBeenCalledTimes(1);

    const w2 = makeWorld();
    const [a, b] = await Promise.all([w2.sender.runDue(FRI_1005), w2.sender.runDue(FRI_1005)]);
    expect([a.outcomes[0].status, b.outcomes[0].status].sort()).toEqual(['already-done', 'sent']);
    expect(w2.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('month fallback: no applied sales for the current IST month yet → previous month', async () => {
    const w = makeWorld({ salesMonths: ['2026-11'] });
    await w.sender.runDue(ist('2026-12-01T10:00:00'));
    expect(w.source.buildInput).toHaveBeenCalledWith('bajaj', '2026-11', expect.any(Date));
    expect(w.runs[0].month).toBe('2026-11');
  });

  it('holiday: sendOnHolidays=false → SKIPPED row, no email; default (true) → sent', async () => {
    const holidays = [{ date: '2026-11-27', label: 'Test holiday' }];
    const w = makeWorld({ holidays, settings: [{ clientId: 'bajaj', settingValue: { enabled: true, recipients: ['a@b.com'], sendOnHolidays: false } }] });
    expect((await w.sender.runDue(FRI_1005)).outcomes[0]).toEqual({ clientId: 'bajaj', status: 'skipped', error: 'national holiday' });
    expect(w.runs[0].status).toBe('SKIPPED');
    expect(w.sendEmail).not.toHaveBeenCalled();
    const w2 = makeWorld({ holidays });
    expect((await w2.sender.runDue(FRI_1005)).outcomes[0].status).toBe('sent');
  });

  it('A2: environment guard off → ops alert ONCE a day, the day is NOT consumed (sends after the env is fixed)', async () => {
    const w = makeWorld({ digest: ['ops@gifsy.in'] });
    w.sender.env = {};
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0]).toEqual(expect.objectContaining({ status: 'skipped', error: expect.stringMatching(/disabled in this environment/) }));
    expect(w.sendEmail).toHaveBeenCalledTimes(1); // the alert, not the report
    expect(w.sendEmail.mock.calls[0][0].to).toEqual(['ops@gifsy.in']);
    expect(w.sendEmail.mock.calls[0][0].subject).toBe('payout tracker for Bajaj NOT sent: email delivery disabled in this environment');
    expect(w.source.buildInput).not.toHaveBeenCalled();
    expect(w.runs.filter((x) => x.reportKey === 'payout-tracker')).toHaveLength(0); // day not claimed
    expect(w.runs.find((x) => x.reportKey === 'payout-tracker-blocked')).toEqual(expect.objectContaining({ status: 'SKIPPED', runDate: '2026-11-27' }));

    // Next hit, still off → no second alert.
    await w.sender.runDue(ist('2026-11-27T10:20:00'));
    expect(w.sendEmail).toHaveBeenCalledTimes(1);

    // Env fixed the same day → the report goes.
    w.sender.env = { PAYOUT_TRACKER_EMAIL_LIVE: 'true' };
    expect((await w.sender.runDue(ist('2026-11-27T10:35:00'))).outcomes[0].status).toBe('sent');
    expect(w.runs.find((x) => x.reportKey === 'payout-tracker')).toEqual(expect.objectContaining({ status: 'SENT' }));
  });

  it('environment guard: test → ONE internal address, subject names the real recipients', async () => {

    const t = makeWorld();
    t.sender.env = { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'qa@gifsy.in' };
    await t.sender.runDue(FRI_1005);
    const arg = t.sendEmail.mock.calls[0][0];
    expect(arg.to).toEqual(['qa@gifsy.in']);
    expect(arg).not.toHaveProperty('cc');
    expect(arg.subject).toBe('[TEST — would go to a@bajaj.com; cc c@bajaj.com] Bajaj Loyalty — Payout tracker');
  });

  it('failure (build throws) → FAILED row with the error + loud alert to the internal digest recipients; retried later up to MAX_ATTEMPTS', async () => {
    const w = makeWorld({ digest: ['ops@gifsy.in', 'cfo@acme.com'] });
    w.source.buildInput.mockRejectedValue(new Error('engine exploded'));
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0]).toEqual(expect.objectContaining({ status: 'failed', error: 'could not build the 2026-11 report: engine exploded' }));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', error: 'could not build the 2026-11 report: engine exploded', attempts: 1 }));
    expect(w.sendEmail).toHaveBeenCalledTimes(1); // the alert only
    const alert = w.sendEmail.mock.calls[0][0];
    expect(alert.to).toEqual(['ops@gifsy.in']); // non-internal digest address dropped
    expect(alert.subject).toBe('Bajaj payout tracker NOT sent: could not build the 2026-11 report: engine exploded');
    expect(alert).not.toHaveProperty('attachments');

    // Next scheduler hits retry the day (attempts 2, 3) then stop.
    await w.sender.runDue(ist('2026-11-27T10:20:00'));
    await w.sender.runDue(ist('2026-11-27T10:35:00'));
    expect(w.runs[0].attempts).toBe(MAX_ATTEMPTS);
    expect((await w.sender.runDue(ist('2026-11-27T10:50:00'))).outcomes[0].status).toBe('already-done');
    expect(w.source.buildInput).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    // Recovered on a retry → SENT.
    const w2 = makeWorld();
    w2.source.buildInput.mockRejectedValueOnce(new Error('blip'));
    await w2.sender.runDue(FRI_1005);
    expect((await w2.sender.runDue(ist('2026-11-27T10:20:00'))).outcomes[0].status).toBe('sent');
    expect(w2.runs[0]).toEqual(expect.objectContaining({ status: 'SENT', attempts: 2, error: null }));
  });

  it('SMTP send throws → FAILED + alert (fallback ops address when no digest recipients)', async () => {
    const w = makeWorld();
    w.sendEmail.mockRejectedValueOnce(new Error('552 message too large')).mockResolvedValue({ skipped: false, accepted: [], rejected: [] });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(w.runs[0].error).toBe('email send failed: 552 message too large');
    expect(w.sendEmail.mock.calls[1][0].to).toEqual([OPS_ALERT_FALLBACK]);
  });

  it('SMTP unconfigured (sendEmail skipped) is a FAILURE, not a silent success — no auto-retry', async () => {
    const w = makeWorld();
    w.sendEmail.mockResolvedValue({ skipped: true, accepted: [], rejected: [] });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0]).toEqual(expect.objectContaining({ status: 'failed', alertError: 'alert not sent: SMTP not configured' }));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
  });

  it('partial relay reject → SENT with the rejected list recorded + alert', async () => {
    const w = makeWorld();
    w.sendEmail.mockResolvedValueOnce({ skipped: false, accepted: ['a@bajaj.com'], rejected: ['c@bajaj.com'] });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0]).toEqual(expect.objectContaining({ status: 'sent', error: 'relay REJECTED c@bajaj.com' }));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'SENT', error: 'relay REJECTED c@bajaj.com' }));
    expect(w.sendEmail.mock.calls[1][0].subject).toBe('Bajaj payout tracker: some recipients NOT reached');
  });

  it('enabled but invalid config → FAILED (no retry) + alert, once a day on the default schedule', async () => {
    const w = makeWorld({ settings: [{ clientId: 'bajaj', settingValue: { enabled: true, recipients: ['nope'] } }] });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0]).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringMatching(/not a valid email/) }));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    expect(w.source.buildInput).not.toHaveBeenCalled();
    expect(w.sendEmail).toHaveBeenCalledTimes(1); // alert
    expect((await w.sender.runDue(ist('2026-11-27T11:00:00'))).outcomes[0].status).toBe('already-done');
  });

  it('a non-internal test recipient env value → FAILED + alert, never used', async () => {
    const w = makeWorld();
    w.sender.env = { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'boss@bajaj.com' };
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(w.sendEmail).toHaveBeenCalledTimes(1);
    expect(w.sendEmail.mock.calls[0][0].to).toEqual([OPS_ALERT_FALLBACK]);
  });

  it('a PENDING row older than 30 min (process died mid-send) → FAILED, no auto-retry, alert says it may have gone', async () => {
    const w = makeWorld();
    w.runs.push({ id: 'old', clientId: 'bajaj', reportKey: 'payout-tracker', runDate: '2026-11-27', status: 'PENDING', attempts: 1, updatedAt: new Date(FRI_1005.getTime() - STALE_PENDING_MS - 1) });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    expect(w.sendEmail.mock.calls[0][0].subject).toMatch(/NOT sent: the previous attempt was interrupted/);
    expect(w.source.buildInput).not.toHaveBeenCalled();
  });

  it('a fresh PENDING row (another hit is sending right now) → already-done', async () => {
    const w = makeWorld();
    w.runs.push({ id: 'p', clientId: 'bajaj', reportKey: 'payout-tracker', runDate: '2026-11-27', status: 'PENDING', attempts: 1, updatedAt: new Date(FRI_1005.getTime() - 60_000) });
    expect((await w.sender.runDue(FRI_1005)).outcomes[0].status).toBe('already-done');
    expect(w.sendEmail).not.toHaveBeenCalled();
  });

  it('email sent but recording SENT fails → FAILED with no retry (never double-sends)', async () => {
    const w = makeWorld();
    w.prisma.tenantReportRun.update.mockRejectedValueOnce(new Error('db blip'));
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].error).toMatch(/^the email WAS sent/);
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    expect(w.sendEmail.mock.calls[1][0].subject).toBe('Bajaj payout tracker: sent but the run was NOT recorded');
  });

  it('A4: inactive / missing client with an enabled config → FAILED outcome + ops alert once a day; never blocks another tenant', async () => {
    const w = makeWorld({
      settings: [
        { clientId: 'gone', settingValue: { enabled: true, recipients: ['a@b.com'] } },
        { clientId: 'ghost', settingValue: { enabled: true, recipients: ['a@b.com'] } },
        { clientId: 'bad', settingValue: { enabled: true, recipients: ['a@b.com'] } },
        { clientId: 'bajaj', settingValue: { enabled: true, recipients: ['a@bajaj.com'] } },
      ],
      clients: [
        { id: 'gone', status: 'INACTIVE', internalName: 'Gone' },
        { id: 'bad', status: 'ACTIVE', internalName: 'Bad' },
        { id: 'bajaj', status: 'ACTIVE', internalName: 'Bajaj' },
      ],
    });
    w.source.buildInput.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return {};
    });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes.map((o) => [o.clientId, o.status])).toEqual([['gone', 'failed'], ['ghost', 'failed'], ['bad', 'failed'], ['bajaj', 'sent']]);
    expect(r.outcomes[0].error).toMatch(/client is INACTIVE/);
    expect(r.outcomes[1].error).toMatch(/client is missing/);
    expect(w.runs.filter((x) => x.reportKey === 'payout-tracker').map((x) => x.clientId)).toEqual(['bad', 'bajaj']);
    const subjects = w.sendEmail.mock.calls.map((c) => c[0].subject as string);
    expect(subjects.filter((s) => /Gone/.test(s))).toHaveLength(1);
    expect(subjects.filter((s) => /ghost/.test(s))).toHaveLength(1);

    // Later hit the same day → still FAILED (loud on the scheduler), but no second alert.
    const before = w.sendEmail.mock.calls.length;
    const r2 = await w.sender.runDue(ist('2026-11-27T10:20:00'));
    expect(r2.outcomes[0].status).toBe('failed');
    const newSubjects = w.sendEmail.mock.calls.slice(before).map((c) => c[0].subject as string);
    expect(newSubjects.some((s) => /Gone|ghost/.test(s))).toBe(false);
  });
});

describe('PayoutTrackerSender.sendNow', () => {
  it('explicit INTERNAL recipients → sent to exactly them (even with the environment guard off) + a manual run row', async () => {
    const w = makeWorld();
    w.sender.env = {};
    const r = await w.sender.sendNow('bajaj', '2026-10', ['QA@Gifsy.in'], FRI_1005);
    expect(r).toEqual(expect.objectContaining({ month: '2026-10', to: ['qa@gifsy.in'], cc: [], subject: 'Bajaj Loyalty — Payout tracker' }));
    expect(w.source.buildInput).toHaveBeenCalledWith('bajaj', '2026-10', expect.any(Date));
    expect(w.sendEmail.mock.calls[0][0]).toEqual(expect.objectContaining({ to: ['qa@gifsy.in'], attachments: expect.any(Array) }));
    expect(w.runs).toEqual([
      expect.objectContaining({ clientId: 'bajaj', reportKey: 'payout-tracker-manual', status: 'SENT', month: '2026-10', recipients: ['qa@gifsy.in'], runDate: expect.stringMatching(/^2026-11-27 10:05:00\.000/) }),
    ]);
    // A second manual send the same millisecond still gets its own row (never blocked, never untraced).
    await w.sender.sendNow('bajaj', '2026-10', ['qa@gifsy.in'], FRI_1005);
    expect(w.runs.filter((x) => x.reportKey === 'payout-tracker-manual')).toHaveLength(2);
    // The scheduled day is untouched.
    expect(w.runs.some((x) => x.reportKey === 'payout-tracker')).toBe(false);
  });

  it('A1: explicit recipients must be internal OR a subset of the tenant\'s configured recipients — anything else refused, nothing sent', async () => {
    const w = makeWorld();
    await expect(w.sender.sendNow('bajaj', '2026-11', ['attacker@evil.com'])).rejects.toThrow(/attacker@evil\.com.*not an internal address.*configured/);
    await expect(w.sender.sendNow('bajaj', '2026-11', ['qa@gifsy.in', 'attacker@evil.com'])).rejects.toThrow(/attacker@evil\.com/);
    expect(w.sendEmail).not.toHaveBeenCalled();
    expect(w.source.buildInput).not.toHaveBeenCalled();
    // Configured recipients (to or cc) are allowed.
    await w.sender.sendNow('bajaj', '2026-11', ['C@bajaj.com', 'a@bajaj.com']);
    expect(w.sendEmail.mock.calls[0][0].to).toEqual(['c@bajaj.com', 'a@bajaj.com']);
  });

  it('A1: refuses a tenant whose config is absent / disabled / invalid, or whose client is inactive — even with explicit recipients', async () => {
    const w = makeWorld({
      settings: [
        { clientId: 'bajaj', settingValue: { enabled: true, recipients: ['a@bajaj.com'] } },
        { clientId: 'off', settingValue: { enabled: false, recipients: ['a@b.com'] } },
        { clientId: 'broken', settingValue: { enabled: true, recipients: ['nope'] } },
        { clientId: 'gone', settingValue: { enabled: true, recipients: ['a@b.com'] } },
      ],
      clients: [
        { id: 'bajaj', status: 'ACTIVE', internalName: 'Bajaj' },
        { id: 'off', status: 'ACTIVE', internalName: 'Off' },
        { id: 'broken', status: 'ACTIVE', internalName: 'Broken' },
        { id: 'gone', status: 'INACTIVE', internalName: 'Gone' },
      ],
    });
    await expect(w.sender.sendNow('deoleo', '2026-11', ['qa@gifsy.in'])).rejects.toThrow(/not enabled for deoleo/);
    await expect(w.sender.sendNow('off', '2026-11', ['qa@gifsy.in'])).rejects.toThrow(/not enabled for off/);
    await expect(w.sender.sendNow('broken', '2026-11', ['qa@gifsy.in'])).rejects.toThrow(/Invalid payoutTracker setting/);
    await expect(w.sender.sendNow('gone', '2026-11', ['qa@gifsy.in'])).rejects.toThrow(/INACTIVE/);
    expect(w.sendEmail).not.toHaveBeenCalled();
  });

  it('explicit tenant-configured (non-internal) recipients are allowed ONLY when PAYOUT_TRACKER_EMAIL_LIVE=true — else 400', async () => {
    for (const env of [{}, { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'qa@gifsy.in' }, { PAYOUT_TRACKER_EMAIL_LIVE: 'false' }]) {
      const w = makeWorld();
      w.sender.env = env;
      const e = await w.sender.sendNow('bajaj', '2026-11', ['a@bajaj.com']).catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toMatch(/a@bajaj\.com.*internal.*PAYOUT_TRACKER_EMAIL_LIVE/);
      expect(w.sendEmail).not.toHaveBeenCalled();
      // Internal addresses still fine in a non-live environment.
      await w.sender.sendNow('bajaj', '2026-11', ['qa@gifsy.in']);
      expect(w.sendEmail.mock.calls[0][0].to).toEqual(['qa@gifsy.in']);
    }
    const bad = await makeWorld().sender.sendNow('bajaj', '2026-11', ['x@evil.com']).catch((x) => x);
    expect(bad).toBeInstanceOf(BadRequestException);
    const junk = await makeWorld().sender.sendNow('bajaj', '2026-11', ['junk']).catch((x) => x);
    expect(junk).toBeInstanceOf(BadRequestException);
    expect(junk.message).toMatch(/not a valid email/);
    const month = await makeWorld().sender.sendNow('bajaj', '2026-13', ['qa@gifsy.in']).catch((x) => x);
    expect(month).toBeInstanceOf(BadRequestException);
    expect(month.message).toMatch(/YYYY-MM/);
  });

  it('no recipients → the SAME environment guard as the schedule: live → configured to/cc', async () => {
    const w = makeWorld();
    await w.sender.sendNow('bajaj', '2026-11');
    expect(w.sendEmail.mock.calls[0][0]).toEqual(expect.objectContaining({ to: ['a@bajaj.com'], cc: ['c@bajaj.com'], subject: 'Bajaj Loyalty — Payout tracker' }));
  });

  it('no recipients, test env → ONLY the test recipient, subject names the real to + cc (same as the schedule)', async () => {
    const w = makeWorld();
    w.sender.env = { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'qa@gifsy.in' };
    const r = await w.sender.sendNow('bajaj', '2026-11');
    const arg = w.sendEmail.mock.calls[0][0];
    expect(arg.to).toEqual(['qa@gifsy.in']);
    expect(arg).not.toHaveProperty('cc');
    expect(arg.subject).toBe('[TEST — would go to a@bajaj.com; cc c@bajaj.com] Bajaj Loyalty — Payout tracker');
    expect(r.subject).toBe(arg.subject);
  });

  it('no recipients, guard off or a non-internal test recipient → refused + ops alert, nothing sent to the client', async () => {
    for (const [env, re] of [
      [{}, /disabled in this environment/],
      [{ PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'boss@bajaj.com' }, /not on an internal domain/],
    ] as const) {
      const w = makeWorld({ digest: ['ops@gifsy.in'] });
      w.sender.env = { ...env };
      await expect(w.sender.sendNow('bajaj', '2026-11')).rejects.toThrow(re);
      expect(w.source.buildInput).not.toHaveBeenCalled();
      expect(w.sendEmail).toHaveBeenCalledTimes(1); // the alert only
      const alert = w.sendEmail.mock.calls[0][0];
      expect(alert.to).toEqual(['ops@gifsy.in']);
      expect(alert.subject).toMatch(/^Bajaj payout tracker send-now REFUSED/);
      expect(alert).not.toHaveProperty('attachments');
    }
  });

  it('send failure is thrown to the caller and recorded FAILED on the manual run row', async () => {
    const w = makeWorld();
    w.sendEmail.mockRejectedValue(new Error('relay down'));
    await expect(w.sender.sendNow('bajaj', '2026-11', ['qa@gifsy.in'])).rejects.toThrow(/email send failed: relay down/);
    expect(w.runs).toEqual([expect.objectContaining({ reportKey: 'payout-tracker-manual', status: 'FAILED', error: 'email send failed: relay down' })]);
  });

  it('send-now with data notes → ops heads-up after the email', async () => {
    const w = makeWorld();
    w.source.buildInput.mockResolvedValue({ clientName: 'Bajaj Consumer Care', month: '2026-11', notes: [{ audience: 'ops', text: 'n' }] });
    await w.sender.sendNow('bajaj', '2026-11', ['qa@gifsy.in']);
    expect(w.sendEmail).toHaveBeenCalledTimes(2);
    expect(w.sendEmail.mock.calls[1][0].subject).toBe('Payout tracker Bajaj Consumer Care 2026-11: 1 data note(s)');
  });
});
