import { INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { ScheduledReportsController } from './scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled-reports.service';

/**
 * POST /v1/reports/run through the REAL Nest HTTP stack (global TransformInterceptor + AllExceptionsFilter).
 * The filter forwards only an exception's `message`, so a non-2xx run must carry a readable summary there,
 * pointing at ONE structured log line that holds the full outcome.
 */
const HTTP_TIMEOUT = 30_000;
const SECRET = 'b'.repeat(64);

describe('POST /reports/run — HTTP contract through the Nest stack', () => {
  let app: INestApplication;
  const runDailyReports = jest.fn();
  let logged: string[] = [];

  beforeAll(async () => {
    process.env.REPORTS_RUN_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      controllers: [ScheduledReportsController],
      providers: [
        { provide: ScheduledReportsService, useValue: { runDailyReports } },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, HTTP_TIMEOUT);
  afterAll(async () => {
    delete process.env.REPORTS_RUN_SECRET;
    await app?.close();
  }, HTTP_TIMEOUT);

  beforeEach(() => {
    runDailyReports.mockReset();
    logged = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void logged.push(String(m)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logged.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  const post = (q = '') => request(app.getHttpServer()).post(`/reports/run${q}`).set('x-reports-run-secret', SECRET);

  it('degraded → 500 whose error is a readable summary (status, reason, sections, dropped, notices) + the log line id', async () => {
    runDailyReports.mockResolvedValue({
      dateLabel: '13 Nov 2026',
      reports: [
        {
          key: 'dailyDigest',
          status: 'degraded',
          error: 'not loaded: Bajaj: Points',
          failedSections: ['Bajaj: Points'],
          droppedRecipients: ['cfo@acme.com'],
          notices: ['Couldn\'t load the holiday calendar (x)'],
          window: { startMs: 1, endMs: 2, label: 'Thu 12 Nov, 09:30 → Fri 13 Nov, 09:30 IST' },
        },
      ],
    });
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    const err: string = res.body.error;
    expect(err).not.toBe('Error');
    expect(err).toContain('Daily operations digest: degraded');
    expect(err).toContain('reason: not loaded: Bajaj: Points');
    expect(err).toContain('the email WAS sent, but incomplete');
    expect(err).toContain('not sent to (non-internal): cfo@acme.com');
    expect(err).toContain("notices: Couldn't load the holiday calendar (x)");
    const id = /daily-digest-run ([0-9a-f]{8})/.exec(err)![1];
    // The structured line it points to carries the FULL outcome.
    const line = logged.find((l) => l.startsWith(`daily-digest-run ${id} `))!;
    expect(line).toBeDefined();
    const full = JSON.parse(line.slice(`daily-digest-run ${id} `.length));
    expect(full).toMatchObject({ httpStatus: 500, dateLabel: '13 Nov 2026', reports: [{ status: 'degraded', failedSections: ['Bajaj: Points'] }] });
  }, HTTP_TIMEOUT);

  it('no-recipients → 409 with a readable reason; in-progress → 409', async () => {
    runDailyReports.mockResolvedValue({ dateLabel: 'd', reports: [{ key: 'dailyDigest', status: 'no-recipients', droppedRecipients: ['x@acme.com'] }] });
    const a = await post();
    expect(a.status).toBe(409);
    expect(a.body.error).toContain('Daily operations digest: no-recipients — not sent to (non-internal): x@acme.com');
    runDailyReports.mockResolvedValue({ dateLabel: 'd', reports: [{ key: 'dailyDigest', status: 'in-progress', error: 'another digest run is in progress' }] });
    const b = await post();
    expect(b.status).toBe(409);
    expect(b.body.error).toContain('reason: another digest run is in progress');
  }, HTTP_TIMEOUT);

  it('sent → 200 envelope with the outcome; skipped → 200 { skipped }; force=true passed through', async () => {
    runDailyReports.mockResolvedValue({ dateLabel: 'd', reports: [{ key: 'dailyDigest', status: 'sent', recipients: 2 }] });
    const ok = await post('?force=true');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, data: { ok: true, dateLabel: 'd', reports: [{ key: 'dailyDigest', status: 'sent', recipients: 2 }] } });
    expect(runDailyReports.mock.calls[0][1]).toEqual({ force: true });
    expect(logged.some((l) => /^daily-digest-run [0-9a-f]{8} \{"httpStatus":200/.test(l))).toBe(true);
    runDailyReports.mockResolvedValue({ dateLabel: 'd', reports: [{ key: 'dailyDigest', status: 'skipped', skipped: 'already-sent' }] });
    const sk = await post();
    expect(sk.status).toBe(200);
    expect(sk.body.data.skipped).toBe('already-sent');
  }, HTTP_TIMEOUT);

  it('a wrong secret is still a plain 403', async () => {
    const res = await request(app.getHttpServer()).post('/reports/run').set('x-reports-run-secret', 'nope');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Invalid reports-run secret' });
    expect(runDailyReports).not.toHaveBeenCalled();
  }, HTTP_TIMEOUT);
});
