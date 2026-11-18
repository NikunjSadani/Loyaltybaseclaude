/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST-ONLY kit for Voucher Dispersal specs (excluded from the build; not a test file itself): a service +
 * processor wired to the in-memory fake Prisma and a fake Hubble / WhatsApp, plus xlsx + campaign helpers.
 */
import * as XLSX from 'xlsx';
import { VoucherDispersalService } from './voucher-dispersal.service';
import { VoucherDispersalProcessor } from './voucher-dispersal.processor';
import { makeFakePrisma } from './fake-prisma.test-spec';

export const ADMIN = { sub: 'admin-1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Admin' } as never;
export const ADMIN2 = { sub: 'admin-2', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'A2' } as never;
export const CODE = 'AMZN-1234-5678-9999';

export function setup(fakeOpts: Parameters<typeof makeFakePrisma>[0] = {}) {
  process.env.VOUCHER_DISPERSAL_BRANDS = JSON.stringify([
    { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: 'P_AMZ' },
    { key: 'FLIPKART', label: 'Flipkart', productId: 'P_FK' },
  ]);
  const db = makeFakePrisma(fakeOpts);
  const hubble = {
    isConfigured: jest.fn(() => true),
    accountFingerprint: jest.fn(() => 'api.myhubble.money#abcdef0123456789'),
    getProduct: jest.fn(async (id: string): Promise<any> => ({
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
  const notifications = {
    sendTrackedWhatsappTemplate: jest.fn(async (_p: any) => {
      const r = await db.prisma.messageDeliveryReceipt.create({ data: { clientId: 'gifsy', channel: 'WHATSAPP', crqid: 'c', status: 'SENT', sentAt: new Date() } });
      return { receiptId: r.id as string, requestId: 'req', error: null as string | null };
    }),
  };
  const processor = new VoucherDispersalProcessor(db.prisma as never, hubble as never, notifications as never);
  processor.sleep = async () => undefined;
  jest.spyOn(processor, 'kick').mockImplementation(() => undefined);
  const svc = new VoucherDispersalService(db.prisma as never, hubble as never, processor);
  return { ...db, hubble, notifications, processor, svc };
}

export function file(rows: unknown[][], name = 'r.xlsx'): Express.Multer.File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note'], ...rows]), 'Recipients');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), originalname: name } as Express.Multer.File;
}

/** Create + upload + confirm + drain → a COMPLETED campaign. */
export async function finished(t: ReturnType<typeof setup>, rows: unknown[][], budgetRupees = 10000) {
  const c = await t.svc.createCampaign(ADMIN, { name: 'Diwali', programLabel: 'Bajaj Loyalty', budgetRupees });
  const p = await t.svc.upload(ADMIN, c.id, file(rows, 'first.xlsx'));
  await t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: p.summary.valid, expectedTotalRupees: p.summary.totalRupees });
  await t.processor.drain({ campaignId: c.id });
  return c.id;
}

export const confirmBody = (p: { previewId: string | null; summary: { valid: number; totalRupees: number } }) => ({
  previewId: p.previewId!,
  expectedValidCount: p.summary.valid,
  expectedTotalRupees: p.summary.totalRupees,
});
