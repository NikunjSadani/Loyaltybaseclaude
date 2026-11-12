// Pure unit tests for the voucher write invariant helpers (no Nest module, no DB).
// Run: npx jest src/rewards/voucher-write-guard.spec.ts
import { BadRequestException } from '@nestjs/common';
import {
  assertVoucherCodeReusableInTx,
  hasHubbleMarkers,
  hashVoucherCode,
  isHubbleNeverPlaced,
  planVoucherWrite,
} from './voucher-write-guard';
import { hasIssuedVoucher, noIssuedVoucherGuard } from './order-status-transition';

const paid = (extra: Record<string, unknown> = {}) => ({
  status: 'CONFIRMED', voucherCode: null, voucherProvider: null, pointsDeducted: 500,
  redemptionMode: 'GIFT_CARD', metadata: {}, ...extra,
}) as Parameters<typeof planVoucherWrite>[0];

describe('voucher-write-guard', () => {
  describe('hasHubbleMarkers', () => {
    it('an OPEN reconcile flag always counts — even after a manual override / release', () => {
      expect(hasHubbleMarkers({ metadata: { hubbleStatus: 'MANUAL_OVERRIDE', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' } })).toBe(true);
      expect(hasHubbleMarkers({ metadata: { hubbleStatus: 'RELEASED', hubbleNeedsReconcile: true } })).toBe(true);
    });
    it('a resolved override / release (flag cleared) is a plain order again', () => {
      expect(hasHubbleMarkers({ metadata: { hubbleStatus: 'MANUAL_OVERRIDE', hubbleNeedsReconcile: false, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' } })).toBe(false);
      expect(hasHubbleMarkers({ metadata: { hubbleStatus: 'RELEASED', hubbleNeedsReconcile: false } })).toBe(false);
    });
    it('provider Hubble (any case) always counts', () => {
      expect(hasHubbleMarkers({ voucherProvider: ' HUBBLE ', metadata: { hubbleStatus: 'MANUAL_OVERRIDE' } })).toBe(true);
    });
  });

  describe('whitespace-only stored codes = "no code" everywhere (no 409 loop)', () => {
    it('hasIssuedVoucher trims', () => {
      expect(hasIssuedVoucher('   ')).toBe(false);
      expect(hasIssuedVoucher('')).toBe(false);
      expect(hasIssuedVoucher(null)).toBe(false);
      expect(hasIssuedVoucher(' X ')).toBe(true);
    });
    it('noIssuedVoucherGuard pins the exact whitespace value read; otherwise null / ""', () => {
      expect(noIssuedVoucherGuard('   ')).toEqual({ voucherCode: '   ' });
      expect(noIssuedVoucherGuard(null)).toEqual({ OR: [{ voucherCode: null }, { voucherCode: '' }] });
      expect(noIssuedVoucherGuard('')).toEqual({ OR: [{ voucherCode: null }, { voucherCode: '' }] });
    });
    it('a new code on a whitespace-only row is allowed and its CAS matches that exact row value', () => {
      const plan = planVoucherWrite(paid({ voucherCode: '  ' }), { voucherCode: 'NEW-1' });
      expect(plan.data.voucherCode).toBe('NEW-1');
      expect((plan.guard as { AND: unknown[] }).AND).toEqual(expect.arrayContaining([{ voucherCode: '  ' }]));
    });
    it('a whitespace-only order never counts as Hubble-issued nor blocks isHubbleNeverPlaced', () => {
      expect(isHubbleNeverPlaced({ voucherCode: '  ', metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_CONFIGURED' } })).toBe(true);
    });
  });

  describe('assertVoucherCodeReusableInTx', () => {
    it('takes the (tenant, code) advisory lock BEFORE the reuse lookup, and refuses a cancelled code', async () => {
      const order: string[] = [];
      const tx = {
        $executeRaw: jest.fn(async () => { order.push('lock'); return 1; }),
        cancelledVoucherCode: { findFirst: jest.fn(async () => { order.push('lookup'); return { id: 'cv' }; }) },
      };
      await expect(assertVoucherCodeReusableInTx(tx as never, 'bajaj', ' amzn 1234 ')).rejects.toBeInstanceOf(BadRequestException);
      expect(order).toEqual(['lock', 'lookup']);
      expect(tx.cancelledVoucherCode.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'bajaj', codeHash: hashVoucherCode('AMZN1234') },
        select: { id: true },
      });
      // The lock key carries the hash, never the code.
      expect(JSON.stringify((tx.$executeRaw as jest.Mock).mock.calls)).not.toContain('amzn');
    });
    it('passes for a never-cancelled code', async () => {
      const tx = { $executeRaw: jest.fn(async () => 1), cancelledVoucherCode: { findFirst: jest.fn(async () => null) } };
      await expect(assertVoucherCodeReusableInTx(tx as never, 'bajaj', 'FRESH')).resolves.toBeUndefined();
    });
  });
});
