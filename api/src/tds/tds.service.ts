/**
 * TDS aggregation engine — P6.5a.
 *
 * Computes per-(PAN, section, FY) liability / deposited / outstanding.
 * READ-ONLY (no writes). Uploads and write-side = 6.5b.
 *
 * Money: all amounts in BigInt paise. TDS rounded to nearest rupee.
 * No-PAN: each no-PAN recipient is its OWN deductee at the no-PAN rate (default 20%); thresholds
 * apply per deductee. 194R keys per PARTNER (`__NO_PAN__:<partnerId>`; an owner-less outlet →
 * `__NO_PAN__:outlet:<clientId>:<outletCode>`). 194C keys per OUTLET (`__NO_PAN__:outlet:…`) — the
 * same granularity the credits rail uses for its no-PAN threshold + recovery ledger. Bare
 * '__NO_PAN__' = identity-less amounts only; identity-less no-PAN DEPOSITS are shown on one
 * "Earlier no-PAN deposits (not linked to a partner)" row and netted in the totals (see below).
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
  fyLabelForPeriod,
  periodWindowForFy,
  grossUpTdsPaise,
  rate194RFrom,
  rate194CFrom,
  roundToRupeePaise,
  sectionParamToEnum,
  effectiveEntrySection,
  parseOffPlatformUpload,
  parseDepositUpload,
  buildOffPlatformTemplate,
  buildDepositTemplate,
  offPlatformFileHash,
  depositFileHash,
  cellSafe,
} from './tds.helpers';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { withholdingTdsPaise } from './tds-methodology.helper';
import type { UploadResult, UploadRowError } from './dto/tds.dto';
import { buildXlsx } from '../common/xlsx';
import { paiseToRupees } from '../common/money';

// ─── Result types ─────────────────────────────────────────────────────────────

/**
 * No-PAN keys. A partner without a PAN is a deductee in their OWN right: the FY threshold and
 * the no-PAN gross-up apply PER RECIPIENT, never to a pool of every no-PAN partner. So each
 * no-PAN deductee gets its own key (mirrors the credits FIX-B `__NO_PAN__:<outlet>` sentinel
 * convention):
 *   - `__NO_PAN__:<partnerId>`                     — a no-PAN ChannelPartner (the deductee)
 *   - `__NO_PAN__:outlet:<clientId>:<outletCode>`  — an outlet with no owner attached
 * The bare `__NO_PAN__` key survives ONLY as the "unattributed" bucket for amounts that carry no
 * identity at all (a legacy blank-PAN off-platform/deposit row, or a no-PAN deposit uploaded
 * without an Outlet Code) — so nothing silently drops out of the totals.
 * Every PAN row is unaffected: a tenant with no no-PAN deductee is byte-identical.
 */
const NO_PAN_KEY = '__NO_PAN__';
export const noPanPartnerKey = (partnerId: string): string => `${NO_PAN_KEY}:${partnerId}`;
export const noPanOutletKey = (clientId: string, outletCode: string): string =>
  `${NO_PAN_KEY}:outlet:${clientId}:${outletCode}`;
/** True for the bare unattributed key AND every per-deductee no-PAN key. */
export const isNoPanKey = (key: string): boolean =>
  key === NO_PAN_KEY || key.startsWith(`${NO_PAN_KEY}:`);
/**
 * A STORED PAN value that means "no PAN": blank, or the `__NO_PAN__…` sentinel the upload parsers
 * write for an explicit marker. Stored values such as 'NA' / 'PANNOTAVBL' on a partner or on an
 * older row are NOT reinterpreted — marker recognition happens only on upload cells (tds.helpers).
 */
const isNoPanCell = (pan: string | null | undefined): boolean =>
  !pan || !pan.trim() || isNoPanKey(pan.trim().toUpperCase());

/** Label of the row holding no-PAN deposits that cannot be linked to a deductee. */
export const UNLINKED_NO_PAN_DEPOSIT_LABEL = 'Earlier no-PAN deposits (not linked to a partner)';
/** Row key of that row (distinct from the identity-less base bucket '__NO_PAN__'). */
export const UNLINKED_NO_PAN_DEPOSIT_KEY = `${NO_PAN_KEY}:unlinked-deposits`;

/**
 * Export "Deductee Name" for a no-PAN row: "<owner/business name> (NO PAN ON FILE)" for a
 * per-deductee row; the unattributed bucket (no identity) keeps the plain "NO PAN ON FILE".
 */
function noPanDeducteeName(d: NoPanDeductee | undefined, unlinked?: boolean): string {
  if (unlinked) return UNLINKED_NO_PAN_DEPOSIT_LABEL;
  if (!d) return 'NO PAN ON FILE';
  return d.name ? `${d.name} (NO PAN ON FILE)` : 'NO PAN ON FILE';
}

/**
 * A rupee money cell for the TDS exports, written as a real NUMBER (2-dp) — never a string. Numbers
 * bypass the formula-injection text guard (cellSafe only touches strings), so a negative outstanding
 * exports as a real negative number (-1000) instead of the text "'-1000.00".
 */
function moneyCell(paise: bigint): number {
  return Number(paiseToRupees(paise).toFixed(2));
}

/**
 * Totals over 194R/194C rows — always exactly Σ rows. (The "Earlier no-PAN deposits" row carries
 * its deposit as a negative outstanding, so total outstanding = total liability − total deposited.)
 */
function summariseRows(
  rows: Array<{ baseFyTotalPaise: bigint; liabilityPaise: bigint; depositedPaise: bigint; outstandingPaise: bigint }>,
) {
  return {
    totalBasePaise: rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n),
    totalLiabilityPaise: rows.reduce((s, r) => s + r.liabilityPaise, 0n),
    totalDepositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0n),
    totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0n),
    rowCount: rows.length,
  };
}

/** Identity of a per-deductee no-PAN row (absent on PAN rows and on the unattributed bucket). */
export interface NoPanDeductee {
  partnerId: string | null;
  clientId: string | null;
  /** Owner name (else business name) of the partner, or the outlet name for an owner-less outlet. */
  name: string;
  outletCodes: string[];
}

export interface TdsRow194R {
  panNumber: string; // a PAN, a per-deductee `__NO_PAN__:…` key, or the unattributed '__NO_PAN__'
  noPanDeductee?: NoPanDeductee;
  /**
   * The "Earlier no-PAN deposits (not linked to a partner)" row: no base, no liability, the
   * deposit with outstanding = −deposit. Always present when such deposits exist; totals = Σ rows.
   */
  unlinkedNoPanDeposit?: true;
  fyLabel: string;
  baseFyTotalPaise: bigint;
  liabilityPaise: bigint;
  depositedPaise: bigint;
  outstandingPaise: bigint;
}

/** GROSS-UP "in lieu of TDS" recovery attributed to one contributing tenant (report-only). */
export interface TdsRecoveryAttribution {
  clientId: string;
  tenantSharePaise: bigint;
}

/** Which methodology(-ies) the PAN's 194C entries were FROZEN with. */
export type TdsMethodologyLabel = 'DEDUCT' | 'GROSS_UP' | 'MIXED' | null;

export interface TdsRow194C {
  panNumber: string;
  noPanDeductee?: NoPanDeductee;
  /** See TdsRow194R.unlinkedNoPanDeposit. */
  unlinkedNoPanDeposit?: true;
  entityType: string;
  fyLabel: string;
  baseFyTotalPaise: bigint;
  maxSinglePaise: bigint; // highest single payment (for threshold check)
  thresholdMet: boolean;
  liabilityPaise: bigint;           // (a) with-threshold
  liabilityNoThresholdPaise: bigint; // (b) no-threshold
  depositedPaise: bigint;
  outstandingPaise: bigint; // liability − (deposited + withheld); can be negative
  // ── Methodology-aware fields (reflect the DEDUCT / GROSS-UP ledgers) ──
  methodology: TdsMethodologyLabel; // frozen methodology on the PAN's entries (MIXED if both)
  withheldPaise: bigint;   // DEDUCT: sum of TdsDeductionEntry.tdsDeductedThisPaise (already collected)
  recoveredPaise: bigint;  // GROSS-UP: sum of TdsRecoveryEntry.tenantSharePaise (report-only attribution)
  recoveryByTenant: TdsRecoveryAttribution[]; // GROSS-UP per-tenant recovery split (report-only)
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
  totalWithheldPaise: bigint;   // DEDUCT collected via withholding (ledger)
  totalRecoveredPaise: bigint;  // GROSS-UP recovered attribution (ledger, report-only)
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
  methodologies: Set<'DEDUCT' | 'GROSS_UP'>; // frozen methodologies seen on this PAN's entries
  // FIX-2: base split by frozen methodology so liability uses the CORRECT statutory basis —
  // DEDUCT → withholding (base×rate/100); GROSS_UP (and null/legacy) → gross-up (base×rate/den).
  deductBasePaise: bigint;
  grossUpBasePaise: bigint;
}

// ─── Thresholds (paise) ──────────────────────────────────────────────────────

// Statutory rates + thresholds are resolved per financial year from the single platform-level
// source of truth (TdsStatutoryConfigService.getForFy) inside compute194R/compute194C — no local
// copies here (this used to duplicate the constants in credits.service; that drift risk is gone).

@Injectable()
export class TdsService {
  private readonly logger = new Logger(TdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statutory: TdsStatutoryConfigService,
  ) {}

  // ─── 194R ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194R rows for a given clientId and FY label (e.g. "2025-26").
   * Aggregates all three sources, applies the retroactive threshold, and
   * subtracts actual deposits to produce outstanding.
   */
  async compute194R(clientId: string, fyLabel: string): Promise<TdsRow194R[]> {
    const cfg = await this.statutory.getForFy(fyLabel);
    const fy = fyFromLabel(fyLabel);
    const { start, endExclusive } = fy;
    // FIX-4: VISIBILITY entries frozen 194R are anchored by their payout PERIOD's FY (matching
    // the ledger); INCENTIVE (non-visibility) 194R keeps its paidAt anchor.
    const { startPeriod, endPeriod } = periodWindowForFy(fyLabel);

    // Accumulate per PAN
    const accum = new Map<string, PanAccum194R>();

    // `noPanKey` = the per-deductee key to use when this amount has NO PAN (see noPanPartnerKey /
    // noPanOutletKey). Omitted → the unattributed bucket (legacy behaviour for identity-less rows).
    const addToPan = (pan: string | null | undefined, amountPaise: bigint, noPanKey?: string) => {
      const key = isNoPanCell(pan) ? (noPanKey ?? NO_PAN_KEY) : pan!.trim().toUpperCase();
      const hasPan = !isNoPanKey(key);
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
      } else {
        accum.set(key, { panNumber: key, hasPan, totalPaise: amountPaise });
      }
    };

    // Visibility field IDs (the explicit classifier) — needed both to widen the query by
    // period and to resolve the FROZEN-null fallback classification (effectiveEntrySection).
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { clientId, payoutStream: 'VISIBILITY' },
      select: { id: true },
    });
    const visibilityFieldIds = new Set(visibilityFields.map((f) => f.id));
    const visFieldIdArr = [...visibilityFieldIds];

    // ── Source 1: CreditPayoutEntry whose EFFECTIVE section is 194R ──────────────
    // Two windows, unioned by id (a visibility row can satisfy both):
    //   A) paidAt in FY  — covers INCENTIVE (paidAt anchor) + visibility paid within the FY
    //   B) period in FY  — covers VISIBILITY frozen-194R whose PERIOD (not paidAt) lands in FY
    // Each row is then re-checked with its correct anchor so a visibility row whose PERIOD is
    // in a DIFFERENT FY (but whose paidAt happened to fall in this one) is dropped.
    // NOTE: CreditPayoutEntry.outletId stores the outletCode (string code), NOT the Outlet PK.
    const paidAtEntries = await this.prisma.creditPayoutEntry.findMany({
      where: {
        clientId,
        status: 'PAID',
        paidAt: { gte: start, lt: endExclusive },
        // Exclude historical VENDOR_IMPORT payouts: these were already settled off-platform by the
        // prior vendor and are recorded as display-only history — they must NEVER enter statutory
        // TDS (194R). Provenance lives on the parent CreditBatch.sourceKind. NULL-safe: a bare
        // `{ not: 'VENDOR_IMPORT' }` would silently DROP ordinary operator-upload entries (whose
        // batch.sourceKind is NULL) under Prisma's three-valued logic, so OR-wrap to keep them.
        // Tenants with no import batches (e.g. Deoleo) match every row here → behaviour unchanged.
        batch: { OR: [{ sourceKind: null }, { sourceKind: { not: 'VENDOR_IMPORT' } }] },
      },
      select: { id: true, amountPaise: true, fieldId: true, outletId: true, tdsSection: true, period: true },
    });
    const periodVisEntries = visFieldIdArr.length
      ? await this.prisma.creditPayoutEntry.findMany({
          where: {
            clientId,
            status: 'PAID',
            period: { gte: startPeriod, lte: endPeriod },
            fieldId: { in: visFieldIdArr },
          },
          select: { id: true, amountPaise: true, fieldId: true, outletId: true, tdsSection: true, period: true },
        })
      : [];

    const unionById = new Map<string, (typeof paidAtEntries)[number]>();
    for (const e of [...paidAtEntries, ...periodVisEntries]) unionById.set(e.id, e);

    const section194REntries = [...unionById.values()].filter((e) => {
      const isVis = visibilityFieldIds.has(e.fieldId);
      // Visibility rows belong to THIS FY only if their period's FY matches (period anchor);
      // non-visibility rows came from the paidAt window so are already in-FY.
      const inFy = isVis ? fyLabelForPeriod(e.period) === fyLabel : true;
      if (!inFy) return false;
      return effectiveEntrySection(e.tdsSection, isVis) === 'SEC_194R';
    });
    const outletCodes = [...new Set(section194REntries.map((e) => e.outletId))];

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
          // isParent:false — parents never own outlets so are never in partnerIds; defensive
          // (docs/plans/PARTNER-MULTI-OUTLET.md §9).
          where: { id: { in: partnerIds }, isParent: false },
          select: { id: true, panNumber: true },
        })
      : [];
    const partnerToPan = new Map(partners.map((p) => [p.id, p.panNumber]));

    for (const entry of section194REntries) {
      const partnerId = outletToPartnerId.get(entry.outletId) ?? null;
      const pan = partnerId ? (partnerToPan.get(partnerId) ?? null) : null;
      // No PAN → this partner is its OWN deductee (an owner-less outlet keys by tenant+outlet).
      addToPan(
        pan,
        entry.amountPaise,
        partnerId ? noPanPartnerKey(partnerId) : noPanOutletKey(clientId, entry.outletId),
      );
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
        partner: { select: { id: true, panNumber: true } },
      },
    });

    for (const r of redemptions) {
      if (r.valuePaise != null) {
        addToPan(r.partner?.panNumber, r.valuePaise, r.partner?.id ? noPanPartnerKey(r.partner.id) : undefined);
      }
    }

    // ── Source 3: TdsOffPlatformEntry (section=SEC_194R, clientId, entryDate in FY) ──
    const offPlatform = await this.prisma.tdsOffPlatformEntry.findMany({
      where: {
        clientId,
        section: 'SEC_194R',
        entryDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true, outletCode: true },
    });

    // ── Deposited: SUM TdsDeposit (section=SEC_194R, clientId, depositDate in FY) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194R',
        clientId,
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true, outletCode: true },
    });

    // No-PAN off-platform entries AND deposits are attributed to their deductee via the row's
    // Outlet Code (matched case-insensitively within the tenant; outlet → owner partner). One
    // extra query, run ONLY when such rows exist — PAN rows are unchanged.
    const noPanCodes = [...offPlatform, ...deposits]
      .filter((r) => isNoPanCell(r.panNumber) && r.outletCode?.trim())
      .map((r) => r.outletCode!.trim());
    const outletsByCode = await this.outletsByCodeCI(noPanCodes, clientId);
    const ownerPans = await this.ownerPansOf(outletsByCode);
    // Outlet → deductee key: the owner's PAN when one is ON FILE (the amount counts under that PAN —
    // flagged on upload), else the owner's own no-PAN key (owner-less outlet → per-outlet key).
    const keyForCode = (code: string | null | undefined): string | null => {
      const c = code?.trim();
      if (!c) return null;
      const matches = outletsByCode.get(c.toUpperCase()) ?? [];
      if (matches.length !== 1) return null;
      const o = matches[0];
      const pan = o.partnerId ? ownerPans.get(o.partnerId) : null;
      if (pan) return pan;
      return o.partnerId ? noPanPartnerKey(o.partnerId) : noPanOutletKey(o.clientId, o.outletCode);
    };

    for (const e of offPlatform) {
      // No-PAN off-platform benefit → the outlet owner's PAN / own deductee key (bare bucket if unlinkable).
      addToPan(e.panNumber, e.amountPaise, isNoPanCell(e.panNumber) ? (keyForCode(e.outletCode) ?? undefined) : undefined);
    }

    const deposited = new Map<string, bigint>();
    let unlinkedNoPanDepositPaise = 0n;
    // Owner PANs that received a no-PAN-marker deposit but have NO base this FY — they still get a
    // row (base 0, outstanding −deposit) so the deposit never drops out of the totals.
    const depositOnlyPanKeys = new Set<string>();
    for (const d of deposits) {
      if (!isNoPanCell(d.panNumber)) {
        const key = d.panNumber.trim().toUpperCase();
        deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
        continue;
      }
      // No-PAN deposit: the owner's PAN row (like any PAN deposit), or its no-PAN deductee's row when
      // it has one this FY; otherwise (no Outlet Code / unknown code / no base) → "Earlier" row.
      const key = keyForCode(d.outletCode);
      if (key && (!isNoPanKey(key) || accum.has(key))) {
        deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
        if (!isNoPanKey(key) && !accum.has(key)) depositOnlyPanKeys.add(key);
      } else unlinkedNoPanDepositPaise += d.amountPaise;
    }

    // ── Build result rows ──
    const rows: TdsRow194R[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet = fyTotal > cfg.thr194rFyPaise;
      const liabilityPaise = thresholdMet
        ? grossUpTdsPaise(fyTotal, rate194RFrom(cfg, a.hasPan))
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
    for (const key of depositOnlyPanKeys) {
      const depositedPaise = deposited.get(key) ?? 0n;
      rows.push({
        panNumber: key,
        fyLabel,
        baseFyTotalPaise: 0n,
        liabilityPaise: 0n,
        depositedPaise,
        outstandingPaise: -depositedPaise,
      });
    }
    if (unlinkedNoPanDepositPaise > 0n) {
      rows.push({
        panNumber: UNLINKED_NO_PAN_DEPOSIT_KEY,
        fyLabel,
        baseFyTotalPaise: 0n,
        liabilityPaise: 0n,
        depositedPaise: unlinkedNoPanDepositPaise,
        outstandingPaise: -unlinkedNoPanDepositPaise,
        unlinkedNoPanDeposit: true as const,
      });
    }
    await this.attachNoPanDeductees(rows, clientId);

    // Sort: threshold-met first (descending by base), then below-threshold
    rows.sort((a, b) => {
      const aAbove = a.baseFyTotalPaise > cfg.thr194rFyPaise;
      const bAbove = b.baseFyTotalPaise > cfg.thr194rFyPaise;
      if (aAbove !== bAbove) return aAbove ? -1 : 1;
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /**
   * owner partnerId → its PAN, for owners of the given outlets that have a REAL PAN on file
   * (blank / `__NO_PAN__` excluded). No query when there are no owners.
   */
  private async ownerPansOf(
    outletsByCode: Map<string, Array<{ partnerId: string | null }>>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set([...outletsByCode.values()].flat().map((o) => o.partnerId).filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const owners = await this.prisma.channelPartner.findMany({
      where: { id: { in: ids } },
      select: { id: true, panNumber: true },
    });
    for (const o of owners) {
      if (!isNoPanCell(o.panNumber)) out.set(o.id, o.panNumber!.trim().toUpperCase());
    }
    return out;
  }

  /** Summary for 194R: totals across all PAN rows. */
  async summary194R(clientId: string, fyLabel: string): Promise<TdsSummary194R> {
    const rows = await this.compute194R(clientId, fyLabel);
    return { fyLabel, clientId, ...summariseRows(rows) };
  }

  // ─── 194C ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194C rows (platform-wide, no clientId scope).
   *
   * Sources: CreditPayoutEntry whose EFFECTIVE section is 194C, across ALL tenants —
   * bucketed by the FROZEN tdsSection stamp (W0-B) when present; a null stamp
   * (legacy) falls back to the live payoutStream=VISIBILITY classification. See
   * effectiveEntrySection. Frozen 194C is only ever derived for a VISIBILITY payout,
   * so we query (fieldId ∈ current visibility fields) OR (tdsSection = SEC_194C) to
   * catch both the fallback rows and any entry frozen 194C even if its field's live
   * payoutStream later changed.
   *
   * Two liability columns: (a) with-threshold, (b) no-threshold. The gross-up
   * liability number is unchanged by methodology; methodology only affects what is
   * already-COLLECTED (DEDUCT withholding) and the report-only recovery attribution
   * (GROSS-UP), both read from the typed ledgers.
   */
  async compute194C(fyLabel: string): Promise<TdsRow194C[]> {
    const cfg = await this.statutory.getForFy(fyLabel);
    // FIX-4: VISIBILITY 194C entries are anchored by their payout PERIOD's FY (matching the
    // credits ledger WRITE), NOT paidAt — so a period=2026-03 payout banked in April 2026
    // still lands in FY 2025-26 on both the base READ and the DEDUCT/recovery ledger. All
    // 194C entries are visibility-regime (INCENTIVE is always 194R), so the whole source uses
    // the period window.
    const { startPeriod, endPeriod } = periodWindowForFy(fyLabel);
    // Deposits keep their own depositDate anchor (a deposit MADE in the FY), independent of
    // the payout period anchor above.
    const { start, endExclusive } = fyFromLabel(fyLabel);

    // Accumulate per PAN (platform-wide)
    const accum = new Map<string, PanAccum194C>();

    const addToC = (
      pan: string | null | undefined,
      amountPaise: bigint,
      entityType: string | null | undefined,
      methodology: 'DEDUCT' | 'GROSS_UP' | null | undefined,
      noPanKey?: string,
    ) => {
      // No PAN -> the per-deductee key (see noPanPartnerKey / noPanOutletKey), never a pool.
      const key = isNoPanCell(pan) ? (noPanKey ?? NO_PAN_KEY) : pan!.trim().toUpperCase();
      const hasPan = !isNoPanKey(key);
      const effEntityType = entityType ?? 'OTHERS';
      // DEDUCT → withholding basis; GROSS_UP or null(legacy) → gross-up basis (preserves the
      // pre-FIX-2 behaviour for unstamped rows, which were always grossed up).
      const isDeduct = methodology === 'DEDUCT';
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
        if (amountPaise > existing.maxSinglePaise) {
          existing.maxSinglePaise = amountPaise;
        }
        if (methodology) existing.methodologies.add(methodology);
        if (isDeduct) existing.deductBasePaise += amountPaise;
        else existing.grossUpBasePaise += amountPaise;
      } else {
        const methodologies = new Set<'DEDUCT' | 'GROSS_UP'>();
        if (methodology) methodologies.add(methodology);
        accum.set(key, {
          panNumber: key,
          hasPan,
          entityType: effEntityType,
          totalPaise: amountPaise,
          maxSinglePaise: amountPaise,
          methodologies,
          deductBasePaise: isDeduct ? amountPaise : 0n,
          grossUpBasePaise: isDeduct ? 0n : amountPaise,
        });
      }
    };

    // ── Source: CreditPayoutEntry effective-194C (payoutStream=VISIBILITY fields), all clients ──
    // Get all visibility field IDs across all tenants (payoutStream is the explicit classifier;
    // isSeparatePayout is its deprecated boolean mirror, dropped in W3) — used both to widen the
    // query and to resolve the FROZEN-null fallback classification (effectiveEntrySection).
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { payoutStream: 'VISIBILITY' },
      select: { id: true, clientId: true },
    });
    const visFieldIds = new Set(visibilityFields.map((f) => f.id));

    // Match current-visibility-field entries OR any entry FROZEN as SEC_194C (covers a field
    // whose live payoutStream changed after confirm). Each fetched row is then re-checked with
    // effectiveEntrySection so a VISIBILITY-field entry frozen SEC_194R is correctly dropped here.
    const visEntries = await this.prisma.creditPayoutEntry.findMany({
      where: {
        status: 'PAID',
        // FIX-4: bucket by payout PERIOD's FY (matches the ledger), not paidAt.
        period: { gte: startPeriod, lte: endPeriod },
        OR: [
          { fieldId: { in: [...visFieldIds] } },
          { tdsSection: 'SEC_194C' },
        ],
      },
      select: {
        amountPaise: true,
        outletId: true,
        clientId: true,
        fieldId: true,
        tdsSection: true,
        tdsMethodology: true,
      },
    });

    // Keep only rows whose EFFECTIVE section is 194C (frozen stamp wins; null falls back).
    const c194Entries = visEntries.filter(
      (e) => effectiveEntrySection(e.tdsSection, visFieldIds.has(e.fieldId)) === 'SEC_194C',
    );

    if (c194Entries.length > 0) {
      // CreditPayoutEntry.outletId stores the outletCode (NOT the Outlet PK).
      // For 194C we need to resolve across all tenants (clientId already on outlet row).
      const outletCodes194C = [...new Set(c194Entries.map((e) => e.outletId))];
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
            // isParent:false — defensive (parents own no outlets → never in partnerIds).
            where: { id: { in: partnerIds }, isParent: false },
            select: { id: true, panNumber: true, entityType: true },
          })
        : [];
      const partnerMap = new Map(partners.map((p) => [p.id, p]));

      for (const entry of c194Entries) {
        const partnerId = outletToPartnerId.get(`${entry.clientId}:${entry.outletId}`) ?? null; // outletId = outletCode
        const partner = partnerId ? partnerMap.get(partnerId) : null;
        addToC(
          partner?.panNumber,
          entry.amountPaise,
          partner?.entityType ?? null,
          entry.tdsMethodology,
          // 194C no-PAN = per OUTLET (same granularity as the credits rail's threshold + recovery).
          noPanOutletKey(String(entry.clientId), entry.outletId),
        );
      }
    }

    // ── Deposited: SUM TdsDeposit (section=SEC_194C, depositDate in FY) — clientId null (platform) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194C',
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true, outletCode: true, clientId: true },
    });

    // A no-PAN 194C deposit is attributed via its Outlet Code (case-insensitive) to that outlet's
    // per-outlet key. 194C is platform-wide (deposit clientId null) and an outletCode is unique only
    // WITHIN a tenant: it resolves by the deposit's tenant when set, else only when the code matches
    // exactly one outlet platform-wide — ambiguous / unknown → the identity-less pool.
    const outletsByCode = await this.outletsByCodeCI(
      deposits.filter((d) => isNoPanCell(d.panNumber) && d.outletCode?.trim()).map((d) => d.outletCode!.trim()),
      null,
    );
    const ownerPans194C = await this.ownerPansOf(outletsByCode);
    const deposited = new Map<string, bigint>();
    let unlinkedNoPanDepositPaise = 0n;
    // Owner PANs that received a no-PAN-marker deposit but have NO base this FY (see 194R).
    const depositOnlyPanKeys = new Set<string>();
    for (const d of deposits) {
      if (!isNoPanCell(d.panNumber)) {
        const key = d.panNumber.trim().toUpperCase();
        deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
        continue;
      }
      const oc = d.outletCode?.trim();
      const candidates = oc ? (outletsByCode.get(oc.toUpperCase()) ?? []) : [];
      const scoped = d.clientId ? candidates.filter((c) => c.clientId === d.clientId) : candidates;
      let key: string | null = null;
      if (scoped.length === 1) {
        const o = scoped[0];
        key = (o.partnerId ? ownerPans194C.get(o.partnerId) : undefined) ?? noPanOutletKey(o.clientId, o.outletCode);
      }
      if (key && (!isNoPanKey(key) || accum.has(key))) {
        deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
        if (!isNoPanKey(key) && !accum.has(key)) depositOnlyPanKeys.add(key);
      } else unlinkedNoPanDepositPaise += d.amountPaise;
    }

    // ── DEDUCT already-collected: SUM TdsDeductionEntry.tdsDeductedThisPaise (section 194C, FY) ──
    // The DEDUCT ledger is keyed by fyLabel (IST FY string) + section, platform-wide (all tenants
    // contributing to the PAN). This is TDS withheld from payouts, counted as already-collected in
    // addition to TdsDeposit. See the money-path note: Stream B must NOT ALSO upload these withheld
    // amounts as TdsDeposit rows, or deposited+withheld would double-count against the liability.
    const deductions = await this.prisma.tdsDeductionEntry.findMany({
      where: { section: 'SEC_194C', fyLabel },
      select: { panNumber: true, tdsDeductedThisPaise: true },
    });

    const withheld = new Map<string, bigint>();
    for (const d of deductions) {
      // The DEDUCT ledger is only ever written for PAN holders (no-PAN visibility is recovery-
      // only), so a blank PAN here is a legacy row with no identity -> the unattributed bucket.
      const key = isNoPanCell(d.panNumber) ? NO_PAN_KEY : d.panNumber.trim().toUpperCase();
      withheld.set(key, (withheld.get(key) ?? 0n) + d.tdsDeductedThisPaise);
    }

    // ── GROSS-UP recovery attribution: SUM TdsRecoveryEntry.tenantSharePaise (section 194C, FY) ──
    // Report-only ("in lieu of TDS"): per-PAN total + a per-tenant split. Does NOT change the
    // liability or outstanding number — purely surfaces what has been recovered from each tenant.
    const recoveries = await this.prisma.tdsRecoveryEntry.findMany({
      where: { section: 'SEC_194C', fyLabel },
      select: { panNumber: true, clientId: true, tenantSharePaise: true },
    });

    // FIX-B: no-PAN recovery is written as panNumber='__NO_PAN__:<outletCode>' (+ the row's
    // clientId) — per OUTLET, exactly the 194C no-PAN key here, so it maps 1:1 to that row.
    const recOutletCode = (raw: string | undefined): string | null => {
      if (!raw || !raw.toUpperCase().startsWith(`${NO_PAN_KEY}:`)) return null;
      return raw.slice(NO_PAN_KEY.length + 1) || null;
    };

    const recovered = new Map<string, bigint>();
    const recoveryByTenant = new Map<string, Map<string, bigint>>();
    for (const r of recoveries) {
      const raw = r.panNumber?.trim();
      let key: string;
      if (!isNoPanCell(raw)) {
        key = raw!.toUpperCase();
      } else {
        const oc = recOutletCode(raw);
        key = oc ? noPanOutletKey(r.clientId, oc) : NO_PAN_KEY;
      }
      recovered.set(key, (recovered.get(key) ?? 0n) + r.tenantSharePaise);
      let tenantMap = recoveryByTenant.get(key);
      if (!tenantMap) {
        tenantMap = new Map<string, bigint>();
        recoveryByTenant.set(key, tenantMap);
      }
      tenantMap.set(r.clientId, (tenantMap.get(r.clientId) ?? 0n) + r.tenantSharePaise);
    }

    // ── Build result rows ──
    const rows: TdsRow194C[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet =
        a.maxSinglePaise > cfg.thr194cSinglePaise ||
        fyTotal > cfg.thr194cFyPaise;

      const rateForPan = rate194CFrom(cfg, a.hasPan, a.entityType);

      // FIX-2: liability is METHODOLOGY-AWARE. A DEDUCT PAN's statutory TDS is WITHHOLDING
      // (base × rate/100); a GROSS_UP (or legacy/unstamped) PAN's is the payer-borne GROSS-UP
      // (base × rate/den). A MIXED PAN sums each portion on its own basis. Using gross-up for a
      // fully-withheld DEDUCT PAN left a phantom residue (liability > withheld) — now
      // liability(DEDUCT) = withheld once fully collected ⇒ outstanding reconciles to 0.
      const withholdingPortionPaise = withholdingTdsPaise(a.deductBasePaise, rateForPan);
      const grossUpPortionPaise = grossUpTdsPaise(a.grossUpBasePaise, rateForPan);

      // (b) no-threshold: TDS on everything regardless of the ₹30k/₹1L gate.
      const liabilityNoThresholdPaise = withholdingPortionPaise + grossUpPortionPaise;

      // (a) with-threshold — only due once the cumulative crosses the threshold.
      const liabilityPaise = thresholdMet ? liabilityNoThresholdPaise : 0n;

      const depositedPaise = deposited.get(key) ?? 0n;
      const withheldPaise = withheld.get(key) ?? 0n;
      const recoveredPaise = recovered.get(key) ?? 0n;
      // Outstanding nets BOTH deposited AND DEDUCT-withheld against the liability.
      const outstandingPaise = liabilityPaise - depositedPaise - withheldPaise;

      // Which frozen methodologies did this PAN's entries carry? (null = all legacy/unstamped.)
      const methSet = a.methodologies;
      const methodology: TdsMethodologyLabel =
        methSet.size === 0 ? null : methSet.size === 1 ? [...methSet][0] : 'MIXED';

      const tenantMap = recoveryByTenant.get(key);
      const recoveryList: TdsRecoveryAttribution[] = tenantMap
        ? [...tenantMap.entries()]
            .map(([clientId, tenantSharePaise]) => ({ clientId, tenantSharePaise }))
            .sort((x, y) =>
              y.tenantSharePaise > x.tenantSharePaise ? 1 : y.tenantSharePaise < x.tenantSharePaise ? -1 : 0,
            )
        : [];

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
        methodology,
        withheldPaise,
        recoveredPaise,
        recoveryByTenant: recoveryList,
      });
    }
    // Recovery is report-only; a no-PAN outlet's recovery with no base this FY was previously only
    // visible inside the pooled bucket — keep it visible (outstanding 0) whenever any no-PAN row exists.
    if (rows.some((r) => isNoPanKey(r.panNumber))) {
      for (const [key, rec] of recovered) {
        if (!isNoPanKey(key) || accum.has(key)) continue;
        const tenantMap = recoveryByTenant.get(key);
        rows.push({
          panNumber: key,
          entityType: 'OTHERS',
          fyLabel,
          baseFyTotalPaise: 0n,
          maxSinglePaise: 0n,
          thresholdMet: false,
          liabilityPaise: 0n,
          liabilityNoThresholdPaise: 0n,
          depositedPaise: 0n,
          outstandingPaise: 0n,
          methodology: null,
          withheldPaise: 0n,
          recoveredPaise: rec,
          recoveryByTenant: tenantMap
            ? [...tenantMap.entries()].map(([clientId, tenantSharePaise]) => ({ clientId, tenantSharePaise }))
            : [],
        });
      }
    }
    // WITHHELD-only no-PAN keys (legacy blank-PAN deduction rows) keep their own row so a withheld
    // amount never drops out (outstanding = −withheld). When the recovery-only loop above already
    // emitted a row for the SAME key (e.g. the bare `__NO_PAN__` bucket), MERGE into it — never two
    // rows for one key, and the recovered amount is counted once.
    for (const [key, w] of withheld) {
      if (!isNoPanKey(key) || accum.has(key)) continue;
      const existing = rows.find((r) => r.panNumber === key && !r.unlinkedNoPanDeposit);
      if (existing) {
        existing.withheldPaise += w;
        existing.outstandingPaise -= w;
        continue;
      }
      rows.push({
        panNumber: key,
        entityType: 'OTHERS',
        fyLabel,
        baseFyTotalPaise: 0n,
        maxSinglePaise: 0n,
        thresholdMet: false,
        liabilityPaise: 0n,
        liabilityNoThresholdPaise: 0n,
        depositedPaise: 0n,
        outstandingPaise: -w,
        methodology: null,
        withheldPaise: w,
        recoveredPaise: recovered.get(key) ?? 0n,
        recoveryByTenant: [],
      });
    }
    // Deposit-only owner PANs (a no-PAN-marker deposit attributed to an owner PAN with no base
    // this FY) → base 0, outstanding −deposit, so the deposit never drops out of the totals.
    for (const key of depositOnlyPanKeys) {
      const depositedPaise = deposited.get(key) ?? 0n;
      const withheldPaise = withheld.get(key) ?? 0n;
      const tenantMap = recoveryByTenant.get(key);
      rows.push({
        panNumber: key,
        entityType: 'OTHERS',
        fyLabel,
        baseFyTotalPaise: 0n,
        maxSinglePaise: 0n,
        thresholdMet: false,
        liabilityPaise: 0n,
        liabilityNoThresholdPaise: 0n,
        depositedPaise,
        outstandingPaise: -depositedPaise - withheldPaise,
        methodology: null,
        withheldPaise,
        recoveredPaise: recovered.get(key) ?? 0n,
        recoveryByTenant: tenantMap
          ? [...tenantMap.entries()].map(([clientId, tenantSharePaise]) => ({ clientId, tenantSharePaise }))
          : [],
      });
    }
    if (unlinkedNoPanDepositPaise > 0n) {
      rows.push({
        panNumber: UNLINKED_NO_PAN_DEPOSIT_KEY,
        entityType: 'OTHERS',
        fyLabel,
        baseFyTotalPaise: 0n,
        maxSinglePaise: 0n,
        thresholdMet: false,
        liabilityPaise: 0n,
        liabilityNoThresholdPaise: 0n,
        depositedPaise: unlinkedNoPanDepositPaise,
        outstandingPaise: -unlinkedNoPanDepositPaise,
        methodology: null,
        withheldPaise: 0n,
        recoveredPaise: 0n,
        recoveryByTenant: [],
        unlinkedNoPanDeposit: true as const,
      });
    }
    await this.attachNoPanDeductees(rows, null);

    // Sort descending by base
    rows.sort((a, b) => {
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /**
   * Attach the deductee identity (name + outlet codes) to every per-deductee no-PAN row, for the
   * reports/exports. Runs its lookups ONLY when such rows exist — a tenant/FY with no no-PAN
   * deductee issues no extra query and its rows are untouched (byte-identical).
   * `clientId` scopes the partner-outlet lookup for 194R; null = platform-wide (194C).
   */
  private async attachNoPanDeductees(
    rows: Array<{ panNumber: string; noPanDeductee?: NoPanDeductee }>,
    clientId: string | null,
  ): Promise<void> {
    const parse = (key: string): { partnerId: string } | { clientId: string; outletCode: string } | null => {
      if (!key.startsWith(`${NO_PAN_KEY}:`) || key === UNLINKED_NO_PAN_DEPOSIT_KEY) return null;
      const rest = key.slice(NO_PAN_KEY.length + 1);
      if (rest.startsWith('outlet:')) {
        const [cid, ...codeParts] = rest.slice('outlet:'.length).split(':');
        return { clientId: cid, outletCode: codeParts.join(':') };
      }
      return rest ? { partnerId: rest } : null;
    };
    const partnerIds = new Set<string>();
    const outletPairs: Array<{ clientId: string; outletCode: string }> = [];
    for (const r of rows) {
      const k = parse(r.panNumber);
      if (!k) continue;
      if ('partnerId' in k) partnerIds.add(k.partnerId);
      else outletPairs.push(k);
    }
    if (partnerIds.size === 0 && outletPairs.length === 0) return;

    const ids = [...partnerIds];
    // Outlet keys (194C per-outlet, and owner-less 194R outlets): the outlet + its current owner.
    const keyedOutlets = outletPairs.length
      ? await this.prisma.outlet.findMany({
          where: {
            clientId: { in: [...new Set(outletPairs.map((o) => o.clientId))] },
            outletCode: { in: [...new Set(outletPairs.map((o) => o.outletCode))] },
          },
          select: { outletCode: true, clientId: true, name: true, partnerId: true },
        })
      : [];
    const nameIds = [
      ...new Set([...ids, ...keyedOutlets.map((o) => o.partnerId).filter((x): x is string => !!x)]),
    ];
    const partners = nameIds.length
      ? await this.prisma.channelPartner.findMany({
          where: { id: { in: nameIds } },
          select: { id: true, clientId: true, ownerName: true, businessName: true },
        })
      : [];
    const partnerOutlets = ids.length
      ? await this.prisma.outlet.findMany({
          where: { partnerId: { in: ids }, ...(clientId ? { clientId } : {}) },
          select: { outletCode: true, partnerId: true },
        })
      : [];

    const partnerById = new Map(partners.map((p) => [p.id, p]));
    const codesByPartner = new Map<string, Set<string>>();
    for (const o of partnerOutlets) {
      if (!o.partnerId) continue;
      const set = codesByPartner.get(o.partnerId) ?? new Set<string>();
      set.add(o.outletCode);
      codesByPartner.set(o.partnerId, set);
    }
    const outletByKey = new Map(keyedOutlets.map((o) => [`${o.clientId}:${o.outletCode}`, o]));

    for (const r of rows) {
      const k = parse(r.panNumber);
      if (!k) continue;
      if ('partnerId' in k) {
        const p = partnerById.get(k.partnerId);
        r.noPanDeductee = {
          partnerId: k.partnerId,
          clientId: p?.clientId ?? clientId,
          name: p ? p.ownerName || p.businessName || '' : '',
          outletCodes: [...(codesByPartner.get(k.partnerId) ?? [])].sort(),
        };
      } else {
        // Per-OUTLET deductee: named by the outlet's current owner (else the outlet's own name).
        const o = outletByKey.get(`${k.clientId}:${k.outletCode}`);
        const owner = o?.partnerId ? partnerById.get(o.partnerId) : undefined;
        r.noPanDeductee = {
          partnerId: o?.partnerId ?? null,
          clientId: k.clientId,
          name: owner ? owner.ownerName || owner.businessName || '' : (o?.name ?? ''),
          outletCodes: [k.outletCode],
        };
      }
    }
  }

  /**
   * Case-insensitive outlet lookup by code (optionally within one tenant), indexed by the
   * UPPER-cased code → every matching outlet (several = ambiguous across tenants). No query when
   * there is nothing to resolve.
   */
  private async outletsByCodeCI(
    codes: string[],
    clientId: string | null,
  ): Promise<Map<string, Array<{ outletCode: string; clientId: string; partnerId: string | null }>>> {
    const out = new Map<string, Array<{ outletCode: string; clientId: string; partnerId: string | null }>>();
    const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean).map((c) => c.toUpperCase()))];
    if (!uniq.length) return out;
    const found = await this.prisma.outlet.findMany({
      where: {
        ...(clientId ? { clientId } : {}),
        OR: uniq.map((c) => ({ outletCode: { equals: c, mode: 'insensitive' as const } })),
      },
      select: { outletCode: true, clientId: true, partnerId: true },
    });
    for (const o of found) {
      const k = o.outletCode.toUpperCase();
      if (!uniq.includes(k)) continue;
      const list = out.get(k) ?? [];
      if (!list.some((x) => x.clientId === o.clientId && x.outletCode === o.outletCode)) {
        list.push({ outletCode: o.outletCode, clientId: o.clientId, partnerId: o.partnerId ?? null });
      }
      out.set(k, list);
    }
    return out;
  }

  /** Summary for 194C: totals across all PAN rows. */
  async summary194C(fyLabel: string): Promise<TdsSummary194C> {
    const rows = await this.compute194C(fyLabel);
    const base = summariseRows(rows);
    return {
      fyLabel,
      totalBasePaise: base.totalBasePaise,
      totalLiabilityPaise: base.totalLiabilityPaise,
      totalLiabilityNoThresholdPaise: rows.reduce((s, r) => s + r.liabilityNoThresholdPaise, 0n),
      totalDepositedPaise: base.totalDepositedPaise,
      totalWithheldPaise: rows.reduce((s, r) => s + r.withheldPaise, 0n),
      totalRecoveredPaise: rows.reduce((s, r) => s + r.recoveredPaise, 0n),
      totalOutstandingPaise: base.totalOutstandingPaise,
      rowCount: base.rowCount,
    };
  }

  // ─── 6.5b: Template builders ─────────────────────────────────────────────────

  /** Return a blank xlsx Buffer for the off-platform 194R upload template. */
  offPlatformTemplate(): Buffer {
    return buildOffPlatformTemplate();
  }

  /** Return a blank xlsx Buffer for the TDS deposit upload template. */
  depositTemplate(section: '194R' | '194C' = '194R'): Buffer {
    return buildDepositTemplate(section);
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

    const parsed = parseOffPlatformUpload(ab);
    const result = parsed.result;
    // No-PAN marker rows must name an outlet of THIS tenant (and are flagged when that outlet's
    // owner has a PAN on file — the amount then counts under that PAN).
    const rows = await this.validateNoPanUploadRows(parsed.rows, result, { clientId, section: '194R' });

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
        // The parser's REAL sheet row (error rows before this one are not in `rows`, so idx is off).
        const sheetRow = this.sheetRowOf(r) || idx + 2;
        result.errors.push({
          row: sheetRow,
          message: `Row ${sheetRow}: skipped — duplicate entry (already uploaded in this file)`,
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

    const parsed = parseDepositUpload(ab);
    const result = parsed.result;
    const rows = await this.validateNoPanUploadRows(parsed.rows, result, { clientId, section });

    if (!apply || rows.length === 0) {
      return result;
    }

    const prismaSection = sectionParamToEnum(section);
    const depositorType = section === '194R' ? 'CLIENT' : 'GIFSY';
    const uploadBatchId = depositFileHash(rows);

    // Rows already present for this file's batch id (same file re-upload → all). A 194C no-PAN row
    // stores the outlet's TENANT (resolved on upload), so 194C dedup is not scoped by clientId.
    const existing = await this.prisma.tdsDeposit.findMany({
      where: {
        section: prismaSection,
        ...(section === '194C' ? {} : { clientId: clientId ?? null }),
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
        // The parser's REAL sheet row (error rows before this one are not in `rows`, so idx is off).
        const sheetRow = this.sheetRowOf(r) || idx + 2;
        result.errors.push({
          row: sheetRow,
          message: `Row ${sheetRow}: skipped — duplicate entry (already uploaded in this file)`,
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
          // 194C (platform) rows keep clientId null, EXCEPT a no-PAN row: it records the tenant of
          // the outlet it was resolved to, so the deductee stays unambiguous later.
          clientId: (r as { resolvedClientId?: string }).resolvedClientId ?? clientId ?? undefined,
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

  /**
   * Upload-time checks for no-PAN marker rows (stored panNumber `__NO_PAN__`):
   *   - the Outlet Code must resolve (case-insensitively) to an outlet — of THIS tenant for 194R;
   *     for 194C (platform-wide) of the row's "Client" when given, else of the single tenant that
   *     has that code — an ambiguous code asks for the Client column; unknown → per-row error;
   *   - when the outlet's owner HAS a PAN on file, the row is kept and flagged in `warnings`
   *     ("PAN found on file for outlet X — counted under that PAN").
   * Rejected rows are removed and counted as failed. PAN rows pass through untouched (no query).
   */
  private async validateNoPanUploadRows<
    R extends { panNumber: string; outletCode: string | null; clientSlug?: string | null },
  >(
    rows: R[],
    result: UploadResult,
    scope: { clientId: string | null; section: '194R' | '194C' },
  ): Promise<Array<R & { resolvedClientId?: string }>> {
    const noPan = rows.filter((r) => r.panNumber === NO_PAN_KEY);
    if (noPan.length === 0) return rows;
    const tenant = scope.section === '194R' ? scope.clientId : null;
    const byCode = await this.outletsByCodeCI(noPan.map((r) => r.outletCode ?? ''), tenant);
    const ownerIds = [...new Set([...byCode.values()].flat().map((o) => o.partnerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length
      ? await this.prisma.channelPartner.findMany({ where: { id: { in: ownerIds } }, select: { id: true, panNumber: true } })
      : [];
    const ownerPan = new Map(owners.map((o) => [o.id, o.panNumber]));

    const out: Array<R & { resolvedClientId?: string }> = [];
    const warnings: UploadRowError[] = result.warnings ?? [];
    rows.forEach((r) => {
      if (r.panNumber !== NO_PAN_KEY) {
        out.push(r);
        return;
      }
      // Row number in the sheet: parsers keep file order; recover it from the row's position.
      const rowNum = this.sheetRowOf(r);
      const code = (r.outletCode ?? '').trim();
      let candidates = byCode.get(code.toUpperCase()) ?? [];
      if (scope.section === '194C' && r.clientSlug) {
        candidates = candidates.filter((c) => c.clientId.toLowerCase() === r.clientSlug!.toLowerCase());
      }
      const fail = (message: string) => {
        result.errors.push({ row: rowNum, message: `Row ${rowNum}: ${message}` });
        result.failed += 1;
        result.succeeded -= 1;
      };
      if (candidates.length === 0) {
        fail(
          scope.section === '194C' && r.clientSlug
            ? `Outlet Code "${code}" not found for client "${r.clientSlug}"`
            : `Outlet Code "${code}" not found${scope.section === '194R' ? ' in this client' : ''}`,
        );
        return;
      }
      if (candidates.length > 1) {
        fail(`Outlet Code "${code}" exists in more than one client — add the "Client" column (client slug) for this row`);
        return;
      }
      const o = candidates[0];
      const pan = o.partnerId ? ownerPan.get(o.partnerId) : null;
      if (pan && pan.trim() && !isNoPanKey(pan.trim().toUpperCase())) {
        warnings.push({ row: rowNum, message: `Row ${rowNum}: PAN found on file for outlet ${o.outletCode} — counted under that PAN` });
      }
      out.push(scope.section === '194C' ? { ...r, resolvedClientId: o.clientId } : r);
    });
    if (warnings.length) result.warnings = warnings;
    return out;
  }

  /** Sheet row number carried by the parsers on each accepted row (header = row 1). */
  private sheetRowOf(r: object): number {
    return (r as { rowNum?: number }).rowNum ?? 0;
  }

  // ─── 6.5c: Excel reference exports ──────────────────────────────────────────

  /**
   * Build the 194R reference Excel for a given clientId + FY.
   *
   * One row per PAN. Name resolution (CA-ready, mirroring 26Q deductee sheet):
   *   - On-platform PAN → ChannelPartner (clientId-scoped) → ownerName or businessName
   *   - per-deductee no-PAN row → "<owner name> (NO PAN ON FILE)" + an Outlet Code column
   *     (the column appears only when such a row exists); unattributed '__NO_PAN__' → "NO PAN ON FILE"
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
      .filter((p) => !isNoPanKey(p));

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          where: {
            clientId,
            panNumber: { in: onPlatformPans },
            // isParent:false — REAL: a parent SHARES the group PAN with its children, so
            // without this it could win the PAN→name lookup and misattribute the payee name
            // (docs/plans/PARTNER-MULTI-OUTLET.md §9).
            isParent: false,
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

    // The Outlet Code identifier column appears ONLY when a per-deductee no-PAN row exists, so a
    // tenant with no no-PAN deductee gets the exact same workbook as before.
    const withOutletCol = rows.some((r) => r.noPanDeductee);
    const detailRows = rows.map((r, i) => {
      const hasPan = !isNoPanKey(r.panNumber);
      const tdsRatePct = hasPan ? 10 : 20;
      const deducteeName = hasPan ? (panToName.get(r.panNumber) ?? '') : noPanDeducteeName(r.noPanDeductee, r.unlinkedNoPanDeposit);

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        ...(withOutletCol ? { 'Outlet Code': cellSafe(r.noPanDeductee?.outletCodes.join(', ') ?? '') } : {}),
        Section: '194R',
        'Amount Paid (₹)': moneyCell(r.baseFyTotalPaise),
        'TDS Rate %': tdsRatePct,
        'TDS Amount (₹)': moneyCell(r.liabilityPaise),
        'Already Deposited (₹)': moneyCell(r.depositedPaise),
        'Outstanding (₹)': moneyCell(r.outstandingPaise),
        FY: fyLabel,
      };
    });

    // Summary sheet
    const totalBase = rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n);
    const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
    const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
    // Nets the "Earlier no-PAN deposits" row against the total (see summariseRows).
    const totalOutstanding = summariseRows(rows).totalOutstandingPaise;

    const summaryRows = [
      {
        'Field': 'Total Deductees',
        'Value': rows.length,
      },
      {
        'Field': 'Total Amount Paid (₹)',
        'Value': moneyCell(totalBase),
      },
      {
        'Field': 'Total TDS Amount (₹)',
        'Value': moneyCell(totalLiability),
      },
      {
        'Field': 'Total Already Deposited (₹)',
        'Value': moneyCell(totalDeposited),
      },
      {
        'Field': 'Total Outstanding (₹)',
        'Value': moneyCell(totalOutstanding),
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
   * Columns: S.No · Deductee Name · PAN · Entity Type · Section · Methodology
   *          · Amount Paid (₹) · TDS Rate % · TDS — With Threshold (₹)
   *          · TDS — No Threshold (₹) · Threshold Met (Y/N) · Already Deposited (₹)
   *          · TDS Withheld (Deduct) (₹) · TDS Recovered (Gross-Up) (₹)
   *          · Outstanding (₹) · FY
   *
   * The Methodology + Withheld/Recovered columns make the DEDUCT-vs-GROSS_UP split
   * CA-visible: DEDUCT PANs show withholding already collected (folded into
   * Outstanding); GROSS_UP PANs show the "in lieu of TDS" recovery (report-only,
   * NOT netted against liability). A second "Gross-Up Recovery by Tenant" sheet
   * carries the per-tenant recovery attribution.
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
      .filter((p) => !isNoPanKey(p));

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          // isParent:false — REAL: a parent shares the group PAN, so exclude it from the
          // PAN→name lookup to avoid misattributing the payee name (§9).
          where: { panNumber: { in: onPlatformPans }, isParent: false },
          select: { panNumber: true, ownerName: true, businessName: true },
        })
      : [];

    const panToName = new Map<string, string>();
    for (const p of partners) {
      if (p.panNumber && !panToName.has(p.panNumber)) {
        panToName.set(p.panNumber, p.ownerName || p.businessName || '');
      }
    }

    const withOutletCol = rows.some((r) => r.noPanDeductee);
    const detailRows = rows.map((r, i) => {
      const hasPan = !isNoPanKey(r.panNumber);

      // Rate display: 1 for INDIVIDUAL/HUF, 2 for others, 20 for no-PAN
      let tdsRatePct: number;
      if (!hasPan) {
        tdsRatePct = 20;
      } else if (r.entityType === 'INDIVIDUAL' || r.entityType === 'HUF') {
        tdsRatePct = 1;
      } else {
        tdsRatePct = 2;
      }

      const deducteeName = hasPan ? (panToName.get(r.panNumber) ?? '') : noPanDeducteeName(r.noPanDeductee, r.unlinkedNoPanDeposit);

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        ...(withOutletCol ? { 'Outlet Code': cellSafe(r.noPanDeductee?.outletCodes.join(', ') ?? '') } : {}),
        'Entity Type': cellSafe(r.entityType),
        Section: '194C',
        Methodology: cellSafe(r.methodology ?? ''),
        'Amount Paid (₹)': moneyCell(r.baseFyTotalPaise),
        'TDS Rate %': tdsRatePct,
        'TDS — With Threshold (₹)': moneyCell(r.liabilityPaise),
        'TDS — No Threshold (₹)': moneyCell(r.liabilityNoThresholdPaise),
        'Threshold Met (Y/N)': r.thresholdMet ? 'Y' : 'N',
        'Already Deposited (₹)': moneyCell(r.depositedPaise),
        'TDS Withheld (Deduct) (₹)': moneyCell(r.withheldPaise),
        'TDS Recovered (Gross-Up) (₹)': moneyCell(r.recoveredPaise),
        'Outstanding (₹)': moneyCell(r.outstandingPaise),
        FY: fyLabel,
      };
    });

    // Second sheet: the GROSS-UP per-tenant recovery attribution ("in lieu of TDS"),
    // flattened one row per (PAN, tenant). Report-only — never netted against liability.
    const recoveryRows = rows.flatMap((r) => {
      const hasPan = !isNoPanKey(r.panNumber);
      const deducteeName = hasPan ? (panToName.get(r.panNumber) ?? '') : noPanDeducteeName(r.noPanDeductee, r.unlinkedNoPanDeposit);
      return r.recoveryByTenant.map((rec) => ({
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        'Deductee Name': cellSafe(deducteeName),
        ...(withOutletCol ? { 'Outlet Code': cellSafe(r.noPanDeductee?.outletCodes.join(', ') ?? '') } : {}),
        'Recovered From (Client)': cellSafe(rec.clientId),
        'Recovery Amount (₹)': moneyCell(rec.tenantSharePaise),
        FY: fyLabel,
      }));
    });

    const buffer = buildXlsx([
      { name: 'TDS 194C Details', rows: detailRows },
      { name: 'Gross-Up Recovery by Tenant', rows: recoveryRows },
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
      noPanDeductee?: NoPanDeductee;
      unlinkedNoPanDeposit?: true;
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
      // 194C only — methodology-aware split (undefined for 194R):
      methodology?: TdsMethodologyLabel;
      withheldPaise?: string;
      recoveredPaise?: string;
      recoveryByTenant?: Array<{ clientId: string; tenantSharePaise: string }>;
    }>;
    totals: {
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
      // 194C only:
      withheldPaise?: string;
      recoveredPaise?: string;
    };
  }> {
    if (section === '194R') {
      const rows = await this.compute194R(clientId, fyLabel);
      const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
      const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
      const totalOutstanding = summariseRows(rows).totalOutstandingPaise;

      return {
        section: '194R',
        fyLabel,
        rows: rows.map((r) => ({
          panNumber: r.panNumber,
          ...(r.noPanDeductee ? { noPanDeductee: r.noPanDeductee } : {}),
          ...(r.unlinkedNoPanDeposit ? { unlinkedNoPanDeposit: true as const } : {}),
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
    const totalWithheld = rows.reduce((s, r) => s + r.withheldPaise, 0n);
    const totalRecovered = rows.reduce((s, r) => s + r.recoveredPaise, 0n);
    const totalOutstanding = summariseRows(rows).totalOutstandingPaise;

    return {
      section: '194C',
      fyLabel,
      rows: rows.map((r) => ({
        panNumber: r.panNumber,
        ...(r.noPanDeductee ? { noPanDeductee: r.noPanDeductee } : {}),
        ...(r.unlinkedNoPanDeposit ? { unlinkedNoPanDeposit: true as const } : {}),
        liabilityPaise: r.liabilityPaise.toString(),
        depositedPaise: r.depositedPaise.toString(),
        outstandingPaise: r.outstandingPaise.toString(),
        methodology: r.methodology,
        withheldPaise: r.withheldPaise.toString(),
        recoveredPaise: r.recoveredPaise.toString(),
        recoveryByTenant: r.recoveryByTenant.map((rec) => ({
          clientId: rec.clientId,
          tenantSharePaise: rec.tenantSharePaise.toString(),
        })),
      })),
      totals: {
        liabilityPaise: totalLiability.toString(),
        depositedPaise: totalDeposited.toString(),
        outstandingPaise: totalOutstanding.toString(),
        withheldPaise: totalWithheld.toString(),
        recoveredPaise: totalRecovered.toString(),
      },
    };
  }
}
