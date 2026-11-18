/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — UI ⇄ server CONTRACT fixture.
 *
 * Drives the REAL service (create → upload → confirm → process → list / detail / rows / resend /
 * retry-buy / cancel) on the fake Prisma and compares the KEY SHAPE of every reply with the fixture the
 * platform UI is tested against: platform/src/lib/__tests__/fixtures/voucher-dispersal-server-contract.json.
 * The platform contract test runs the UI normalisers over that fixture and fails if a field the UI
 * reads is missing. So:
 *   - a server field renamed / removed  → THIS test fails (shape drift) — regenerate the fixture and the
 *     platform contract test then shows whether the UI breaks;
 *   - the UI reads a field the server does not send → the platform test fails.
 * Regenerate after an intended server change:  UPDATE_VD_CONTRACT=1 npx jest src/voucher-dispersal/voucher-dispersal.contract.spec.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { VoucherDispersalService } from './voucher-dispersal.service';
import { VoucherDispersalProcessor } from './voucher-dispersal.processor';
import { makeFakePrisma } from './fake-prisma.test-spec';

const FIXTURE = path.resolve(__dirname, '../../../platform/src/lib/__tests__/fixtures/voucher-dispersal-server-contract.json');
const ADMIN = { sub: 'admin-1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Admin' } as never;

function setup() {
  process.env.VOUCHER_DISPERSAL_BRANDS = JSON.stringify([
    { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: 'P_AMZ' },
    { key: 'FLIPKART', label: 'Flipkart', productId: 'P_FK' },
  ]);
  const db = makeFakePrisma();
  const hubble = {
    isConfigured: jest.fn(() => true),
    accountFingerprint: jest.fn(() => 'api.myhubble.money#abcdef0123456789'),
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
      vouchers: [{ cardNumber: 'AMZN-1234-5678-9999', cardPin: null }],
    })),
    getOrderByReference: jest.fn(async (): Promise<any> => null),
  };
  const notifications = {
    sendTrackedWhatsappTemplate: jest.fn(async () => {
      const r = await db.prisma.messageDeliveryReceipt.create({ data: { clientId: 'gifsy', channel: 'WHATSAPP', crqid: 'c', status: 'SENT', sentAt: new Date() } });
      return { receiptId: r.id as string, requestId: 'req', error: null as string | null };
    }),
  };
  const processor = new VoucherDispersalProcessor(db.prisma as never, hubble as never, notifications as never);
  processor.sleep = async () => undefined;
  jest.spyOn(processor, 'kick').mockImplementation(() => undefined);
  const svc = new VoucherDispersalService(db.prisma as never, hubble as never, processor);
  return { ...db, svc, processor };
}

function file(rows: unknown[][]): Express.Multer.File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note'], ...rows]), 'Recipients');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), originalname: 'r.xlsx' } as Express.Multer.File;
}

/** JSON as the HTTP layer sends it (Dates → ISO strings, undefined dropped). */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

/** Every key path in a value; array items are merged under `[]`. */
export function keyShape(v: unknown, prefix = ''): string[] {
  const out = new Set<string>();
  const walk = (x: unknown, p: string) => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item, `${p}[]`);
      return;
    }
    if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) {
        const kp = p ? `${p}.${k}` : k;
        out.add(kp);
        walk(val, kp);
      }
    }
  };
  walk(v, prefix);
  return [...out].sort();
}

async function buildContract() {
  const t = setup();
  // Campaign A: one bought + sent voucher → gives campaign B's upload a cross-campaign warning.
  const a = await t.svc.createCampaign(ADMIN, { name: 'Earlier', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees: 5000 });
  const pa = await t.svc.upload(ADMIN, a.id, file([['9876543210', 'Asha', 1000, 'Amazon Pay']]));
  await t.svc.confirm(ADMIN, a.id, { previewId: pa.previewId, expectedValidCount: 1, expectedTotalRupees: 1000 });
  await t.processor.drain({ campaignId: a.id });

  // Campaign B: warning row, duplicate, invalid, blank row (skipped).
  const create = await t.svc.createCampaign(ADMIN, { name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', note: 'Q3', budgetRupees: 10000 });
  const upload = await t.svc.upload(ADMIN, create.id, file([
    ['9876543210', 'Asha', 500, 'Amazon Pay', 'again'],
    ['9876543211', 'Ravi', 300, 'Flipkart'],
    [],
    ['9876543211', 'Ravi again', 300, 'Flipkart'],
    ['12', 'Bad', 300, 'Flipkart'],
  ]));
  const confirm = await t.svc.confirm(ADMIN, create.id, {
    previewId: upload.previewId,
    expectedValidCount: upload.summary.valid,
    expectedTotalRupees: upload.summary.totalRupees,
  });
  const processed = await t.svc.process(ADMIN, create.id);
  const detail = await t.svc.detail(ADMIN, create.id);
  const rows = await t.svc.rows(ADMIN, create.id, {});
  const list = await t.svc.list(ADMIN, {});
  const brands = await t.svc.brands(ADMIN);
  const boughtA = t.rows.find((r: any) => r.campaignId === a.id)!;
  const resend = await t.svc.resend(ADMIN, a.id, boughtA.id);
  const retryBuy = await t.svc.retryBuy(ADMIN, a.id, boughtA.id);
  const c = await t.svc.createCampaign(ADMIN, { name: 'Oops', programLabel: 'Gifsy Rewards', budgetRupees: 100 });
  const cancel = await t.svc.cancel(ADMIN, c.id);

  // Campaign A (finished) — edit, then "Add more people": a discarded batch, then a confirmed one.
  const edit = await t.svc.editCampaign(ADMIN, a.id, { name: 'Earlier (Nov)', budgetRupees: 6000 });
  const batchUpload = await t.svc.uploadBatch(ADMIN, a.id, file([
    ['9876543210', 'Asha', 500, 'Amazon Pay'], // already sent in batch 1 → DUPLICATE
    ['9876543215', 'Kiran', 300, 'Flipkart'],
  ]));
  const batchPreview = await t.svc.batchPreview(ADMIN, a.id, batchUpload.batchNumber);
  const batchDiscard = await t.svc.discardBatch(ADMIN, a.id, batchUpload.batchNumber);
  const again = await t.svc.uploadBatch(ADMIN, a.id, file([['9876543215', 'Kiran', 300, 'Flipkart']]));
  const batchConfirm = await t.svc.confirmBatch(ADMIN, a.id, again.batchNumber, {
    previewId: again.previewId!,
    expectedValidCount: again.summary.valid,
    expectedTotalRupees: again.summary.totalRupees,
  });
  await t.processor.drain({ campaignId: a.id });
  const detailWithBatches = await t.svc.detail(ADMIN, a.id);
  const rowsOfBatch = await t.svc.rows(ADMIN, a.id, { batch: again.batchNumber });
  // A row whose last Hubble answer we do not recognise → "Mark as not bought" (campaign B).
  const odd = t.rows.find((r: any) => r.campaignId === create.id && r.status === 'BOUGHT')!;
  Object.assign(odd, { status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', voucherCode: null, lastReconcileResult: 'HUBBLE_ON_HOLD' });
  const markNotBought = await t.svc.markNotBought(ADMIN, create.id, odd.id, { reason: 'Hubble support confirmed not bought' });

  return wire({
    brands, create, upload, confirm, process: processed, list, detail, rows, resend, retryBuy, cancel,
    edit, batchUpload, batchPreview, batchDiscard, batchConfirm, detailWithBatches, rowsOfBatch, markNotBought,
  });
}

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

describe('voucher-dispersal UI contract fixture', () => {
  it('server reply shapes match the fixture the UI is tested against', async () => {
    const live = await buildContract();
    // Sanity: the fixture exercises the new fields with real values.
    expect(live.upload.rows.some((r: any) => typeof r.warning === 'string' && r.warning.startsWith('Already got'))).toBe(true);
    expect(live.upload.summary.warningCount).toBe(1);
    expect(live.upload.summary.skippedNote).toEqual(expect.stringContaining('blank'));
    expect(live.rows.rows.some((r: any) => r.voucherCodeMasked)).toBe(true);
    expect(JSON.stringify(live)).not.toContain('AMZN-1234-5678-9999'); // never a full code
    expect(live.batchUpload.rows.some((r: any) => r.status === 'DUPLICATE' && /batch 1/.test(r.invalidReason))).toBe(true);
    expect(live.detailWithBatches.batches.map((b: any) => b.status)).toEqual(['CONFIRMED', 'DISCARDED', 'CONFIRMED']);
    expect(live.detailWithBatches.edits.length).toBe(1);

    if (process.env.UPDATE_VD_CONTRACT === '1') {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
    }
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(`Missing ${FIXTURE} — run with UPDATE_VD_CONTRACT=1 to create it.`);
    }
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const key of Object.keys(live)) {
      expect({ endpoint: key, keys: keyShape(live[key]) }).toEqual({ endpoint: key, keys: keyShape(fixture[key]) });
    }
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(live).sort());
  });
});
