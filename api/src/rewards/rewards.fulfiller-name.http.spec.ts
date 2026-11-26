import { BadRequestException, INestApplication, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { AdminRewardsController } from './admin-rewards.controller';
import { RewardsController } from './rewards.controller';
import {
  HUBBLE_FORWARD_BLOCK_MESSAGE,
  HUBBLE_NO_ORDER_REFUND_REASON,
  hubbleReconcileFlags,
  hubbleWaitInfo,
  RewardsService,
} from './rewards.service';

/**
 * OWNER RULE (2026-11-26, all clients): a client must never see that vouchers are procured from Hubble.
 * Through the REAL Nest HTTP stack (global TransformInterceptor + AllExceptionsFilter): the order list / detail /
 * tracking responses and the error envelope a NON-Gifsy caller (client admin, partner, sales, vendor) receives
 * contain no "hubble" anywhere — values AND keys. A Gifsy operator still gets the raw data (Gifsy-only console).
 * The catalogue (/admin/rewards, editable by a client admin) keeps its KEYS (metadata.hubbleProductId is written
 * back key-for-key) but its VALUES are neutralised.
 */
const ROLE_HEADER = 'x-test-role';
class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'u1', role: req.headers[ROLE_HEADER] ?? 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' };
    return true;
  }
}

const createdAt = new Date(Date.now() - 3 * 3_600_000);
const metadata = {
  hubbleNeedsReconcile: true,
  hubbleReconcileReason: 'HUBBLE_INDETERMINATE',
  hubbleLatestReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND',
  hubbleNoOrderUnverified: { why: 'no delivered Hubble order on this Hubble account to verify against' },
  hubblePlaceAttemptAt: createdAt.toISOString(),
  hubbleLastSweepAt: new Date().toISOString(),
};
const baseOrder = {
  id: 'o1',
  orderNumber: 'BAJAJ-26-000050',
  status: 'PROCESSING',
  redemptionMode: 'GIFT_CARD',
  voucherCode: null,
  voucherProvider: 'Hubble',
  createdAt,
  updatedAt: createdAt,
  cancelReason: HUBBLE_NO_ORDER_REFUND_REASON,
  reward: { id: 'r1', name: 'Amazon Pay', redemptionMode: 'GIFT_CARD' },
};
/** The exact projection RewardsService.listOrders builds for an admin (operator / tenant admin) viewer. */
const adminRow = {
  ...baseOrder,
  ...hubbleReconcileFlags(metadata),
  ...hubbleWaitInfo({ ...baseOrder, metadata }),
};
const timeline = [
  { status: 'PROCESSING', at: createdAt, note: 'Hubble voucher processing (auto re-check)' },
  { status: 'FAILED', at: createdAt, note: 'Hubble failed — points refunded: Hubble said ERR' },
];

const service = {
  listOrders: async () => ({ orders: [adminRow], pagination: { page: 1, limit: 20, total: 1, pages: 1 }, nextCursor: null }),
  getOrder: async () => ({ order: { ...adminRow, metadata } }),
  trackOrder: async () => ({ order: baseOrder, timeline }),
  confirmRedeem: async () => {
    throw new BadRequestException(HUBBLE_FORWARD_BLOCK_MESSAGE);
  },
  adminListCatalog: async () => ({
    items: [{ id: 'r1', name: 'Amazon Pay', metadata: { hubbleProductId: 'p-123', hubbleDenominations: [100] }, note: 'Load from Hubble' }],
  }),
};

const HTTP_TIMEOUT = 30_000;

describe('fulfiller name — order API through the Nest stack', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RewardsController, AdminRewardsController],
      providers: [
        { provide: RewardsService, useValue: service },
        { provide: APP_GUARD, useClass: FakeAuth },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, HTTP_TIMEOUT);
  afterAll(async () => app?.close(), HTTP_TIMEOUT);

  const get = (path: string, role: string) => request(app.getHttpServer()).get(path).set(ROLE_HEADER, role);

  it.each(['CLIENT_ADMIN', 'SSS', 'RETAILER', 'SALES_ASM', 'VENDOR', 'MIS_USER'])(
    'a %s order list / detail / tracking response contains no "hubble" anywhere (values and keys)',
    async (role) => {
      for (const path of ['/rewards/orders', '/rewards/orders/o1', '/rewards/orders/o1/track']) {
        const res = await get(path, role);
        expect(res.status).toBe(200);
        expect(res.text).not.toMatch(/hubble/i);
      }
    },
    HTTP_TIMEOUT,
  );

  it('the client admin list says "Via API" and keeps every signal under neutral keys', async () => {
    const res = await get('/rewards/orders', 'CLIENT_ADMIN');
    const o = res.body.data.orders[0];
    expect(o.voucherProvider).toBe('Via API');
    expect(o.apiNeedsReconcile).toBe(true);
    expect(o.apiReconcileReason).toBe('API_INDETERMINATE');
    expect(o.apiHanded).toBe(true);
    expect(typeof o.apiWaitingSince).toBe('string');
    expect(o.createdAt).toBe(createdAt.toISOString()); // dates untouched
  }, HTTP_TIMEOUT);

  it('a Gifsy operator still gets the raw data (Gifsy-only console)', async () => {
    for (const role of ['GIFSY_ADMIN', 'GIFSY_STAFF']) {
      const res = await get('/rewards/orders', role);
      const o = res.body.data.orders[0];
      expect(o.voucherProvider).toBe('Hubble');
      expect(o.hubbleNeedsReconcile).toBe(true);
    }
  }, HTTP_TIMEOUT);

  it('an error a non-Gifsy caller receives never names the fulfiller; a Gifsy operator reads it unchanged', async () => {
    const partner = await request(app.getHttpServer()).post('/rewards/redeem/confirm').set(ROLE_HEADER, 'SSS').send({});
    expect(partner.body.success).toBe(false);
    expect(partner.text).not.toMatch(/hubble/i);
    expect(partner.body.error).toMatch(/via API/);
    const gifsy = await request(app.getHttpServer()).post('/rewards/redeem/confirm').set(ROLE_HEADER, 'GIFSY_ADMIN').send({});
    expect(gifsy.body.error).toBe(HUBBLE_FORWARD_BLOCK_MESSAGE);
  }, HTTP_TIMEOUT);

  it('the client-admin catalogue keeps its editable keys but no value names the fulfiller', async () => {
    const res = await get('/admin/rewards/catalog', 'CLIENT_ADMIN');
    const item = res.body.data.items[0];
    expect(item.metadata.hubbleProductId).toBe('p-123'); // key kept: written back on save
    expect(item.note).toBe('Load via API');
  }, HTTP_TIMEOUT);
});
