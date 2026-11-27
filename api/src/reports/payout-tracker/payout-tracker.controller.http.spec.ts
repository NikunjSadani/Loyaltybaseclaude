import { BadRequestException, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { PayoutTrackerController } from './payout-tracker.controller';
import { PayoutTrackerSender } from './payout-tracker.sender';

const HTTP_TIMEOUT = 30_000;
const SECRET = 'c'.repeat(64);
const SEND_SECRET = 's'.repeat(64);

describe('POST /internal/scheduled/payout-tracker — guard + HTTP contract', () => {
  let app: INestApplication;
  const runDue = jest.fn();
  const sendNow = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PayoutTrackerController],
      providers: [
        { provide: PayoutTrackerSender, useValue: { runDue, sendNow } },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, HTTP_TIMEOUT);
  afterAll(async () => {
    delete process.env.REPORTS_RUN_SECRET;
    delete process.env.PAYOUT_TRACKER_SEND_SECRET;
    await app?.close();
  }, HTTP_TIMEOUT);

  beforeEach(() => {
    process.env.REPORTS_RUN_SECRET = SECRET;
    process.env.PAYOUT_TRACKER_SEND_SECRET = SEND_SECRET;
    runDue.mockReset();
    sendNow.mockReset();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const run = () => request(app.getHttpServer()).post('/internal/scheduled/payout-tracker');

  it('no secret configured → 403 (fail-closed), runDue never called', async () => {
    delete process.env.REPORTS_RUN_SECRET;
    await run().set('x-reports-run-secret', SECRET).expect(403);
    expect(runDue).not.toHaveBeenCalled();
  });

  it('missing / wrong secret → 403, runDue never called', async () => {
    await run().expect(403);
    await run().set('x-reports-run-secret', 'wrong').expect(403);
    await run().set('x-reports-run-secret', 'c'.repeat(63) + 'd').expect(403);
    expect(runDue).not.toHaveBeenCalled();
  });

  it('valid secret → 200 with the outcomes (nothing failed)', async () => {
    runDue.mockResolvedValue({ runDate: '2026-11-27', outcomes: [{ clientId: 'bajaj', status: 'sent', month: '2026-11' }] });
    const res = await run().set('x-reports-run-secret', SECRET).expect(200);
    expect(JSON.stringify(res.body)).toContain('"status":"sent"');
    expect(runDue).toHaveBeenCalledWith(expect.any(Date));
  });

  it('any tenant FAILED → 500 whose message names the tenant + reason', async () => {
    runDue.mockResolvedValue({ runDate: '2026-11-27', outcomes: [{ clientId: 'bajaj', status: 'failed', error: 'engine exploded' }] });
    const res = await run().set('x-reports-run-secret', SECRET).expect(500);
    expect(JSON.stringify(res.body)).toContain('bajaj FAILED: engine exploded');
  });

  it('send-now has its OWN secret (PAYOUT_TRACKER_SEND_SECRET): unset → 403 fail-closed; the scheduler secret is NOT accepted', async () => {
    const post = (headers: Record<string, string>) => {
      let r = request(app.getHttpServer()).post('/internal/scheduled/payout-tracker/send-now');
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send({ clientId: 'bajaj', month: '2026-11' });
    };
    delete process.env.PAYOUT_TRACKER_SEND_SECRET;
    await post({ 'x-payout-tracker-send-secret': SEND_SECRET }).expect(403);
    process.env.PAYOUT_TRACKER_SEND_SECRET = SEND_SECRET;
    await post({ 'x-reports-run-secret': SECRET }).expect(403);
    await post({ 'x-payout-tracker-send-secret': SECRET }).expect(403);
    await post({ 'x-payout-tracker-send-secret': SEND_SECRET.slice(0, -1) + 'x' }).expect(403);
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('send-now: guarded; validates the body; passes through; sender error → 422 with the reason', async () => {
    const post = (body: object, s = SEND_SECRET) => request(app.getHttpServer()).post('/internal/scheduled/payout-tracker/send-now').set('x-payout-tracker-send-secret', s).send(body);
    await post({ clientId: 'bajaj', month: '2026-11' }, 'nope').expect(403);
    await post({ clientId: 'bajaj', month: '2026-13' }).expect(400);
    await post({ clientId: 'bajaj', month: '2026-11', extra: 1 }).expect(400);
    expect(sendNow).not.toHaveBeenCalled();

    sendNow.mockResolvedValue({ month: '2026-11', to: ['o@x.com'], cc: [], subject: 'S', fileName: 'f.xlsx', rejected: [] });
    await post({ clientId: 'bajaj', month: '2026-11', recipients: ['o@x.com'] }).expect(200);
    expect(sendNow).toHaveBeenCalledWith('bajaj', '2026-11', ['o@x.com']);

    sendNow.mockRejectedValueOnce(new BadRequestException('a@bajaj.com is a configured recipient but not an internal address'));
    const bad = await post({ clientId: 'bajaj', month: '2026-11', recipients: ['a@bajaj.com'] }).expect(400);
    expect(JSON.stringify(bad.body)).toContain('not an internal address');

    sendNow.mockRejectedValue(new Error('payout tracker is not enabled for deoleo'));
    const res = await post({ clientId: 'deoleo', month: '2026-11' }).expect(422);
    expect(JSON.stringify(res.body)).toContain('not enabled for deoleo');
  });
});
