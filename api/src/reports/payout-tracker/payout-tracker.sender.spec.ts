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

describe('PayoutTrackerSender — large lists sent as chunks (owner 2026-11-27: ~358 recipients, all visible)', () => {
  const TO = ['a1@bajaj.com', 'a2@bajaj.com', 'a3@bajaj.com'];
  const CC = Array.from({ length: 355 }, (_, i) => `c${i + 1}@bajaj.com`);
  // Mixed-case duplicates in config are dropped (case-insensitive), cc already in To dropped.
  const big = () => makeWorld({ settings: [{ clientId: 'bajaj', settingValue: { enabled: true, recipients: [...TO, 'A1@Bajaj.com'], cc: [...CC, 'C7@BAJAJ.COM', 'a2@bajaj.com'] } }] });
  const clientCalls = (w: ReturnType<typeof makeWorld>) => w.sendEmail.mock.calls.map((c) => c[0]).filter((a) => a.attachments);
  const addrs = (a: { to: string[]; cc?: string[] }) => [...a.to, ...(a.cc ?? [])];

  it('358 recipients → 8 messages of ≤50: first = configured To then Cc fill, rest in To; same email each; SENT with all 358', async () => {
    const w = big();
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('sent');
    const calls = clientCalls(w);
    expect(calls).toHaveLength(8);
    expect(calls[0].to).toEqual(TO);
    expect(calls[0].cc).toEqual(CC.slice(0, 47));
    for (let i = 1; i < 8; i++) {
      expect(calls[i]).not.toHaveProperty('cc');
      expect(calls[i].to).toEqual(CC.slice(47 + (i - 1) * 50, 47 + i * 50));
    }
    expect(calls.map((c) => addrs(c).length)).toEqual([50, 50, 50, 50, 50, 50, 50, 8]);
    const all = calls.flatMap(addrs);
    expect(new Set(all).size).toBe(358);
    expect(all).toEqual([...TO, ...CC]); // order kept, no duplicates
    for (const c of calls) {
      expect(c).toEqual(expect.objectContaining({ subject: 'Bajaj Loyalty — Payout tracker', html: '<p>h</p>', text: 't', attachments: [expect.objectContaining({ content: w.pack.workbook })], detectAmbiguousDelivery: true }));
    }
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'SENT', recipients: [...TO, ...CC], error: null }));
    expect(r.outcomes[0].recipients).toHaveLength(358);
  });

  it('PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL overrides the cap (1..500); an invalid value FAILS loudly, never a silent default', async () => {
    const w = big();
    w.sender.env = { PAYOUT_TRACKER_EMAIL_LIVE: 'true', PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: '200' };
    await w.sender.runDue(FRI_1005);
    expect(clientCalls(w).map((c) => addrs(c).length)).toEqual([200, 158]);

    for (const bad of ['0', '501', 'abc', '12.5']) {
      const b = big();
      b.sender.env = { PAYOUT_TRACKER_EMAIL_LIVE: 'true', PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: bad };
      const o = (await b.sender.runDue(FRI_1005)).outcomes[0];
      expect(o).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringMatching(/PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL/) }));
      expect(clientCalls(b)).toHaveLength(0);
      expect(b.sendEmail).toHaveBeenCalledTimes(1); // the alert
    }
  });

  it('partial failure → FAILED (retryable) + alert naming failed message + address counts; the retry sends ONLY the remaining chunk', async () => {
    const w = big();
    const ok = { skipped: false, accepted: [], rejected: [] };
    w.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[147]) throw new Error('421 try later'); // message 4
      return ok;
    });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(r.outcomes[0].error).toMatch(/1 of 8 message\(s\) NOT sent \(50 address\(es\)\): email send failed: 421 try later/);
    expect(r.outcomes[0].error).toMatch(/308 of 358 address\(es\) received it — a retry sends ONLY/);
    expect(clientCalls(w)).toHaveLength(8); // a failed chunk never stops the others
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: 1 }));
    expect((w.runs[0].recipients as unknown as { delivered: string[] }).delivered).toHaveLength(308);
    const alert = w.sendEmail.mock.calls.map((c) => c[0]).find((a) => !a.attachments)!;
    expect(alert.subject).toBe('Bajaj payout tracker: 1 of 8 message(s) NOT sent (50 addresses)');

    // Retry: exactly ONE message, exactly the 50 that did not get it.
    w.sendEmail.mockClear();
    w.sendEmail.mockResolvedValue(ok);
    const r2 = await w.sender.runDue(ist('2026-11-27T10:20:00'));
    expect(r2.outcomes[0].status).toBe('sent');
    const retry = clientCalls(w);
    expect(retry).toHaveLength(1);
    expect(addrs(retry[0])).toEqual(CC.slice(147, 197));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'SENT', attempts: 2, error: null }));
    expect(new Set(w.runs[0].recipients).size).toBe(358);
    expect((await w.sender.runDue(ist('2026-11-27T10:35:00'))).outcomes[0].status).toBe('already-done');
  });

  it('progress is recorded after each chunk: a crash mid-way (stale PENDING) never re-sends; a failed progress write STOPS sending', async () => {
    const w = big();
    const orig = w.prisma.tenantReportRun.update.getMockImplementation()!;
    let n = 0;
    w.prisma.tenantReportRun.update.mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      if (++n === 3) throw new Error('db blip'); // the 3rd progress write (after message 3)
      return orig(args);
    });
    w.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[47]) throw new Error('421 later'); // message 2 fails
      return { skipped: false, accepted: [], rejected: [] };
    });
    const r = await w.sender.runDue(FRI_1005);
    expect(clientCalls(w)).toHaveLength(3);
    expect(r.outcomes[0].error).toMatch(/100 address\(es\) WERE sent .* sending STOPPED; NOT retried/);
    // The alert lists EVERY address that did not get it: the failed message 2 + the 5 never attempted.
    expect(r.outcomes[0].error).toMatch(/NOT sent: 258 address\(es\) \(5 message\(s\) never attempted \+ 1 failed\): c48@bajaj\.com,/);
    expect(r.outcomes[0].error).toContain('c355@bajaj.com');
    expect(r.outcomes[0].error).not.toContain('c1@bajaj.com,');
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    expect((await w.sender.runDue(ist('2026-11-27T10:20:00'))).outcomes[0].status).toBe('already-done');
    expect(clientCalls(w)).toHaveLength(3);
  });

  it('an uncertain chunk is NEVER retried (UNCERTAIN alert); other failed chunks are; the day ends FAILED, not SENT', async () => {
    const w = big();
    const ok = { skipped: false, accepted: [], rejected: [] };
    let failFifth = true;
    w.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[47]) throw Object.assign(new Error('Timeout'), { deliveryAmbiguous: true }); // message 2
      if (a.attachments && a.to[0] === CC[197] && failFifth) throw new Error('relay down'); // message 5
      return ok;
    });
    const r = await w.sender.runDue(FRI_1005);
    expect(r.outcomes[0].status).toBe('failed');
    expect(r.outcomes[0].error).toMatch(/1 message\(s\) \(50 address\(es\).*MAY have been delivered/);
    const subjects = w.sendEmail.mock.calls.map((c) => c[0]).filter((a) => !a.attachments).map((a) => a.subject);
    expect(subjects).toEqual(['Bajaj payout tracker: delivery UNCERTAIN — check before resending', 'Bajaj payout tracker: 1 of 8 message(s) NOT sent (50 addresses)']);
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: 1 }));

    // Retry sends ONLY message 5's addresses — never the uncertain chunk — then stays FAILED (no more retries).
    failFifth = false;
    w.sendEmail.mockClear();
    const r2 = await w.sender.runDue(ist('2026-11-27T10:20:00'));
    const retry = clientCalls(w);
    expect(retry).toHaveLength(1);
    expect(addrs(retry[0])).toEqual(CC.slice(197, 247));
    expect(r2.outcomes[0]).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringMatching(/50 address\(es\) from an earlier attempt are delivery UNCERTAIN.*308 of 358.*NOT retried/) }));
    expect(w.sendEmail.mock.calls.map((c) => c[0]).filter((a) => !a.attachments).map((a) => a.subject)).toEqual(['Bajaj payout tracker: delivery UNCERTAIN — check before resending']);
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS }));
    w.sendEmail.mockClear();
    expect((await w.sender.runDue(ist('2026-11-27T10:35:00'))).outcomes[0].status).toBe('already-done');
    expect(w.sendEmail).not.toHaveBeenCalled();
  });

  it('a retry with delivered addresses keeps the month being delivered (no chooseMonth), never overwrites it, and tells ops the pack was rebuilt', async () => {
    const w = big();
    const ok = { skipped: false, accepted: [], rejected: [] };
    w.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[147]) throw new Error('421 try later');
      return ok;
    });
    await w.sender.runDue(FRI_1005);
    expect(w.runs[0].month).toBe('2026-11');
    // Before the retry, the current month "loses" its sales → chooseMonth would now say 2026-10.
    w.prisma.outletSalesRecord.findFirst.mockResolvedValue(null);
    w.source.buildInput.mockClear();
    w.sendEmail.mockClear();
    w.sendEmail.mockResolvedValue(ok);
    const r2 = await w.sender.runDue(ist('2026-11-27T10:20:00'));
    expect(w.source.buildInput).toHaveBeenCalledWith('bajaj', '2026-11', expect.any(Date));
    expect(w.prisma.outletSalesRecord.findFirst).toHaveBeenCalledTimes(1); // only the first run chose
    expect(r2.outcomes[0]).toEqual(expect.objectContaining({ status: 'sent', month: '2026-11', notes: [expect.stringMatching(/^note: retry rebuilt the 2026-11 pack at 2026-11-27 10:20:00\.000 IST — the 308 address\(es\) sent earlier/)] }));
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'SENT', month: '2026-11' }));
    const heads = w.sendEmail.mock.calls.map((c) => c[0]).find((a) => !a.attachments)!;
    expect(heads.html).toMatch(/\[ops only\] note: retry rebuilt the 2026-11 pack/);

    // A resumed run that fails again: the alert carries the rebuild note; the month is not overwritten / nulled.
    const f = big();
    f.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[147]) throw new Error('421 try later');
      return ok;
    });
    await f.sender.runDue(FRI_1005);
    f.sender.env ={ PAYOUT_TRACKER_EMAIL_LIVE: 'true', PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: 'bad' };
    f.sendEmail.mockClear();
    f.sendEmail.mockResolvedValue(ok);
    const r3 = await f.sender.runDue(ist('2026-11-27T10:20:00'));
    expect(r3.outcomes[0].status).toBe('failed');
    expect(f.runs[0].month).toBe('2026-11');
    expect(f.sendEmail.mock.calls[0][0].html).toMatch(/retry rebuilt the 2026-11 pack/);
  });

  it('stale PENDING with chunk progress → the alert states delivered / not-sent / uncertain counts + "do NOT resend to the delivered N"', async () => {
    const w = big();
    w.runs.push({
      id: 'old', clientId: 'bajaj', reportKey: 'payout-tracker', runDate: '2026-11-27', status: 'PENDING', attempts: 1, month: '2026-11',
      recipients: { delivered: [...TO, ...CC.slice(0, 47)], uncertain: CC.slice(47, 52) } as never,
      updatedAt: new Date(FRI_1005.getTime() - STALE_PENDING_MS - 1),
    });
    const r = await w.sender.runDue(FRI_1005);
    const err = r.outcomes[0].error!;
    expect(err).toMatch(/previous attempt \(2026-11\) was interrupted/);
    expect(err).toMatch(/Recorded as delivered: 50 — do NOT resend to the delivered 50\./);
    expect(err).toMatch(/Not recorded as sent: 303 \(c53@bajaj\.com, /);
    expect(err).toMatch(/Delivery uncertain: 5 \(c48@bajaj\.com, c49@bajaj\.com, c50@bajaj\.com, c51@bajaj\.com, c52@bajaj\.com\)/);
    expect(w.sendEmail.mock.calls[0][0].html).toMatch(/do NOT resend to the delivered 50/);
    expect(w.runs[0]).toEqual(expect.objectContaining({ status: 'FAILED', attempts: MAX_ATTEMPTS, error: expect.stringMatching(/delivered: 50, uncertain: 5/) }));
    expect(clientCalls(w)).toHaveLength(0);
  });

  it('test mode: ONE email to the test address; subject names the real recipient + message counts', async () => {
    const w = big();
    w.sender.env = { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'qa@gifsy.in' };
    expect((await w.sender.runDue(FRI_1005)).outcomes[0]).toEqual(expect.objectContaining({ status: 'sent', recipients: ['qa@gifsy.in'] }));
    const calls = clientCalls(w);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual(['qa@gifsy.in']);
    expect(calls[0]).not.toHaveProperty('cc');
    expect(calls[0].subject).toBe('[TEST — would go to 358 recipients (to 3, cc 355) as 8 messages of up to 50] Bajaj Loyalty — Payout tracker');

    // send-now in test mode too.
    const s = big();
    s.sender.env = { PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'qa@gifsy.in' };
    const res = await s.sender.sendNow('bajaj', '2026-11');
    expect(clientCalls(s)).toHaveLength(1);
    expect(res.subject).toMatch(/^\[TEST — would go to 358 recipients/);
  });

  it('send-now live with no explicit list → the same 8 chunks; a partial failure throws naming the failed addresses', async () => {
    const w = big();
    await w.sender.sendNow('bajaj', '2026-11');
    expect(clientCalls(w).map((c) => addrs(c).length)).toEqual([50, 50, 50, 50, 50, 50, 50, 8]);

    const f = big();
    f.sendEmail.mockImplementation(async (a: { to: string[]; attachments?: unknown }) => {
      if (a.attachments && a.to[0] === CC[347]) throw new Error('relay down'); // the last message
      return { skipped: false, accepted: [], rejected: [] };
    });
    await expect(f.sender.sendNow('bajaj', '2026-11')).rejects.toThrow(/1 of 8 message\(s\) NOT sent \(8 address\(es\)\).*350 of 358.*resend ONLY to the failed addresses with send-now: c348@bajaj\.com/);
    expect(f.runs[0]).toEqual(expect.objectContaining({ reportKey: 'payout-tracker-manual', status: 'FAILED' }));
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
