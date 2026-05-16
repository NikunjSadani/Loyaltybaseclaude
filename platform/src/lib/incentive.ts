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
 * For SLAB schemes the payout is the fixed value in the matching tier.
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

  return 0; // No slab matched
}

/**
 * Calculate bonus points for achievement beyond the target.
 * Iterates overachievement slabs in ascending order and applies the matching one.
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
 * Returns true if the partner meets all criteria (active, within dates, correct tier).
 */
export async function processSchemeEligibility(
  partnerId: string,
  schemeId: string
): Promise<boolean> {
  const scheme = await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { eligibilityCriteria: true },
  });

  if (!scheme || !scheme.isActive) return false;

  const now = new Date();
  if (now < scheme.startDate || now > scheme.endDate) return false;

  const partner = await prisma.channelPartner.findUnique({
    where: { id: partnerId },
  });

  if (!partner || !partner.isActive) return false;
  if (partner.kycStatus !== 'APPROVED') return false;

  // Optional: check tier / class criteria
  if (scheme.eligibilityCriteria && scheme.eligibilityCriteria.length > 0) {
    const allowed = scheme.eligibilityCriteria.map((c: { value: string }) => c.value);
    if (allowed.length > 0 && !allowed.includes(partner.partnerClass)) return false;
  }

  return true;
}

// ─── Core Incentive Calculator ────────────────────────────────────────────────

/**
 * Compute the points earned for a single invoice under a scheme.
 * Does NOT persist anything – returns the result for the caller to decide.
 */
export async function calculateIncentive(
  invoiceId: string,
  schemeId: string
): Promise<IncentiveCalculationResult> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new IncentiveError('Invoice not found', 'INVOICE_NOT_FOUND');

  const scheme = await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { slabs: true },
  });
  if (!scheme) throw new IncentiveError('Scheme not found', 'SCHEME_NOT_FOUND');

  const invoiceValue = invoice.amount; // stored in paise
  let pointsEarned = 0;
  const breakdown: Record<string, unknown> = { invoiceValue, method: scheme.calculationMethod };

  switch (scheme.calculationMethod as CalculationMethod) {
    case CalculationMethod.FLAT: {
      pointsEarned = scheme.flatPoints ?? 0;
      breakdown.flatPoints = pointsEarned;
      break;
    }

    case CalculationMethod.PERCENTAGE: {
      const rate = scheme.percentageRate ?? 0;
      // rate is stored as a decimal e.g. 0.05 for 5%
      pointsEarned = Math.floor((invoiceValue * rate) / 100);
      breakdown.rate = rate;
      breakdown.computed = pointsEarned;
      break;
    }

    case CalculationMethod.PER_UNIT: {
      const units = invoice.units ?? 1;
      const pointsPerUnit = scheme.pointsPerUnit ?? 0;
      pointsEarned = units * pointsPerUnit;
      breakdown.units = units;
      breakdown.pointsPerUnit = pointsPerUnit;
      break;
    }

    case CalculationMethod.SLAB: {
      pointsEarned = computeSlabPayout(invoiceValue, scheme.slabs ?? []);
      breakdown.slabResult = pointsEarned;
      break;
    }

    case CalculationMethod.HYBRID: {
      // Base: percentage, bonus: slab overachievement
      const rate = scheme.percentageRate ?? 0;
      const base = Math.floor((invoiceValue * rate) / 100);
      const target = scheme.targetValue ?? 0;
      const bonus = applyOverachievementSlabs(invoiceValue, target, scheme.slabs ?? []);
      pointsEarned = base + bonus;
      breakdown.base = base;
      breakdown.bonus = bonus;
      break;
    }

    default:
      throw new IncentiveError(
        `Unknown calculation method: ${scheme.calculationMethod}`,
        'UNKNOWN_METHOD'
      );
  }

  return {
    invoiceId,
    schemeId,
    pointsEarned,
    calculationMethod: scheme.calculationMethod as CalculationMethod,
    breakdown,
  };
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Process all unprocessed invoices in an upload batch.
 * Credits points and marks each invoice as processed. Updates batch counters.
 */
export async function batchProcessIncentives(uploadBatchId: string): Promise<{
  total: number;
  succeeded: number;
  failed: number;
}> {
  const batch = await prisma.uploadBatch.findUnique({ where: { id: uploadBatchId } });
  if (!batch) throw new IncentiveError('Upload batch not found', 'BATCH_NOT_FOUND');

  await prisma.uploadBatch.update({
    where: { id: uploadBatchId },
    data: { status: 'PROCESSING' },
  });

  const invoices = await prisma.invoice.findMany({
    where: { uploadBatchId, isProcessed: false },
    include: { partner: { include: { user: true } } },
  });

  let succeeded = 0;
  let failed = 0;

  for (const invoice of invoices) {
    if (!invoice.schemeId) {
      failed += 1;
      continue;
    }

    try {
      const eligible = await processSchemeEligibility(invoice.partnerId, invoice.schemeId);
      if (!eligible) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { isProcessed: true, processedAt: new Date(), processingNote: 'INELIGIBLE' },
        });
        failed += 1;
        continue;
      }

      const result = await calculateIncentive(invoice.id, invoice.schemeId);

      if (result.pointsEarned > 0) {
        await creditPoints(
          invoice.partner.user.id,
          result.pointsEarned,
          'CREDIT',
          invoice.schemeId,
          invoice.id,
          `Points earned from invoice ${invoice.invoiceNumber}`
        );
      }

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          isProcessed: true,
          processedAt: new Date(),
          pointsEarned: result.pointsEarned,
        },
      });

      succeeded += 1;
    } catch (err) {
      console.error(`[incentive] Failed to process invoice ${invoice.id}:`, err);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          isProcessed: true,
          processedAt: new Date(),
          processingNote: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
        },
      }).catch(() => {});
      failed += 1;
    }
  }

  const finalStatus = failed === 0 ? 'COMPLETED' : succeeded === 0 ? 'FAILED' : 'PARTIAL';

  await prisma.uploadBatch.update({
    where: { id: uploadBatchId },
    data: {
      status: finalStatus,
      processedRecords: { increment: succeeded },
      failedRecords: { increment: failed },
    },
  });

  return { total: invoices.length, succeeded, failed };
}
