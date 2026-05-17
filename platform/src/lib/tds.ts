import { prisma } from './prisma';
import type { TDSComputationResult } from '@/types';

// ─── Configuration ────────────────────────────────────────────────────────────

const TDS_CONFIG = {
  '194R': {
    standardRatePct: parseFloat(process.env.TDS_194R_RATE ?? '10'),
    thresholdPaise: parseInt(process.env.TDS_194R_THRESHOLD_PAISE ?? '2000000', 10), // ₹20,000
  },
  '194C': {
    individualRatePct: parseFloat(process.env.TDS_194C_INDIVIDUAL_RATE ?? '1'),
    companyRatePct: parseFloat(process.env.TDS_194C_COMPANY_RATE ?? '2'),
    thresholdPaise: parseInt(process.env.TDS_194C_THRESHOLD_PAISE ?? '3000000', 10),
  },
  noPanRatePct: 20,
} as const;

// ─── TDS Computation ──────────────────────────────────────────────────────────

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

  const config = TDS_CONFIG[section];
  const cumulativeAfter = financialYearAggregate + grossAmount;
  const belowThreshold = cumulativeAfter <= config.thresholdPaise;

  if (belowThreshold) {
    return { grossAmount, tdsRate: 0, tdsAmount: 0, netAmount: grossAmount };
  }

  let tdsRate: number;

  if (pan === null || pan.trim() === '') {
    tdsRate = TDS_CONFIG.noPanRatePct;
  } else if (section === '194R') {
    tdsRate = TDS_CONFIG['194R'].standardRatePct;
  } else {
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
 */
export async function generateTDSRecord(
  payoutTransactionId: string,
  partnerId: string,
  pan: string | null,
  _section: '194R' | '194C',
  amounts: TDSAmounts,
  _financialYear: string
): Promise<string> {
  const record = await prisma.tdsRecord.create({
    data: {
      payoutTransactionId,
      partnerId,
      panNumber: pan ?? null,
      tdsRate: amounts.tdsRate,
      tdsPaise: amounts.tdsAmount,
    },
  });

  return record.id;
}

// ─── FY Aggregate Query ───────────────────────────────────────────────────────

/**
 * Return the total TDS paise for a partner.
 */
export async function getFinancialYearAggregate(
  partnerId: string,
  _financialYear: string,
  _section: '194R' | '194C'
): Promise<number> {
  const result = await prisma.tdsRecord.aggregate({
    where: { partnerId },
    _sum: { tdsPaise: true },
  });

  return result._sum.tdsPaise ?? 0;
}
