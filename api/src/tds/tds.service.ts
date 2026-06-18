/**
 * TDS aggregation engine — P6.5a.
 *
 * Computes per-(PAN, section, FY) liability / deposited / outstanding.
 * READ-ONLY (no writes). Uploads and write-side = 6.5b.
 *
 * Money: all amounts in BigInt paise. TDS rounded to nearest rupee.
 * Null-PAN bucket: keyed as '__NO_PAN__'; always at 20% rate.
 *
 * ── 194R (per clientId, per FY) ──────────────────────────────────────────────
 * Sources summed per PAN:
 *   1. Non-visibility CreditPayoutEntry (status PAID, paidAt in FY, field NOT isSeparatePayout)
 *      → PAN via Outlet→ChannelPartner
 *   2. RedemptionOrder.valuePaise for DELIVERED/FULFILLED redemptions (deliveredAt in FY)
 *      → PAN via ChannelPartner
 *   3. TdsOffPlatformEntry (section=SEC_194R, clientId, entryDate in FY)
 *      → PAN on the row
 * Threshold: fyTotal > 2,000,000 paise (₹20,000) → liability on WHOLE fyTotal (retroactive).
 * Deposited: SUM TdsDeposit (section=SEC_194R, clientId, depositDate in FY, panNumber).
 *
 * ── 194C (platform-wide, per FY) ────────────────────────────────────────────
 * Sources summed per PAN:
 *   Visibility CreditPayoutEntry (isSeparatePayout=true field, status PAID, paidAt in FY)
 *   → PAN via Outlet→ChannelPartner; entityType too.
 * Threshold: maxSingle > 3,000,000 paise OR fyTotal > 10,000,000 paise.
 * Two columns: (a) with-threshold, (b) no-threshold (TDS on everything).
 * Deposited: SUM TdsDeposit (section=SEC_194C, panNumber, FY) — clientId null.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  fyFromLabel,
  grossUpTdsPaise,
  rate194R,
  rate194C,
  roundToRupeePaise,
} from './tds.helpers';

// ─── Result types ─────────────────────────────────────────────────────────────

const NO_PAN_KEY = '__NO_PAN__';

export interface TdsRow194R {
  panNumber: string; // '__NO_PAN__' for the null bucket
  fyLabel: string;
  baseFyTotalPaise: bigint;
  liabilityPaise: bigint;
  depositedPaise: bigint;
  outstandingPaise: bigint;
}

export interface TdsRow194C {
  panNumber: string;
  entityType: string;
  fyLabel: string;
  baseFyTotalPaise: bigint;
  maxSinglePaise: bigint; // highest single payment (for threshold check)
  thresholdMet: boolean;
  liabilityPaise: bigint;           // (a) with-threshold
  liabilityNoThresholdPaise: bigint; // (b) no-threshold
  depositedPaise: bigint;
  outstandingPaise: bigint; // based on with-threshold liability
}

export interface TdsSummary194R {
  fyLabel: string;
  clientId: string;
  totalBasePaise: bigint;
  totalLiabilityPaise: bigint;
  totalDepositedPaise: bigint;
  totalOutstandingPaise: bigint;
  rowCount: number;
}

export interface TdsSummary194C {
  fyLabel: string;
  totalBasePaise: bigint;
  totalLiabilityPaise: bigint;
  totalLiabilityNoThresholdPaise: bigint;
  totalDepositedPaise: bigint;
  totalOutstandingPaise: bigint;
  rowCount: number;
}

// ─── Internal accumulators ───────────────────────────────────────────────────

interface PanAccum194R {
  panNumber: string;
  hasPan: boolean;
  totalPaise: bigint;
}

interface PanAccum194C {
  panNumber: string;
  hasPan: boolean;
  entityType: string;
  totalPaise: bigint;
  maxSinglePaise: bigint;
}

// ─── Thresholds (paise) ──────────────────────────────────────────────────────

const TDS_194R_THRESHOLD_PAISE = 2_000_000n;    // ₹20,000
const TDS_194C_SINGLE_THRESHOLD_PAISE = 3_000_000n; // ₹30,000
const TDS_194C_FY_THRESHOLD_PAISE = 10_000_000n;   // ₹1,00,000

@Injectable()
export class TdsService {
  private readonly logger = new Logger(TdsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── 194R ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194R rows for a given clientId and FY label (e.g. "2025-26").
   * Aggregates all three sources, applies the retroactive threshold, and
   * subtracts actual deposits to produce outstanding.
   */
  async compute194R(clientId: string, fyLabel: string): Promise<TdsRow194R[]> {
    const fy = fyFromLabel(fyLabel);
    const { start, endExclusive } = fy;

    // Accumulate per PAN
    const accum = new Map<string, PanAccum194R>();

    const addToPan = (pan: string | null | undefined, amountPaise: bigint) => {
      const key = pan && pan.trim() ? pan.trim().toUpperCase() : NO_PAN_KEY;
      const hasPan = key !== NO_PAN_KEY;
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
      } else {
        accum.set(key, { panNumber: key, hasPan, totalPaise: amountPaise });
      }
    };

    // ── Source 1: Non-visibility CreditPayoutEntry (status=PAID, paidAt in FY) ──
    // Exclude entries where the field has isSeparatePayout=true (those are 194C).
    // Join: entry.outletId → Outlet.outletCode → Outlet.partnerId → ChannelPartner.panNumber
    const payoutEntries = await this.prisma.creditPayoutEntry.findMany({
      where: {
        clientId,
        status: 'PAID',
        paidAt: { gte: start, lt: endExclusive },
        // Filter out visibility (isSeparatePayout) fields
        // We fetch the field via fieldId and filter post-query (no FK in CPE → CreditField).
      },
      select: {
        amountPaise: true,
        fieldId: true,
        outletId: true,
      },
    });

    // Fetch all visibility field IDs for this client to exclude them
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { clientId, isSeparatePayout: true },
      select: { id: true },
    });
    const visibilityFieldIds = new Set(visibilityFields.map((f) => f.id));

    // Gather outlet codes for non-visibility entries.
    // NOTE: CreditPayoutEntry.outletId stores the outletCode (string code), NOT the Outlet PK.
    const nonVisEntries = payoutEntries.filter((e) => !visibilityFieldIds.has(e.fieldId));
    const outletCodes = [...new Set(nonVisEntries.map((e) => e.outletId))];

    // Resolve outletCode → partnerId → PAN
    const outlets = outletCodes.length
      ? await this.prisma.outlet.findMany({
          where: { outletCode: { in: outletCodes }, clientId },
          select: { outletCode: true, partnerId: true },
        })
      : [];
    const outletToPartnerId = new Map(outlets.map((o) => [o.outletCode, o.partnerId]));

    const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))] as string[];
    const partners = partnerIds.length
      ? await this.prisma.channelPartner.findMany({
          where: { id: { in: partnerIds } },
          select: { id: true, panNumber: true },
        })
      : [];
    const partnerToPan = new Map(partners.map((p) => [p.id, p.panNumber]));

    for (const entry of nonVisEntries) {
      const partnerId = outletToPartnerId.get(entry.outletId) ?? null;
      const pan = partnerId ? (partnerToPan.get(partnerId) ?? null) : null;
      addToPan(pan, entry.amountPaise);
    }

    // ── Source 2: RedemptionOrder.valuePaise for fulfilled redemptions ──
    // Fulfilled = DELIVERED status (deliveredAt in FY); PAN via partner.
    const redemptions = await this.prisma.redemptionOrder.findMany({
      where: {
        status: 'DELIVERED',
        deliveredAt: { gte: start, lt: endExclusive },
        partner: { clientId },
        valuePaise: { not: null },
      },
      select: {
        valuePaise: true,
        partner: { select: { panNumber: true } },
      },
    });

    for (const r of redemptions) {
      if (r.valuePaise != null) {
        addToPan(r.partner?.panNumber, r.valuePaise);
      }
    }

    // ── Source 3: TdsOffPlatformEntry (section=SEC_194R, clientId, entryDate in FY) ──
    const offPlatform = await this.prisma.tdsOffPlatformEntry.findMany({
      where: {
        clientId,
        section: 'SEC_194R',
        entryDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    for (const e of offPlatform) {
      addToPan(e.panNumber, e.amountPaise);
    }

    // ── Deposited: SUM TdsDeposit (section=SEC_194R, clientId, depositDate in FY) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194R',
        clientId,
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    const deposited = new Map<string, bigint>();
    for (const d of deposits) {
      const key = d.panNumber && d.panNumber.trim()
        ? d.panNumber.trim().toUpperCase()
        : NO_PAN_KEY;
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
    }

    // ── Build result rows ──
    const rows: TdsRow194R[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet = fyTotal > TDS_194R_THRESHOLD_PAISE;
      const liabilityPaise = thresholdMet
        ? grossUpTdsPaise(fyTotal, rate194R(a.hasPan))
        : 0n;
      const depositedPaise = deposited.get(key) ?? 0n;
      const outstandingPaise = liabilityPaise - depositedPaise;

      rows.push({
        panNumber: a.panNumber,
        fyLabel,
        baseFyTotalPaise: fyTotal,
        liabilityPaise,
        depositedPaise,
        outstandingPaise,
      });
    }

    // Sort: threshold-met first (descending by base), then below-threshold
    rows.sort((a, b) => {
      const aAbove = a.baseFyTotalPaise > TDS_194R_THRESHOLD_PAISE;
      const bAbove = b.baseFyTotalPaise > TDS_194R_THRESHOLD_PAISE;
      if (aAbove !== bAbove) return aAbove ? -1 : 1;
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /** Summary for 194R: totals across all PAN rows. */
  async summary194R(clientId: string, fyLabel: string): Promise<TdsSummary194R> {
    const rows = await this.compute194R(clientId, fyLabel);
    return {
      fyLabel,
      clientId,
      totalBasePaise: rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n),
      totalLiabilityPaise: rows.reduce((s, r) => s + r.liabilityPaise, 0n),
      totalDepositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0n),
      totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0n),
      rowCount: rows.length,
    };
  }

  // ─── 194C ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194C rows (platform-wide, no clientId scope).
   * Sources: visibility CreditPayoutEntry (isSeparatePayout=true) across ALL tenants.
   * Two liability columns: (a) with-threshold, (b) no-threshold.
   */
  async compute194C(fyLabel: string): Promise<TdsRow194C[]> {
    const fy = fyFromLabel(fyLabel);
    const { start, endExclusive } = fy;

    // Accumulate per PAN (platform-wide)
    const accum = new Map<string, PanAccum194C>();

    const addToC = (
      pan: string | null | undefined,
      amountPaise: bigint,
      entityType: string | null | undefined,
    ) => {
      const key = pan && pan.trim() ? pan.trim().toUpperCase() : NO_PAN_KEY;
      const hasPan = key !== NO_PAN_KEY;
      const effEntityType = entityType ?? 'OTHERS';
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
        if (amountPaise > existing.maxSinglePaise) {
          existing.maxSinglePaise = amountPaise;
        }
      } else {
        accum.set(key, {
          panNumber: key,
          hasPan,
          entityType: effEntityType,
          totalPaise: amountPaise,
          maxSinglePaise: amountPaise,
        });
      }
    };

    // ── Source: visibility CreditPayoutEntry (isSeparatePayout=true fields), all clients ──
    // Get all visibility field IDs across all tenants
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { isSeparatePayout: true },
      select: { id: true, clientId: true },
    });
    const visFieldIds = new Set(visibilityFields.map((f) => f.id));

    if (visFieldIds.size > 0) {
      const visEntries = await this.prisma.creditPayoutEntry.findMany({
        where: {
          fieldId: { in: [...visFieldIds] },
          status: 'PAID',
          paidAt: { gte: start, lt: endExclusive },
        },
        select: {
          amountPaise: true,
          outletId: true,
          clientId: true,
        },
      });

      if (visEntries.length > 0) {
        // CreditPayoutEntry.outletId stores the outletCode (NOT the Outlet PK).
        // For 194C we need to resolve across all tenants (clientId already on outlet row).
        const outletCodes194C = [...new Set(visEntries.map((e) => e.outletId))];
        const outlets = await this.prisma.outlet.findMany({
          where: { outletCode: { in: outletCodes194C } },
          select: { outletCode: true, partnerId: true, clientId: true },
        });
        // outletCode is unique only WITHIN a tenant (@@unique([clientId, outletCode])); 194C is
        // platform-wide, so key by clientId:outletCode to avoid cross-tenant PAN misattribution.
        const outletToPartnerId = new Map(outlets.map((o) => [`${o.clientId}:${o.outletCode}`, o.partnerId]));

        const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))] as string[];
        const partners = partnerIds.length
          ? await this.prisma.channelPartner.findMany({
              where: { id: { in: partnerIds } },
              select: { id: true, panNumber: true, entityType: true },
            })
          : [];
        const partnerMap = new Map(partners.map((p) => [p.id, p]));

        for (const entry of visEntries) {
          const partnerId = outletToPartnerId.get(`${entry.clientId}:${entry.outletId}`) ?? null; // outletId = outletCode
          const partner = partnerId ? partnerMap.get(partnerId) : null;
          addToC(partner?.panNumber, entry.amountPaise, partner?.entityType ?? null);
        }
      }
    }

    // ── Deposited: SUM TdsDeposit (section=SEC_194C, depositDate in FY) — clientId null (platform) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194C',
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    const deposited = new Map<string, bigint>();
    for (const d of deposits) {
      const key = d.panNumber && d.panNumber.trim()
        ? d.panNumber.trim().toUpperCase()
        : NO_PAN_KEY;
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
    }

    // ── Build result rows ──
    const rows: TdsRow194C[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet =
        a.maxSinglePaise > TDS_194C_SINGLE_THRESHOLD_PAISE ||
        fyTotal > TDS_194C_FY_THRESHOLD_PAISE;

      const rateForPan = rate194C(a.hasPan, a.entityType);

      // (a) with-threshold
      const liabilityPaise = thresholdMet
        ? grossUpTdsPaise(fyTotal, rateForPan)
        : 0n;

      // (b) no-threshold: TDS on everything regardless
      const liabilityNoThresholdPaise = grossUpTdsPaise(fyTotal, rateForPan);

      const depositedPaise = deposited.get(key) ?? 0n;
      const outstandingPaise = liabilityPaise - depositedPaise;

      rows.push({
        panNumber: a.panNumber,
        entityType: a.entityType,
        fyLabel,
        baseFyTotalPaise: fyTotal,
        maxSinglePaise: a.maxSinglePaise,
        thresholdMet,
        liabilityPaise,
        liabilityNoThresholdPaise,
        depositedPaise,
        outstandingPaise,
      });
    }

    // Sort descending by base
    rows.sort((a, b) => {
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /** Summary for 194C: totals across all PAN rows. */
  async summary194C(fyLabel: string): Promise<TdsSummary194C> {
    const rows = await this.compute194C(fyLabel);
    return {
      fyLabel,
      totalBasePaise: rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n),
      totalLiabilityPaise: rows.reduce((s, r) => s + r.liabilityPaise, 0n),
      totalLiabilityNoThresholdPaise: rows.reduce((s, r) => s + r.liabilityNoThresholdPaise, 0n),
      totalDepositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0n),
      totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0n),
      rowCount: rows.length,
    };
  }
}
