import { prisma } from './prisma';
import type { TDSComputationResult } from '@/types';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * TDS thresholds and rates (amounts in paise unless noted).
 * Override via environment variables where required.
 */
const TDS_CONFIG = {
  /** 194R: Benefit / perquisite – standard rate 10% */
  '194R': {
    standardRatePct: parseFloat(process.env.TDS_194R_RATE ?? '10'),
    thresholdPaise: parseInt(process.env.TDS_194R_THRESHOLD_PAISE ?? '2000000', 10), // ₹20,000
  },
  /** 194C: Contractor payments – 1% individual, 2% company */
  '194C': {
    individualRatePct: parseFloat(process.env.TDS_194C_INDIVIDUAL_RATE ?? '1'),
    companyRatePct: parseFloat(process.env.TDS_194C_COMPANY_RATE ?? '2'),
    thresholdPaise: parseInt(process.env.TDS_194C_THRESHOLD_PAISE ?? '3000000', 10), // ₹30,000 single / ₹1L aggregate
  },
  /** Rate applied when PAN is not available (as per Income Tax Act) */
  noPanRatePct: 20,
} as const;

// ─── TDS Computation ──────────────────────────────────────────────────────────

/**
 * Compute TDS for a payout.
 *
 * @param grossAmount          - Gross payout amount in paise.
 * @param pan                  - PAN of the payee (null if unavailable).
 * @param section              - Applicable TDS section: '194R' or '194C'.
 * @param financialYearAggregate - Running aggregate for this payee in the current FY (paise).
 * @param entityType           - 'INDIVIDUAL' | 'COMPANY' – relevant for 194C. Defaults to 'INDIVIDUAL'.
 */
export function computeTDS(
  grossAmount: number,
  pan: string | null,
  section: '194R' | '194C',
  financialYearAggregate: number,
  entityType: 'INDIVIDUAL' | 'COMPANY' = 'INDIVIDUAL'
): TDSComputationResult {
  if (grossAmount <= 0) {
    return { grossAmount, tdsRate: 0, tdsAmount: 0, netAmount: grossAmount };
  }

  // Determine if threshold has been crossed (aggregate basis)
  const config = TDS_CONFIG[section];
  const cumulativeAfter = financialYearAggregate + grossAmount;
  const belowThreshold = cumulativeAfter <= config.thresholdPaise;

  if (belowThreshold) {
    return { grossAmount, tdsRate: 0, tdsAmount: 0, netAmount: grossAmount };
  }

  // Determine applicable rate
  let tdsRate: number;

  if (pan === null || pan.trim() === '') {
    tdsRate = TDS_CONFIG.noPanRatePct;
  } else if (section === '194R') {
    tdsRate = TDS_CONFIG['194R'].standardRatePct;
  } else {
    // 194C
    tdsRate =
      entityType === 'COMPANY'
        ? TDS_CONFIG['194C'].companyRatePct
        : TDS_CONFIG['194C'].individualRatePct;
  }

  const tdsAmount = Math.floor((grossAmount * tdsRate) / 100);
  const netAmount = grossAmount - tdsAmount;

  return { grossAmount, tdsRate, tdsAmount, netAmount };
}

// ─── TDS Record Creation ──────────────────────────────────────────────────────

export interface TDSAmounts {
  grossAmount: number;
  tdsRate: number;
  tdsAmount: number;
  netAmount: number;
}

/**
 * Persist a TDS record to the database.
 *
 * @param payoutId    - ID of the associated payout.
 * @param partnerId   - ID of the channel partner.
 * @param pan         - PAN of the payee (may be null).
 * @param section     - TDS section applied.
 * @param amounts     - Pre-computed amounts from computeTDS().
 * @param financialYear - e.g. "2025-26"
 */
export async function generateTDSRecord(
  payoutId: string,
  partnerId: string,
  pan: string | null,
  section: '194R' | '194C',
  amounts: TDSAmounts,
  financialYear: string
): Promise<string> {
  const record = await prisma.tDSRecord.create({
    data: {
      payoutId,
      partnerId,
      pan: pan ?? null,
      section,
      grossAmountPaise: amounts.grossAmount,
      tdsRate: amounts.tdsRate,
      tdsAmountPaise: amounts.tdsAmount,
      netAmountPaise: amounts.netAmount,
      financialYear,
    },
  });

  return record.id;
}

// ─── FY Aggregate Query ───────────────────────────────────────────────────────

/**
 * Return the total gross payout amount (in paise) for a partner in a given
 * financial year – used to determine threshold crossings for future payouts.
 */
export async function getFinancialYearAggregate(
  partnerId: string,
  financialYear: string,
  section: '194R' | '194C'
): Promise<number> {
  const result = await prisma.tDSRecord.aggregate({
    where: { partnerId, financialYear, section },
    _sum: { grossAmountPaise: true },
  });

  return result._sum.grossAmountPaise ?? 0;
}
