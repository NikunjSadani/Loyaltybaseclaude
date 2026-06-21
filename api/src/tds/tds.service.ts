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
  sectionParamToEnum,
  parseOffPlatformUpload,
  parseDepositUpload,
  buildOffPlatformTemplate,
  buildDepositTemplate,
  offPlatformFileHash,
  depositFileHash,
  cellSafe,
} from './tds.helpers';
import type { UploadResult } from './dto/tds.dto';
import { buildXlsx } from '../common/xlsx';
import { paiseToRupees } from '../common/money';

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

  // ─── 6.5b: Template builders ─────────────────────────────────────────────────

  /** Return a blank xlsx Buffer for the off-platform 194R upload template. */
  offPlatformTemplate(): Buffer {
    return buildOffPlatformTemplate();
  }

  /** Return a blank xlsx Buffer for the TDS deposit upload template. */
  depositTemplate(): Buffer {
    return buildDepositTemplate();
  }

  // ─── 6.5b: Off-platform 194R upload ─────────────────────────────────────────

  /**
   * Parse (and optionally apply) an off-platform 194R upload.
   *
   * @param clientId  - tenant (from JWT)
   * @param uploadedBy - user.sub from JWT
   * @param file      - multipart xlsx file (Express.Multer.File)
   * @param apply     - if false → preview only; if true → createMany to DB
   *
   * Validation: PAN non-empty, amount > 0, date parseable.
   *
   * On apply: the uploadBatchId is a DETERMINISTIC sha256 of the file's parsed
   * rows (offPlatformFileHash), NOT a random uuid. Re-uploading the SAME file
   * therefore produces the SAME uploadBatchId, so every row collides on the
   * tds_off_platform_entries_dedup_unique partial index and is skipped (no
   * double-count). A DIFFERENT file gets a different hash → its rows insert,
   * preserving a genuine repeat 194R entry. We query the rows already present
   * for this (clientId, section, uploadBatchId) BEFORE the createMany so each
   * skipped row is surfaced in the result as "skipped — duplicate entry"
   * (createMany({skipDuplicates}) otherwise drops collisions silently); skipDuplicates
   * is kept as the race safety-net.
   */
  async uploadOffPlatform(
    clientId: string,
    uploadedBy: string,
    file: Express.Multer.File,
    apply: boolean,
  ): Promise<UploadResult> {
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    const { result, rows } = parseOffPlatformUpload(ab);

    if (!apply || rows.length === 0) {
      return result;
    }

    // Deterministic file-level batch id → same file re-upload = same id = full collision.
    const uploadBatchId = offPlatformFileHash(rows);

    // Which of these natural-keys are ALREADY present for this file's batch id?
    // (Re-upload of the identical file → all of them.) Build the dedup tuple set.
    const existing = await this.prisma.tdsOffPlatformEntry.findMany({
      where: {
        clientId,
        section: 'SEC_194R',
        uploadBatchId,
      },
      select: {
        panNumber: true,
        entryDate: true,
        amountPaise: true,
        outletCode: true,
      },
    });
    const existingKeys = new Set(
      existing.map((e) =>
        this.offPlatformDedupKey(
          e.panNumber,
          e.entryDate,
          e.amountPaise,
          e.outletCode ?? null,
        ),
      ),
    );

    const toInsert: typeof rows = [];
    rows.forEach((r, idx) => {
      const key = this.offPlatformDedupKey(
        r.panNumber,
        r.entryDate,
        r.amountPaise,
        r.outletCode ?? null,
      );
      if (existingKeys.has(key)) {
        result.skipped += 1;
        result.succeeded -= 1;
        result.errors.push({
          row: idx + 2, // 1-based + header row
          message: `Row ${idx + 2}: skipped — duplicate entry (already uploaded in this file)`,
        });
      } else {
        toInsert.push(r);
      }
    });

    if (toInsert.length > 0) {
      await this.prisma.tdsOffPlatformEntry.createMany({
        data: toInsert.map((r) => ({
          clientId,
          section: 'SEC_194R' as const,
          entryDate: r.entryDate,
          panNumber: r.panNumber,
          outletCode: r.outletCode ?? undefined,
          amountPaise: r.amountPaise,
          uploadBatchId,
          uploadedBy,
        })),
        skipDuplicates: true, // DB partial-unique catches true dups; this is a race safety net
      });
    }

    return result;
  }

  /** Natural-key string mirroring the tds_off_platform_entries_dedup_unique index. */
  private offPlatformDedupKey(
    panNumber: string,
    entryDate: Date,
    amountPaise: bigint,
    outletCode: string | null,
  ): string {
    return [
      panNumber,
      entryDate.toISOString(),
      amountPaise.toString(),
      outletCode ?? '',
    ].join('|');
  }

  // ─── 6.5b: Deposit upload ────────────────────────────────────────────────────

  /**
   * Parse (and optionally apply) a TDS deposit upload.
   *
   * section=194R → depositorType=CLIENT, clientId set from JWT.
   * section=194C → depositorType=GIFSY, clientId=null (platform).
   *
   * uploadBatchId is a DETERMINISTIC sha256 of the file's parsed rows
   * (depositFileHash) → re-uploading the SAME file produces the SAME id, every
   * row collides on tds_deposits_dedup_unique and is skipped + reported as
   * "skipped — duplicate entry"; a DIFFERENT file inserts. skipDuplicates kept
   * as the race safety-net.
   */
  async uploadDeposit(
    section: '194R' | '194C',
    clientId: string | null,
    uploadedBy: string,
    file: Express.Multer.File,
    apply: boolean,
  ): Promise<UploadResult> {
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    const { result, rows } = parseDepositUpload(ab);

    if (!apply || rows.length === 0) {
      return result;
    }

    const prismaSection = sectionParamToEnum(section);
    const depositorType = section === '194R' ? 'CLIENT' : 'GIFSY';
    const uploadBatchId = depositFileHash(rows);

    // Rows already present for this file's batch id (same file re-upload → all).
    const existing = await this.prisma.tdsDeposit.findMany({
      where: {
        section: prismaSection,
        clientId: clientId ?? null,
        uploadBatchId,
      },
      select: {
        panNumber: true,
        depositDate: true,
        amountPaise: true,
        outletCode: true,
      },
    });
    const existingKeys = new Set(
      existing.map((e) =>
        this.depositDedupKey(
          e.panNumber,
          e.depositDate,
          e.amountPaise,
          e.outletCode ?? null,
        ),
      ),
    );

    const toInsert: typeof rows = [];
    rows.forEach((r, idx) => {
      const key = this.depositDedupKey(
        r.panNumber,
        r.depositDate,
        r.amountPaise,
        r.outletCode ?? null,
      );
      if (existingKeys.has(key)) {
        result.skipped += 1;
        result.succeeded -= 1;
        result.errors.push({
          row: idx + 2,
          message: `Row ${idx + 2}: skipped — duplicate entry (already uploaded in this file)`,
        });
      } else {
        toInsert.push(r);
      }
    });

    if (toInsert.length > 0) {
      await this.prisma.tdsDeposit.createMany({
        data: toInsert.map((r) => ({
          section: prismaSection,
          depositorType: depositorType as 'CLIENT' | 'GIFSY',
          clientId: clientId ?? undefined,
          depositDate: r.depositDate,
          panNumber: r.panNumber,
          outletCode: r.outletCode ?? undefined,
          amountPaise: r.amountPaise,
          uploadBatchId,
          uploadedBy,
        })),
        skipDuplicates: true,
      });
    }

    return result;
  }

  /** Natural-key string mirroring the tds_deposits_dedup_unique index. */
  private depositDedupKey(
    panNumber: string,
    depositDate: Date,
    amountPaise: bigint,
    outletCode: string | null,
  ): string {
    return [
      panNumber,
      depositDate.toISOString(),
      amountPaise.toString(),
      outletCode ?? '',
    ].join('|');
  }

  // ─── 6.5c: Excel reference exports ──────────────────────────────────────────

  /**
   * Build the 194R reference Excel for a given clientId + FY.
   *
   * One row per PAN. Name resolution (CA-ready, mirroring 26Q deductee sheet):
   *   - On-platform PAN → ChannelPartner (clientId-scoped) → ownerName or businessName
   *   - __NO_PAN__ bucket → "NO PAN ON FILE"
   *   - Unknown / off-platform PAN → blank name
   *
   * Columns: S.No · Deductee Name · PAN · Section · Amount Paid (₹) · TDS Rate %
   *          · TDS Amount (₹) · Already Deposited (₹) · Outstanding (₹) · FY
   *
   * A second "Summary" sheet provides totals.
   *
   * @returns { buffer: Buffer, filename: string }
   */
  async export194R(
    clientId: string,
    fyLabel: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const rows = await this.compute194R(clientId, fyLabel);

    // Resolve PAN → name from ChannelPartner (tenant-scoped)
    const onPlatformPans = rows
      .map((r) => r.panNumber)
      .filter((p) => p !== '__NO_PAN__');

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          where: {
            clientId,
            panNumber: { in: onPlatformPans },
          },
          select: { panNumber: true, ownerName: true, businessName: true },
        })
      : [];

    // Use first match per PAN (panNumber is not unique-constrained across tenants,
    // but within a single clientId scope duplicates should not arise in practice).
    const panToName = new Map<string, string>();
    for (const p of partners) {
      if (p.panNumber && !panToName.has(p.panNumber)) {
        panToName.set(p.panNumber, p.ownerName || p.businessName || '');
      }
    }

    const detailRows = rows.map((r, i) => {
      const hasPan = r.panNumber !== '__NO_PAN__';
      const tdsRatePct = hasPan ? 10 : 20;
      const deducteeName = hasPan
        ? (panToName.get(r.panNumber) ?? '')
        : 'NO PAN ON FILE';

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        Section: '194R',
        'Amount Paid (₹)': paiseToRupees(r.baseFyTotalPaise).toFixed(2),
        'TDS Rate %': tdsRatePct,
        'TDS Amount (₹)': paiseToRupees(r.liabilityPaise).toFixed(2),
        'Already Deposited (₹)': paiseToRupees(r.depositedPaise).toFixed(2),
        'Outstanding (₹)': paiseToRupees(r.outstandingPaise).toFixed(2),
        FY: fyLabel,
      };
    });

    // Summary sheet
    const totalBase = rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n);
    const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
    const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
    const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

    const summaryRows = [
      {
        'Field': 'Total Deductees',
        'Value': rows.length,
      },
      {
        'Field': 'Total Amount Paid (₹)',
        'Value': paiseToRupees(totalBase).toFixed(2),
      },
      {
        'Field': 'Total TDS Amount (₹)',
        'Value': paiseToRupees(totalLiability).toFixed(2),
      },
      {
        'Field': 'Total Already Deposited (₹)',
        'Value': paiseToRupees(totalDeposited).toFixed(2),
      },
      {
        'Field': 'Total Outstanding (₹)',
        'Value': paiseToRupees(totalOutstanding).toFixed(2),
      },
      {
        'Field': 'FY',
        'Value': fyLabel,
      },
    ];

    const buffer = buildXlsx([
      { name: 'TDS 194R Details', rows: detailRows },
      { name: 'Summary', rows: summaryRows },
    ]);

    return { buffer, filename: `tds-194r-${fyLabel}.xlsx` };
  }

  /**
   * Build the 194C two-column report Excel (platform-wide, Gifsy deductor).
   *
   * One row per PAN. Name resolution: look up ChannelPartner by PAN across
   * all tenants (first match wins).
   *
   * Columns: S.No · Deductee Name · PAN · Entity Type · Section · Amount Paid (₹)
   *          · TDS Rate % · TDS — With Threshold (₹) · TDS — No Threshold (₹)
   *          · Threshold Met (Y/N) · Already Deposited (₹) · Outstanding (₹) · FY
   *
   * @returns { buffer: Buffer, filename: string }
   */
  async export194C(
    fyLabel: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const rows = await this.compute194C(fyLabel);

    // Resolve PAN → name platform-wide (first match across any tenant)
    const onPlatformPans = rows
      .map((r) => r.panNumber)
      .filter((p) => p !== '__NO_PAN__');

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          where: { panNumber: { in: onPlatformPans } },
          select: { panNumber: true, ownerName: true, businessName: true },
        })
      : [];

    const panToName = new Map<string, string>();
    for (const p of partners) {
      if (p.panNumber && !panToName.has(p.panNumber)) {
        panToName.set(p.panNumber, p.ownerName || p.businessName || '');
      }
    }

    const detailRows = rows.map((r, i) => {
      const hasPan = r.panNumber !== '__NO_PAN__';

      // Rate display: 1 for INDIVIDUAL/HUF, 2 for others, 20 for no-PAN
      let tdsRatePct: number;
      if (!hasPan) {
        tdsRatePct = 20;
      } else if (r.entityType === 'INDIVIDUAL' || r.entityType === 'HUF') {
        tdsRatePct = 1;
      } else {
        tdsRatePct = 2;
      }

      const deducteeName = hasPan
        ? (panToName.get(r.panNumber) ?? '')
        : 'NO PAN ON FILE';

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        'Entity Type': cellSafe(r.entityType),
        Section: '194C',
        'Amount Paid (₹)': paiseToRupees(r.baseFyTotalPaise).toFixed(2),
        'TDS Rate %': tdsRatePct,
        'TDS — With Threshold (₹)': paiseToRupees(r.liabilityPaise).toFixed(2),
        'TDS — No Threshold (₹)': paiseToRupees(r.liabilityNoThresholdPaise).toFixed(2),
        'Threshold Met (Y/N)': r.thresholdMet ? 'Y' : 'N',
        'Already Deposited (₹)': paiseToRupees(r.depositedPaise).toFixed(2),
        'Outstanding (₹)': paiseToRupees(r.outstandingPaise).toFixed(2),
        FY: fyLabel,
      };
    });

    const buffer = buildXlsx([
      { name: 'TDS 194C Details', rows: detailRows },
    ]);

    return { buffer, filename: `tds-194c-${fyLabel}.xlsx` };
  }

  // ─── 6.5b: Liability tracker ─────────────────────────────────────────────────

  /**
   * Return per-PAN liability/deposited/outstanding rows for a section + FY.
   *
   * 194R: tenant-scoped (requires clientId).
   * 194C: platform-wide (GIFSY only; clientId ignored).
   *
   * Outstanding can be negative (over-deposit) — passed through as-is.
   */
  async getLiability(
    section: '194R' | '194C',
    fyLabel: string,
    clientId: string,
  ): Promise<{
    section: string;
    fyLabel: string;
    rows: Array<{
      panNumber: string;
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
    }>;
    totals: {
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
    };
  }> {
    if (section === '194R') {
      const rows = await this.compute194R(clientId, fyLabel);
      const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
      const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
      const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

      return {
        section: '194R',
        fyLabel,
        rows: rows.map((r) => ({
          panNumber: r.panNumber,
          liabilityPaise: r.liabilityPaise.toString(),
          depositedPaise: r.depositedPaise.toString(),
          outstandingPaise: r.outstandingPaise.toString(),
        })),
        totals: {
          liabilityPaise: totalLiability.toString(),
          depositedPaise: totalDeposited.toString(),
          outstandingPaise: totalOutstanding.toString(),
        },
      };
    }

    // 194C — platform-wide
    const rows = await this.compute194C(fyLabel);
    const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
    const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
    const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

    return {
      section: '194C',
      fyLabel,
      rows: rows.map((r) => ({
        panNumber: r.panNumber,
        liabilityPaise: r.liabilityPaise.toString(),
        depositedPaise: r.depositedPaise.toString(),
        outstandingPaise: r.outstandingPaise.toString(),
      })),
      totals: {
        liabilityPaise: totalLiability.toString(),
        depositedPaise: totalDeposited.toString(),
        outstandingPaise: totalOutstanding.toString(),
      },
    };
  }
}
