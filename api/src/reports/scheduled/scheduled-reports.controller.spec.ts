import { ForbiddenException, HttpException } from '@nestjs/common';
import { ScheduledReportsController } from './scheduled-reports.controller';

describe('ScheduledReportsController — POST /v1/reports/run', () => {
  const SECRET = 'a'.repeat(64);
  let runDailyReports: jest.Mock;
  let ctrl: ScheduledReportsController;

  beforeEach(() => {
    process.env.REPORTS_RUN_SECRET = SECRET;
    runDailyReports = jest.fn();
    ctrl = new ScheduledReportsController({ runDailyReports } as never);
  });
  afterAll(() => delete process.env.REPORTS_RUN_SECRET);

  const outcome = (status: string, extra: Record<string, unknown> = {}) => ({
    dateLabel: '13 Nov 2026',
    reports: [{ key: 'dailyDigest', status, ...extra }],
  });
  const statusOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };

  it('fail-closed on a missing / wrong secret', async () => {
    await expect(ctrl.run('nope')).rejects.toBeInstanceOf(ForbiddenException);
    delete process.env.REPORTS_RUN_SECRET;
    await expect(ctrl.run(SECRET)).rejects.toBeInstanceOf(ForbiddenException);
    expect(runDailyReports).not.toHaveBeenCalled();
  });

  it('sent → 200 { ok:true }', async () => {
    runDailyReports.mockResolvedValue(outcome('sent'));
    await expect(ctrl.run(SECRET)).resolves.toMatchObject({ ok: true, reports: [{ status: 'sent' }] });
  });

  it('skipped (already sent today) → 200 { skipped:"already-sent" }', async () => {
    runDailyReports.mockResolvedValue(outcome('skipped', { skipped: 'already-sent' }));
    await expect(ctrl.run(SECRET)).resolves.toMatchObject({ ok: true, skipped: 'already-sent' });
  });

  it('error / degraded → 500; no-recipients / in-progress → 409 (Cloud Scheduler marks the run failed)', async () => {
    for (const [status, code] of [['error', 500], ['degraded', 500], ['no-recipients', 409], ['in-progress', 409]] as const) {
      runDailyReports.mockResolvedValue(outcome(status, { error: 'why' }));
      expect(await statusOf(ctrl.run(SECRET))).toBe(code);
    }
    runDailyReports.mockResolvedValue(outcome('error', { error: 'smtp down' }));
    const err = await ctrl.run(SECRET).catch((e: HttpException) => e);
    const body = (err as HttpException).getResponse() as { message: string; reports: unknown[] };
    expect(body.message).toMatch(/^Daily operations digest: error — reason: smtp down — full outcome in the API log line "daily-digest-run [0-9a-f]{8}"$/);
    expect(body.reports).toEqual([{ key: 'dailyDigest', status: 'error', error: 'smtp down' }]);
  });

  it('force=true is passed through; anything else is not force', async () => {
    runDailyReports.mockResolvedValue(outcome('sent'));
    await ctrl.run(SECRET, 'true');
    expect(runDailyReports.mock.calls[0][1]).toEqual({ force: true });
    await ctrl.run(SECRET, 'yes');
    expect(runDailyReports.mock.calls[1][1]).toEqual({ force: false });
  });
});
