/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx';
import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { HubblePlaceOrderRejectedError } from '../hubble/hubble.service';
import { VoucherDispersalService, maskDispersalCode } from './voucher-dispersal.service';
import { VoucherDispersalProcessor, DISPERSAL_RETRY_MIN_AGE_MS, STALE_BUYING_MS } from './voucher-dispersal.processor';
import { makeFakePrisma } from './fake-prisma.test-spec';
import { HubbleWebhookController } from '../hubble/hubble-webhook.controller';

const ADMIN = { sub: 'admin-1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Admin' } as never;
const ASSUMED_ADMIN = { sub: 'admin-2', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true, phone: '', name: 'A2' } as never;
const STAFF = { sub: 's', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: 'S' } as never;
const CLIENT_ADMIN = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'C' } as never;

const CODE = 'AMZN-1234-5678-9999';
const FP = 'api.myhubble.money#abcdef0123456789';

function makeHubble() {
  return {
    isConfigured: jest.fn(() => true),
    accountFingerprint: jest.fn(() => FP),
    getProduct: jest.fn(async (id: string) => ({
      productId: id,
      name: id === 'P_FK' ? 'Flipkart' : 'Amazon Pay',
      denominationType: id === 'P_FK' ? 'FIXED' : 'FLEXIBLE',
      denominations: id === 'P_FK' ? [300, 1250] : [],
      minValue: 100,
      maxValue: 10000,
      maxVouchersPerOrder: 1,
    })),
    placeOrder: jest.fn(async (p: { referenceId: string }): Promise<any> => ({
      id: `H-${p.referenceId}`,
      status: 'SUCCESS',
      vouchers: [{ cardNumber: CODE, cardPin: null }],
    })),
    getOrderByReference: jest.fn(async (_ref: string): Promise<any> => null),
  };
}

function setup() {
  process.env.VOUCHER_DISPERSAL_BRANDS = JSON.stringify([
    { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: 'P_AMZ' },
    { key: 'FLIPKART', label: 'Flipkart', productId: 'P_FK' },
  ]);
  const db = makeFakePrisma();
  const hubble = makeHubble();
  const notifications = {
    sendTrackedWhatsappTemplate: jest.fn(async (_p: any) => {
      const r = await db.prisma.messageDeliveryReceipt.create({ data: { clientId: 'x', channel: 'WHATSAPP', crqid: 'c', status: 'SENT', sentAt: new Date() } });
      return { receiptId: r.id as string, requestId: 'req', error: null as string | null };
    }),
  };
  const processor = new VoucherDispersalProcessor(db.prisma as never, hubble as never, notifications as never);
  processor.sleep = async () => undefined;
  jest.spyOn(processor, 'kick').mockImplementation(() => undefined);
  const svc = new VoucherDispersalService(db.prisma as never, hubble as never, processor);
  return { ...db, hubble, notifications, processor, svc };
}

function file(rows: unknown[][]): Express.Multer.File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note'], ...rows]), 'Recipients');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), originalname: 'r.xlsx' } as Express.Multer.File;
}

async function confirmed(t: ReturnType<typeof setup>, rows: unknown[][], budgetRupees = 100000) {
  const c = await t.svc.createCampaign(ADMIN, { name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees });
  const prev = await t.svc.upload(ADMIN, c.id, file(rows));
  await t.svc.confirm(ADMIN, c.id, { previewId: prev.previewId, expectedValidCount: prev.summary.valid, expectedTotalRupees: prev.summary.totalRupees });
  return c.id;
}

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

describe('role guard', () => {
  it('refuses everyone but GIFSY_ADMIN at the service boundary', async () => {
    const t = setup();
    for (const u of [STAFF, CLIENT_ADMIN]) {
      await expect(t.svc.brands(u)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(t.svc.createCampaign(u, { name: 'x', programLabel: 'y', budgetRupees: 1 })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(t.svc.list(u, {})).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('is platform-level: an ASSUMED admin sees every campaign (no tenant filter)', async () => {
    const t = setup();
    await t.svc.createCampaign(ADMIN, { name: 'Gifsy own', programLabel: 'Gifsy Rewards', budgetRupees: 1000 });
    await t.svc.createCampaign(ADMIN, { name: 'For Bajaj', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees: 1000 });
    const list = await t.svc.list(ASSUMED_ADMIN, {});
    expect(list.map((c) => c.name).sort()).toEqual(['For Bajaj', 'Gifsy own']);
    expect(list.find((c) => c.name === 'For Bajaj')!.billedToClient).toEqual({ id: 'bajaj', name: 'Bajaj' });
    expect(list.find((c) => c.name === 'Gifsy own')!.billedToClient).toBeNull();
  });
});

describe('create', () => {
  it('validates billedToClientId and stores the budget in paise', async () => {
    const t = setup();
    await expect(t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'y', billedToClientId: 'nope', budgetRupees: 5 })).rejects.toBeInstanceOf(BadRequestException);
    const c = await t.svc.createCampaign(ADMIN, { name: ' X ', programLabel: ' Bajaj   Loyalty ', budgetRupees: 5000 });
    expect(c).toMatchObject({ name: 'X', programLabel: 'Bajaj Loyalty', status: 'DRAFT', budgetRupees: 5000, canCancel: true });
    expect(t.campaigns[0].budgetPaise).toBe(500000n);
    expect(t.audits.some((a) => a.metadata.event === 'VOUCHER_DISPERSAL_CREATED')).toBe(true);
  });
});

describe('upload / preview', () => {
  it('validates, flags duplicates + over-budget, and assigns a Hubble reference ONLY to valid rows', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1500 });
    const res = await t.svc.upload(ADMIN, c.id, file([
      ['9876543210', 'Asha', 1000, 'Amazon Pay'],
      ['9876543210', 'Asha again', 1000, 'Amazon Pay'],
      ['9876543211', 'Ravi', 300, 'Flipkart'],
      ['12', 'Bad', 300, 'Flipkart'],
      ['9876543212', 'Mina', 500, 'Flipkart'],
    ]));
    expect(res.summary).toMatchObject({ total: 5, valid: 2, invalid: 2, duplicates: 1, totalRupees: 1300, budgetRupees: 1500, overBudget: false });
    expect(res.summary.perBrand).toEqual(expect.arrayContaining([{ brandKey: 'AMAZON_PAY', brand: 'Amazon Pay', count: 1, totalRupees: 1000 }]));
    expect(res.rows.map((r) => r.status)).toEqual(['VALID', 'DUPLICATE', 'VALID', 'INVALID', 'INVALID']);
    expect(res).not.toHaveProperty('confirmPhrase');
    expect(t.rows.filter((r) => r.hubbleReferenceId).length).toBe(2);
    expect(t.rows.every((r) => !r.hubbleReferenceId || /^vd[0-9a-f]{24}$/.test(r.hubbleReferenceId))).toBe(true);
    expect(res.campaign.status).toBe('PREVIEWED');
  });

  it('flags over-budget and re-upload replaces rows', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const a = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay'], ['9876543211', 'B', 800, 'Amazon Pay']]));
    expect(a.summary.overBudget).toBe(true);
    const b = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay']]));
    expect(b.summary).toMatchObject({ total: 1, overBudget: false });
    expect(t.rows.length).toBe(1);
  });

  it('refuses an upload after confirm', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 800, 'Amazon Pay']]);
    await expect(t.svc.upload(ADMIN, id, file([['9876543210', 'A', 800, 'Amazon Pay']]))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('confirm', () => {
  it('refuses over-budget, zero valid, a stale preview id and changed numbers; on success queues the valid rows', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p1 = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay'], ['9876543211', 'B', 800, 'Amazon Pay']]));
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p1.previewId, expectedValidCount: 2, expectedTotalRupees: 1600 })).rejects.toThrow(/over the ₹1,000 budget/);
    const p2 = await t.svc.upload(ADMIN, c.id, file([['12', 'A', 800, 'Amazon Pay']]));
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p2.previewId, expectedValidCount: 1, expectedTotalRupees: 800 })).rejects.toThrow(/no valid rows/);
    const p3 = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay']]));
    expect(new Set([p1.previewId, p2.previewId, p3.previewId]).size).toBe(3);
    // A second tab still holding an older preview id is refused.
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p1.previewId, expectedValidCount: 1, expectedTotalRupees: 800 })).rejects.toThrow(/out of date/);
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p3.previewId, expectedValidCount: 2, expectedTotalRupees: 1600 })).rejects.toThrow(/preview changed/);
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p3.previewId, expectedValidCount: 1, expectedTotalRupees: 801 })).rejects.toBeInstanceOf(ConflictException);
    const ok = await t.svc.confirm(ADMIN, c.id, { previewId: p3.previewId, expectedValidCount: 1, expectedTotalRupees: 800 });
    expect(ok.status).toBe('PROCESSING');
    expect(t.rows[0].status).toBe('QUEUED');
    expect(t.audits.filter((a) => a.action === 'APPROVE').length).toBe(1);
    expect(t.hubble.placeOrder).not.toHaveBeenCalled();
  });

  it('is idempotent: a repeated confirm with the same preview id returns the campaign, queues nothing again, buys once', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay']]));
    const body = { previewId: p.previewId, expectedValidCount: 1, expectedTotalRupees: 800 };
    await t.svc.confirm(ADMIN, c.id, body);
    await t.processor.drain({ campaignId: c.id });
    const again = await t.svc.confirm(ADMIN, c.id, body);
    expect(again.status).toBe('COMPLETED');
    await t.processor.drain({ campaignId: c.id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
    expect(t.audits.filter((a) => a.action === 'APPROVE').length).toBe(1);
    await expect(t.svc.confirm(ADMIN, c.id, { ...body, previewId: 'pvother' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses when Hubble is not configured', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay']]));
    t.hubble.isConfigured.mockReturnValue(false);
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: 1, expectedTotalRupees: 800 })).rejects.toThrow(/not configured/);
  });
});

describe('buying', () => {
  it('buys once per row with the stored reference, stores the code, sends voucher_code with the code as a secret, completes', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 300, 'Flipkart']]);
    const refs = t.rows.map((r) => r.hubbleReferenceId);
    const pass = await t.processor.drain({ campaignId: id });
    expect(pass.bought).toBe(2);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
    expect(t.hubble.placeOrder.mock.calls.map((c) => c[0].referenceId)).toEqual(refs);
    expect(t.hubble.placeOrder.mock.calls[0][0]).toMatchObject({ productId: 'P_AMZ', amount: 1000, denominationDetails: [{ denomination: 1000, quantity: 1 }] });
    expect(t.rows.every((r) => r.status === 'BOUGHT' && r.voucherCode === CODE && r.hubbleAccount === FP)).toBe(true);
    const send = t.notifications.sendTrackedWhatsappTemplate.mock.calls[0][0] as never as {
      clientId: string; templateName: string; bodyValues: string[]; secretValues: string[]; phone: string; eventKey: string;
    };
    // Receipts are ALWAYS filed under the platform tenant — never the billed client's delivery report.
    expect(send).toMatchObject({ clientId: 'gifsy', templateName: 'voucher_code', phone: '9876543210', eventKey: 'VOUCHER_DISPERSAL' });
    expect(send.bodyValues).toEqual(['Asha', '₹1,000', 'Bajaj Loyalty', 'Amazon Pay', CODE]);
    expect(send.secretValues).toContain(CODE);
    // A second pass buys nothing more.
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
    expect(t.campaigns[0].status).toBe('COMPLETED');
    // Audits never carry the code.
    expect(JSON.stringify(t.audits.map((a) => a.metadata))).not.toContain(CODE);
  });

  it('receipt clientId falls back to the gifsy platform tenant when no billed client', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'Gifsy Rewards', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay']]));
    await t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: 1, expectedTotalRupees: 800 });
    await t.processor.drain({ campaignId: c.id });
    expect((t.notifications.sendTrackedWhatsappTemplate.mock.calls[0][0] as never as { clientId: string }).clientId).toBe('gifsy');
  });

  it('a TIMEOUT is never "not bought": PENDING_RECONCILE, and the engine never places again (lookup only)', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockRejectedValueOnce(new Error('Hubble request failed: Hubble did not respond within 15s'));
    t.hubble.getOrderByReference.mockRejectedValueOnce(new Error('timeout'));
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_INDETERMINATE' });
    expect(t.audits.some((a) => a.metadata.event === 'VOUCHER_DISPERSAL_PENDING')).toBe(true);
    // Later pass: Hubble now has it → bought via lookup, placeOrder NOT called again.
    t.rows[0].lastReconcileAt = null;
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
    expect(t.rows[0].status).toBe('BOUGHT');
    expect(t.notifications.sendTrackedWhatsappTemplate).toHaveBeenCalledTimes(1);
  });

  it('indeterminate place + "no order yet" stays PENDING (never failed)', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockRejectedValueOnce(new Error('Hubble placeOrder non-success HTTP 502'));
    t.hubble.getOrderByReference.mockResolvedValueOnce(null);
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0].status).toBe('PENDING_RECONCILE');
    expect(t.campaigns[0].status).toBe('PROCESSING');
  });

  it('a definitive rejection is BUY_FAILED only when the canary verifies "no order"', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockRejectedValueOnce(new HubblePlaceOrderRejectedError(400, 'E102'));
    t.hubble.getOrderByReference.mockResolvedValueOnce(null);
    await t.processor.drain({ campaignId: id });
    // No known delivered order on the account → canary fails closed → PENDING, not failed.
    expect(t.rows[0]).toMatchObject({ status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_REJECTED_UNVERIFIED' });

    // With a verified canary (a bought row on the same account that Hubble returns as SUCCESS):
    const t2 = setup();
    const id2 = await confirmed(t2, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay']]);
    t2.hubble.placeOrder
      .mockImplementationOnce(async (p: { referenceId: string }) => ({ id: `H-${p.referenceId}`, status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] }))
      .mockRejectedValueOnce(new HubblePlaceOrderRejectedError(422, 'E200'));
    const firstRef = t2.rows[0].hubbleReferenceId;
    t2.hubble.getOrderByReference.mockImplementation(async (ref: string) =>
      ref === firstRef ? { id: `H-${firstRef}`, referenceId: firstRef, status: 'SUCCESS', vouchers: [] } : null,
    );
    await t2.processor.drain({ campaignId: id2 });
    expect(t2.rows[1]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'REJECTED' });
    expect(t2.rows[1].buyFailureReason).toMatch(/E200/);
    expect(t2.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
  });

  it("Hubble's FAILED body → BUY_FAILED with the reason", async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED', failureReason: 'Brand out of stock' } as never);
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'Brand out of stock' });
  });

  it('PROCESSING → pending; the webhook reconcile delivers it', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'PROCESSING' } as never);
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_PROCESSING', hubbleOrderId: 'H1' });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'SUCCESS', vouchers: [{ cardNumber: CODE, cardPin: '4321' }] });
    const rewards = { reconcileHubbleOrder: jest.fn() };
    const moduleRef = { get: jest.fn(() => t.processor) };
    const ctl = new HubbleWebhookController(rewards as never, moduleRef as never);
    (ctl as unknown as { assertSignature: () => void }).assertSignature = () => undefined;
    const res = await ctl.webhook({ rawBody: Buffer.from('{}') } as never, { referenceId: t.rows[0].hubbleReferenceId, status: 'SUCCESS' }, 'sig');
    expect(res).toMatchObject({ reconciled: true, outcome: 'DISPERSAL_BOUGHT' });
    expect(rewards.reconcileHubbleOrder).not.toHaveBeenCalled();
    expect(t.rows[0]).toMatchObject({ status: 'BOUGHT', voucherCode: CODE, voucherPin: '4321' });
    expect(t.notifications.sendTrackedWhatsappTemplate).toHaveBeenCalledTimes(1);
    const sent = (t.notifications.sendTrackedWhatsappTemplate.mock.calls[0][0] as never as { bodyValues: string[]; secretValues: string[] });
    expect(sent.bodyValues[4]).toBe(`${CODE} | PIN: 4321`);
    expect(sent.secretValues).toEqual(expect.arrayContaining([CODE, '4321']));
    // A non-dispersal reference still goes to rewards.
    await ctl.webhook({ rawBody: Buffer.from('{}') } as never, { referenceId: 'cm123order' }, 'sig');
    expect(rewards.reconcileHubbleOrder).toHaveBeenCalledWith('cm123order', expect.anything());
  });

  it('two concurrent passes never place the same row twice', async () => {
    const t = setup();
    await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    const row = { ...t.rows[0] };
    const [a, b] = await Promise.all([t.processor.buyRow(row as never), t.processor.buyRow(row as never)]);
    expect([a, b].sort()).toEqual(['BOUGHT', 'LOST']);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('the budget is re-checked before every buy (never exceeded)', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay']], 2000);
    t.campaigns[0].budgetPaise = 150000n; // simulate a tighter ceiling after confirm
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
    expect(t.rows[1]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'BUDGET' });
  });

  it('an amount the brand cannot issue right now is NOT sent to Hubble', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 300, 'Flipkart']]);
    t.hubble.getProduct.mockResolvedValueOnce({ productId: 'P_FK', name: 'Flipkart', denominationType: 'FIXED', denominations: [1250], minValue: 100, maxValue: 10000, maxVouchersPerOrder: 1 });
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).not.toHaveBeenCalled();
    expect(t.rows[0]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'NOT_SENT' });
  });

  it('a stale BUYING claim (worker died) goes to PENDING_RECONCILE — never re-placed', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    Object.assign(t.rows[0], { status: 'BUYING', buyingAt: new Date(Date.now() - STALE_BUYING_MS - 1000) });
    t.hubble.getOrderByReference.mockResolvedValue(null);
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'PENDING_RECONCILE', pendingReason: 'STALE_BUYING' });
    expect(t.hubble.placeOrder).not.toHaveBeenCalled();
  });
});

describe('retry-buy', () => {
  async function pendingRow(t: ReturnType<typeof setup>) {
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockRejectedValueOnce(new Error('timeout'));
    t.hubble.getOrderByReference.mockRejectedValueOnce(new Error('timeout'));
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0].status).toBe('PENDING_RECONCILE');
    return id;
  }

  it('refuses an indeterminate row younger than 2 hours (no Hubble call to buy)', async () => {
    const t = setup();
    const id = await pendingRow(t);
    await expect(t.svc.retryBuy(ADMIN, id, t.rows[0].id)).rejects.toThrow(/2 hours/);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
    expect(t.audits.some((a) => a.metadata.outcome === 'REFUSED_TOO_RECENT')).toBe(true);
  });

  it('after 2 h: canary-unverified "no order" is refused; verified → re-queued with the SAME reference', async () => {
    const t = setup();
    const id = await pendingRow(t);
    const ref = t.rows[0].hubbleReferenceId;
    const old = new Date(Date.now() - DISPERSAL_RETRY_MIN_AGE_MS - 60_000);
    Object.assign(t.rows[0], { placeAttemptAt: old, pendingSince: old });
    t.hubble.getOrderByReference.mockResolvedValue(null);
    await expect(t.svc.retryBuy(ADMIN, id, t.rows[0].id)).rejects.toThrow(/could not be verified/);

    // Add a known bought voucher on the same account so the canary can verify.
    t.rows.push({ ...t.rows[0], id: 'canary-row', campaignId: 'other', status: 'BOUGHT', hubbleReferenceId: 'vdcanary', hubbleOrderId: 'HC', hubbleAccount: FP, boughtAt: new Date(), dedupePhone: null });
    t.hubble.getOrderByReference.mockImplementation(async (r: string) => (r === 'vdcanary' ? { id: 'HC', referenceId: 'vdcanary', status: 'SUCCESS' } : null));
    const res = await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(res.row.status).toBe('QUEUED');
    expect(t.rows[0].hubbleReferenceId).toBe(ref);
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
    expect(t.hubble.placeOrder.mock.calls[1][0].referenceId).toBe(ref);
    expect(t.rows[0].status).toBe('BOUGHT');
  });

  it('a pending row Hubble now holds is applied — never bought again', async () => {
    const t = setup();
    const id = await pendingRow(t);
    const old = new Date(Date.now() - DISPERSAL_RETRY_MIN_AGE_MS - 60_000);
    Object.assign(t.rows[0], { placeAttemptAt: old, pendingSince: old });
    t.hubble.getOrderByReference.mockResolvedValue({ id: 'H1', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    const res = await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(res.message).toMatch(/nothing bought again/);
    expect(t.rows[0].status).toBe('BOUGHT');
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('BUY_FAILED by Hubble: re-checked first; FAILED → new reference (old kept), never-sent → same reference', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED', failureReason: 'x' } as never);
    await t.processor.drain({ campaignId: id });
    const oldRef = t.rows[0].hubbleReferenceId;
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(t.rows[0].status).toBe('QUEUED');
    expect(t.rows[0].hubbleReferenceId).not.toBe(oldRef);
    expect(t.rows[0].previousReferenceIds).toEqual([oldRef]);
    expect(t.campaigns[0].status).toBe('PROCESSING');

    const t2 = setup();
    const id2 = await confirmed(t2, [['9876543210', 'A', 300, 'Flipkart']]);
    t2.hubble.getProduct.mockResolvedValueOnce({ productId: 'P_FK', name: 'Flipkart', denominationType: 'FIXED', denominations: [1250], minValue: 100, maxValue: 10000, maxVouchersPerOrder: 1 });
    await t2.processor.drain({ campaignId: id2 });
    const ref2 = t2.rows[0].hubbleReferenceId;
    await t2.svc.retryBuy(ADMIN, id2, t2.rows[0].id);
    expect(t2.rows[0]).toMatchObject({ status: 'QUEUED', hubbleReferenceId: ref2 });
    expect(t2.hubble.getOrderByReference).not.toHaveBeenCalled();
  });

  it('BUY_FAILED but Hubble now SUCCESS → delivered, not bought again; BOUGHT rows cannot be retried', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' } as never);
    await t.processor.drain({ campaignId: id });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(t.rows[0].status).toBe('BOUGHT');
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
    // Idempotent: retrying a row that already has its voucher returns its state, buys nothing.
    const again = await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(again.message).toMatch(/already has its voucher/);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('a repeated retry while the first is queued returns the queued state (same reference, no second requeue)', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.processor.drain({ campaignId: id });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    const ref = t.rows[0].hubbleReferenceId;
    const again = await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(again.message).toMatch(/Already queued/);
    expect(t.rows[0].hubbleReferenceId).toBe(ref);
    expect(t.rows[0].previousReferenceIds.length).toBe(1);
  });

  it('canRetryBuy is false on a cancelled campaign', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.processor.drain({ campaignId: id, maxBuys: 1 });
    await t.svc.cancel(ADMIN, id);
    const page = await t.svc.rows(ADMIN, id, { status: 'BUY_FAILED' });
    expect(page.rows[0]).toMatchObject({ status: 'BUY_FAILED', canRetryBuy: false });
  });
});

describe('resend', () => {
  it('re-sends a bought voucher with a NEW receipt and never buys; refuses a non-bought row', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay']]);
    t.hubble.placeOrder.mockImplementationOnce(async (p: { referenceId: string }) => ({ id: `H-${p.referenceId}`, status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] }));
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H2', status: 'FAILED' } as never);
    await t.processor.drain({ campaignId: id });
    const first = t.rows[0].whatsappReceiptId;
    const v = await t.svc.resend(ADMIN, id, t.rows[0].id);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
    expect(t.rows[0].whatsappReceiptId).not.toBe(first);
    expect(t.rows[0].resendCount).toBe(1);
    expect(v).toMatchObject({ messageStatus: 'SENT', canResend: true });
    expect(t.audits.some((a) => a.metadata.event === 'VOUCHER_DISPERSAL_RESENT' && a.actorId === 'admin-1')).toBe(true);
    await expect(t.svc.resend(ADMIN, id, t.rows[1].id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot resend while the first send is still pending', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.buyRow({ ...t.rows[0] } as never); // bought, message not yet sent
    expect(t.rows[0].status).toBe('BOUGHT');
    expect((await t.svc.rows(ADMIN, id, {})).rows[0]).toMatchObject({ canResend: false, messageStatus: null });
    await expect(t.svc.resend(ADMIN, id, t.rows[0].id)).rejects.toThrow(/still being sent/);
  });
});

describe('cancel', () => {
  it('before confirm cancels everything', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 5000 });
    await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 1000, 'Amazon Pay']]));
    const r = await t.svc.cancel(ADMIN, c.id);
    expect(r.campaign).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect(t.rows[0].status).toBe('CANCELLED');
    await expect(t.svc.cancel(ADMIN, c.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('while processing stops QUEUED rows only — bought and in-flight rows are untouched and nothing more is bought', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay'], ['9876543212', 'C', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id, maxBuys: 1 });
    t.rows[1].status = 'PENDING_RECONCILE';
    const r = await t.svc.cancel(ADMIN, id);
    expect(r).toMatchObject({ cancelledRows: 1, stillWithHubble: 1, alreadyBought: 1 });
    expect(t.rows.map((x) => x.status)).toEqual(['BOUGHT', 'PENDING_RECONCILE', 'CANCELLED']);
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });
});

describe('reads: masking + delivery-status join', () => {
  it('rows / detail / report never expose the code; WhatsApp status comes from the receipt', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    const rcpt = t.receipts.find((r) => r.id === t.rows[0].whatsappReceiptId)!;
    Object.assign(rcpt, { status: 'DELIVERED', deliveredAt: new Date('2026-11-16T10:00:00Z') });

    const page = await t.svc.rows(ADMIN, id, {});
    expect(JSON.stringify(page)).not.toContain(CODE);
    expect(page.rows[0]).toMatchObject({ voucherCodeMasked: '••••9999', messageStatus: 'DELIVERED', canRetryBuy: false, canResend: true });
    // Same rule as audit rows: last 4 only for a 12+ char code.
    expect(maskDispersalCode('ABCDEFGHIJKL')).toBe('••••IJKL');
    expect(maskDispersalCode('ABCDEFGHIJK')).toBe('••••');
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 100 });

    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ bought: 1, messageSent: 1, delivered: 1, read: 0, messageFailed: 0, spentRupees: 1000 });
    expect(JSON.stringify(d)).not.toContain(CODE);

    const rep = await t.svc.report(ADMIN, id);
    const wb = XLSX.read(rep.buffer, { type: 'buffer' });
    const sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    expect(sheet[0]).toMatchObject({ Row: 2, Phone: '9876543210', 'Voucher status': 'BOUGHT', 'WhatsApp status': 'DELIVERED' });
    expect(JSON.stringify(sheet)).not.toContain(CODE);

    // The mirror survives receipt retention.
    await t.processor.mirrorMessageStatuses(id);
    t.receipts.splice(0, t.receipts.length);
    expect((await t.svc.rows(ADMIN, id, {})).rows[0].messageStatus).toBe('DELIVERED');
  });

  it('a failed WhatsApp send is visible (row, summary, audit) and the campaign completes WITH ERRORS', async () => {
    const t = setup();
    t.notifications.sendTrackedWhatsappTemplate.mockResolvedValueOnce({ receiptId: null as never, requestId: null as never, error: 'MSG91 rejected: ••••' });
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    const page = await t.svc.rows(ADMIN, id, {});
    expect(page.rows[0]).toMatchObject({ messageStatus: 'FAILED', messageError: 'MSG91 rejected: ••••' });
    expect((await t.svc.detail(ADMIN, id)).summary.messageFailed).toBe(1);
    expect(t.audits.some((a) => a.metadata.event === 'VOUCHER_DISPERSAL_MESSAGE_FAILED')).toBe(true);
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
  });
});

describe('audit fix round', () => {
  it('BUYING M1: a Hubble-failed row whose reference reached Hubble still counts against the budget', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543211', 'B', 1000, 'Amazon Pay']], 2000);
    t.hubble.placeOrder.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED' });
    expect(t.rows[0].referenceSentAt).toBeTruthy();
    expect(t.rows[1].status).toBe('BOUGHT');
    // Tighten the budget: the failed row's ₹1,000 is still "possibly committed" → a re-queued attempt
    // is refused at the claim (BUDGET), never bought over the ceiling.
    t.campaigns[0].budgetPaise = 150000n;
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'FAILED' });
    await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(t.rows[0].status).toBe('QUEUED');
    await t.processor.drain({ campaignId: id });
    expect(t.rows[0]).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'BUDGET' });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
  });

  it('BUYING M1: a BUDGET failure on a row whose reference was sent earlier stays in the reconcile sweep', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    const ref = t.rows[0].hubbleReferenceId;
    Object.assign(t.rows[0], {
      status: 'BUY_FAILED',
      buyFailureSource: 'BUDGET',
      referenceSentAt: new Date(Date.now() - 60_000),
      placeAttemptAt: new Date(Date.now() - 60_000),
    });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H1', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.getOrderByReference).toHaveBeenCalledWith(ref);
    expect(t.rows[0].status).toBe('BOUGHT');
    expect(t.hubble.placeOrder).not.toHaveBeenCalled();
  });

  it('BUYING L-M2: retry re-queue + re-open run under the campaign lock; a cancelled campaign refuses inside it', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 300, 'Flipkart']]);
    t.hubble.getProduct.mockResolvedValueOnce({ productId: 'P_FK', name: 'Flipkart', denominationType: 'FIXED', denominations: [1250], minValue: 100, maxValue: 10000, maxVouchersPerOrder: 1 });
    await t.processor.drain({ campaignId: id });
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
    await t.svc.retryBuy(ADMIN, id, t.rows[0].id);
    expect(t.rows[0].status).toBe('QUEUED');
    expect(t.campaigns[0]).toMatchObject({ status: 'PROCESSING', completedAt: null });

    const t2 = setup();
    const id2 = await confirmed(t2, [['9876543210', 'A', 300, 'Flipkart']]);
    t2.hubble.getProduct.mockResolvedValueOnce({ productId: 'P_FK', name: 'Flipkart', denominationType: 'FIXED', denominations: [1250], minValue: 100, maxValue: 10000, maxVouchersPerOrder: 1 });
    await t2.processor.drain({ campaignId: id2 });
    // The campaign is cancelled between the service's pre-check and the re-queue transaction.
    const orig = t2.processor.requeueUnderLock.bind(t2.processor);
    jest.spyOn(t2.processor, 'requeueUnderLock').mockImplementation(async (...a) => {
      t2.campaigns[0].status = 'CANCELLED';
      return orig(...a);
    });
    await expect(t2.svc.retryBuy(ADMIN, id2, t2.rows[0].id)).rejects.toThrow(/cancelled meanwhile/);
    expect(t2.rows[0].status).toBe('BUY_FAILED');
  });

  it('BUYING L3: a Hubble SUCCESS for a superseded reference is audited + logged, never silent', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    const stale = { ...t.rows[0], status: 'PENDING_RECONCILE' };
    t.rows[0].hubbleReferenceId = 'vdnewreference000000000000';
    const out = await t.processor.applyBody(stale as never, { id: 'H9', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    expect(out).toBe('SKIPPED');
    expect(t.rows[0].voucherCode).toBeNull();
    const a = t.audits.find((x) => x.metadata.event === 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY');
    expect(a?.metadata).toMatchObject({ referenceSuperseded: true, hubbleOrderId: 'H9' });
    expect(JSON.stringify(a)).not.toContain(CODE);
    void id;
  });

  it('BUYING L4: the drain needs its OWN secret (no fallback to PUSH_DRAIN_SECRET)', async () => {
    const { VoucherDispersalDrainController } = await import('./voucher-dispersal.controller');
    const t = setup();
    const ctl = new VoucherDispersalDrainController(t.processor);
    const prev = { v: process.env.VOUCHER_DISPERSAL_DRAIN_SECRET, p: process.env.PUSH_DRAIN_SECRET };
    delete process.env.VOUCHER_DISPERSAL_DRAIN_SECRET;
    process.env.PUSH_DRAIN_SECRET = 'push-secret';
    await expect(ctl.drain('push-secret')).rejects.toBeInstanceOf(ForbiddenException);
    process.env.VOUCHER_DISPERSAL_DRAIN_SECRET = 'vd-secret';
    await expect(ctl.drain('push-secret')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.drain('vd-secret')).resolves.toMatchObject({ bought: 0 });
    process.env.VOUCHER_DISPERSAL_DRAIN_SECRET = prev.v;
    process.env.PUSH_DRAIN_SECRET = prev.p;
    if (prev.v === undefined) delete process.env.VOUCHER_DISPERSAL_DRAIN_SECRET;
    if (prev.p === undefined) delete process.env.PUSH_DRAIN_SECRET;
  });

  it('BUYING L5: a send whose claim was taken over never writes; the stale sweep waits 30 min', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.buyRow({ ...t.rows[0] } as never);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    t.rows[0].messageClaimedAt = old;
    expect(await t.processor.surfaceStaleMessageClaims(id)).toEqual([]); // 20 min < 30 min
    t.rows[0].messageClaimedAt = new Date(); // a newer claim (resend) took over
    const r = await t.processor.deliver(t.rows[0].id, old);
    expect(r.error).toMatch(/took over/);
    expect(t.notifications.sendTrackedWhatsappTemplate).not.toHaveBeenCalled();
    t.rows[0].messageClaimedAt = new Date(Date.now() - 31 * 60 * 1000);
    expect(await t.processor.surfaceStaleMessageClaims(id)).toEqual([id]);
    expect(t.rows[0]).toMatchObject({ messageStatus: 'UNKNOWN' });
  });

  it('DATA M1+M2: a failed resend is never hidden behind the old DELIVERED, and the campaign flips both ways', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    const first = t.receipts.find((r) => r.id === t.rows[0].whatsappReceiptId)!;
    Object.assign(first, { status: 'DELIVERED', deliveredAt: new Date() });
    await t.processor.drain({ campaignId: id });
    expect(t.campaigns[0].status).toBe('COMPLETED');

    t.notifications.sendTrackedWhatsappTemplate.mockResolvedValueOnce({ receiptId: null as never, requestId: null as never, error: 'MSG91 down' });
    const v = await t.svc.resend(ADMIN, id, t.rows[0].id);
    expect(v).toMatchObject({ messageStatus: 'FAILED', messageError: 'MSG91 down' });
    expect(t.rows[0].whatsappReceiptId).toBeNull();
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
    await t.processor.mirrorMessageStatuses(id); // the old DELIVERED receipt must not overwrite it
    expect(t.rows[0].messageStatus).toBe('FAILED');

    const ok = await t.svc.resend(ADMIN, id, t.rows[0].id);
    expect(ok.messageStatus).toBe('SENT');
    expect(t.campaigns[0].status).toBe('COMPLETED');

    // A late WhatsApp failure (via the receipt) flips it back.
    const rc = t.receipts.find((r) => r.id === t.rows[0].whatsappReceiptId)!;
    Object.assign(rc, { status: 'FAILED', failureReason: 'number not on WhatsApp' });
    await t.processor.drain({ campaignId: id });
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
  });

  it('DATA L10: a receipt stuck QUEUED after a successful send still reads SENT', async () => {
    const t = setup();
    t.notifications.sendTrackedWhatsappTemplate.mockImplementationOnce(async () => {
      const r = await t.prisma.messageDeliveryReceipt.create({ data: { clientId: 'gifsy', channel: 'WHATSAPP', crqid: 'q', status: 'QUEUED' } });
      return { receiptId: r.id, requestId: 'x', error: null };
    });
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    expect((await t.svc.rows(ADMIN, id, {})).rows[0].messageStatus).toBe('SENT');
    expect(t.rows[0].messageStatus).toBe('SENT');
  });

  it('DATA L11: resend is capped at 3 per row', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    for (let i = 0; i < 3; i++) await t.svc.resend(ADMIN, id, t.rows[0].id);
    expect((await t.svc.rows(ADMIN, id, {})).rows[0].canResend).toBe(false);
    await expect(t.svc.resend(ADMIN, id, t.rows[0].id)).rejects.toThrow(/3 times/);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('DATA L11: a phone that got a voucher in another campaign in the last 30 days is WARNED (not blocked)', async () => {
    const t = setup();
    const first = await confirmed(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: first });
    const c = await t.svc.createCampaign(ADMIN, { name: 'Second', programLabel: 'P', budgetRupees: 5000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'Asha', 500, 'Amazon Pay'], ['9876543211', 'Ravi', 500, 'Amazon Pay']]));
    expect(p.summary.warningCount).toBe(1);
    expect(p.rows[0].warning).toMatch(/^Already got a ₹1,000 Amazon Pay voucher on \d{2} \w{3} \d{4} in campaign "Diwali"$/);
    expect(p.rows[0].status).toBe('VALID');
    expect((await t.svc.rows(ADMIN, c.id, {})).rows[0].warning).toMatch(/Already got/);
    await expect(t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: 2, expectedTotalRupees: 1000 })).resolves.toMatchObject({ status: 'PROCESSING' });
  });

  it('DATA L6: cancelling before confirm keeps INVALID / DUPLICATE reasons; valid counts stay consistent', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 5000 });
    await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 1000, 'Amazon Pay'], ['9876543210', 'B', 1000, 'Amazon Pay'], ['12', 'C', 1000, 'Amazon Pay']]));
    await t.svc.cancel(ADMIN, c.id);
    expect(t.rows.map((r) => r.status)).toEqual(['CANCELLED', 'DUPLICATE', 'INVALID']);
    expect(t.rows[1].invalidReason).toMatch(/Same phone/);
    const [listed] = await t.svc.list(ADMIN, {});
    const d = await t.svc.detail(ADMIN, c.id);
    expect(listed.summary).toMatchObject({ valid: 0, invalid: 1, duplicates: 1, cancelled: 1 });
    expect(d.summary).toMatchObject({ valid: 0, invalid: 1, duplicates: 1, cancelled: 1 });
  });

  it('DATA L8: the preview reports skipped blank rows', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 5000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 1000, 'Amazon Pay'], [null, null, null, null], ['9876543211', 'B', 1000, 'Amazon Pay']]));
    expect(p.summary).toMatchObject({ skippedBlankRows: 1, skippedNote: '1 row skipped: 1 blank', hiddenRowsIncluded: 0 });
  });

  it('DATA L12: report times are IST and a raw invalid phone is printed without an escape quote', async () => {
    const t = setup();
    const id = await confirmed(t, [['9876543210', 'A', 1000, 'Amazon Pay'], ['+91 12345', 'B', 1000, 'Amazon Pay'], ['=HYPERLINK("x")', 'C', 1000, 'Amazon Pay']]);
    await t.processor.drain({ campaignId: id });
    t.rows[0].boughtAt = new Date('2026-11-16T20:00:00Z'); // 01:30 IST next day
    const rep = await t.svc.report(ADMIN, id);
    const wb = XLSX.read(rep.buffer, { type: 'buffer' });
    const sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    expect(sheet[0]['Bought at (IST)']).toBe('2026-11-17 01:30');
    expect(sheet[1].Phone).toBe('+91 12345');
    expect(sheet[2].Phone).toBe(`'=HYPERLINK("x")`);
    expect(JSON.stringify(sheet)).not.toContain(CODE);
  });
});
