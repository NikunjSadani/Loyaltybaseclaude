import { prisma } from './prisma';
import { creditPoints } from './wallet';
import { CalculationMethod, IncentiveCalculationResult } from '@/types';

// ─── Typed Errors ─────────────────────────────────────────────────────────────

export class IncentiveError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'IncentiveError';
  }
}

// ─── Slab Types ───────────────────────────────────────────────────────────────

export interface Slab {
  minValue: number;
  maxValue?: number | null;
  payoutValue: number;
  isOverachievement: boolean;
}

// ─── Slab Calculation Helpers ─────────────────────────────────────────────────

/**
 * Find the applicable slab for a given value and return the payout.
 */
export function computeSlabPayout(value: number, slabs: Slab[]): number {
  const normalSlabs = slabs
    .filter((s) => !s.isOverachievement)
    .sort((a, b) => a.minValue - b.minValue);

  for (let i = normalSlabs.length - 1; i >= 0; i--) {
    const slab = normalSlabs[i];
    const withinMin = value >= slab.minValue;
    const withinMax = slab.maxValue == null || value <= slab.maxValue;
    if (withinMin && withinMax) return slab.payoutValue;
  }

  return 0;
}

/**
 * Calculate bonus points for achievement beyond the target.
 */
export function applyOverachievementSlabs(
  achievement: number,
  target: number,
  slabs: Slab[]
): number {
  if (achievement <= target) return 0;

  const overachievementPct = ((achievement - target) / target) * 100;
  const overSlabs = slabs
    .filter((s) => s.isOverachievement)
    .sort((a, b) => a.minValue - b.minValue);

  let bonus = 0;
  for (let i = overSlabs.length - 1; i >= 0; i--) {
    const slab = overSlabs[i];
    if (overachievementPct >= slab.minValue) {
      bonus = slab.payoutValue;
      break;
    }
  }

  return bonus;
}

// ─── Eligibility Check ────────────────────────────────────────────────────────

/**
 * Check whether a channel partner is eligible for a scheme.
 */
export async function processSchemeEligibility(
  partnerId: string,
  schemeId: string
): Promise<boolean> {
  const scheme = await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { eligibility: true },
  });

  if (!scheme || scheme.status !== 'ACTIVE' || scheme.deletedAt !== null) return false;

  const now = new Date();
  if (now < scheme.startDate || now > scheme.endDate) return false;

  const partner = await prisma.channelPartner.findUnique({
    where: { id: partnerId },
  });

  if (!partner || !partner.isActive) return false;

  return true;
}

// ─── Core Incentive Calculator ────────────────────────────────────────────────

/**
 * Compute the points earned for a single invoice under a scheme.
 */
export async function calculateIncentive(
  invoiceId: string,
  schemeId: string
): Promise<IncentiveCalculationResult> {
  const invoice = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new IncentiveError('Invoice not found', 'INVOICE_NOT_FOUND');

  const scheme = await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { rules: true },
  });
  if (!scheme) throw new IncentiveError('Scheme not found', 'SCHEME_NOT_FOUND');

  const invoiceValue = invoice.totalAmountPaise; // stored in paise
  let pointsEarned = 0;
  const breakdown: Record<string, unknown> = { invoiceValue };

  // Determine calculation method from scheme fields
  if (scheme.fixedPoints != null) {
    pointsEarned = scheme.fixedPoints;
    breakdown.method = 'FLAT';
    breakdown.flatPoints = pointsEarned;
  } else if (scheme.pointsPerRupee != null) {
    const rate = parseFloat(scheme.pointsPerRupee.toString());
    pointsEarned = Math.floor((invoiceValue / 100) * rate); // invoiceValue is in paise
    breakdown.method = 'PERCENTAGE';
    breakdown.rate = rate;
    breakdown.computed = pointsEarned;
  }

  return {
    invoiceId,
    schemeId,
    pointsEarned,
    calculationMethod: CalculationMethod.FLAT,
    breakdown,
  };
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Process all unprocessed invoices in an upload batch.
 */
export async function batchProcessIncentives(uploadBatchId: string): Promise<{
  total: number;
  succeeded: number;
  failed: number;
}> {
  const batch = await prisma.salesUpload.findUnique({ where: { id: uploadBatchId } });
  if (!batch) throw new IncentiveError('Upload batch not found', 'BATCH_NOT_FOUND');

  await prisma.salesUpload.update({
    where: { id: uploadBatchId },
    data: { status: 'PROCESSING' },
  });

  const invoices = await prisma.salesInvoice.findMany({
    where: { salesUploadId: uploadBatchId, isValid: true },
  });

  let succeeded = 0;
  let failed = 0;

  for (const invoice of invoices) {
    try {
      const result = await calculateIncentive(invoice.id, invoice.salesUploadId ?? '');

      if (result.pointsEarned > 0) {
        await creditPoints(
          invoice.partnerId,
          result.pointsEarned,
          'CREDIT',
          undefined,
          invoice.id,
          `Points earned from invoice ${invoice.invoiceNumber}`
        );
      }

      succeeded += 1;
    } catch (err) {
      console.error(`[incentive] Failed to process invoice ${invoice.id}:`, err);
      failed += 1;
    }
  }

  const finalStatus = failed === 0 ? 'COMPLETED' : succeeded === 0 ? 'FAILED' : 'PARTIALLY_COMPLETED';

  await prisma.salesUpload.update({
    where: { id: uploadBatchId },
    data: {
      status: finalStatus,
      processedRows: { increment: succeeded },
      failedRows: { increment: failed },
    },
  });

  return { total: invoices.length, succeeded, failed };
}
