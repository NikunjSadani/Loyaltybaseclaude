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
 * Base + liability = the ONE shared definition in `tds-194r.shared.ts` (also used by the payout
 * engine): incentive + 194R-frozen visibility payouts (PAID by paidAt; PROCESSING by its bank file's
 * date), imported vendor incentive payouts from the tenant's `tdsImportedPayouts.countFrom` date
 * (read once per request, fails CLOSED), DELIVERED redemptions (cash vs gift/voucher by mode, by
 * deliveredAt) and TdsOffPlatformEntry (by entryDate). Threshold > ₹20,000 → TDS on the WHOLE year:
 * visibility on the client's CURRENT DEDUCT method → base × rate% (10% PAN / 20% no-PAN); everything else
 * → client-borne gross-up base × rate/(100−rate). Rates 10% PAN / 20% no-PAN (statutory config).
 * Deposited: SUM TdsDeposit (section=SEC_194R, clientId, panNumber) whose "TDS for month"
 * (forPeriod) is in the FY — a deposit counts for the FY of the MONTH IT PAYS FOR, not its deposit date.
 * Outstanding = liability − deposited (TDS deducted from payouts is shown, never subtracted).
 *
 * ── 194C (platform-wide, per FY) ────────────────────────────────────────────
 * Sources summed per PAN:
 *   Visibility CreditPayoutEntry (isSeparatePayout=true field, status PAID, paidAt in FY)
 *   → PAN via Outlet→ChannelPartner; entityType too.
 * Threshold: maxSingle > 3,000,000 paise OR fyTotal > 10,000,000 paise.
 * Two columns: (a) with-threshold, (b) no-threshold (TDS on everything).
 * Deposited: SUM TdsDeposit (section=SEC_194C, panNumber) by "TDS for month" FY — platform-wide.
 */

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  fyFromLabel,
  fyLabelForPeriod,
  periodWindowForFy,
  grossUpTdsPaise,
  rate194CFrom,
  sectionParamToEnum,
  effectiveEntrySection,
  parseOffPlatformUpload,
  parseDepositUpload,
  buildOffPlatformTemplate,
  buildDepositTemplate,
  offPlatformFileHash,
  depositFileHash,
  depositPeriodOf,
  formatForPeriod,
  cellSafe,
  TDS_IMPORTED_PAYOUTS_SETTING_KEY,
  parseImportedPayoutsSetting,
  importedCountFromForFy,
  importedPayoutsNote,
  capUploadResult,
} from './tds.helpers';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import {
  NO_PAN_KEY,
  noPanOutletKey,
  isNoPanKey,
  isNoPanCell,
  collect194RBases,
  liability194R,
  emptyBases194R,
  outletsByCodeCI as sharedOutletsByCodeCI,
  ownerPansOf as sharedOwnerPansOf,
  keyForOutletCode,
  normalisePan,
  deducted194RByRetailer,
  openCredits194RUsability,
  type Reversed194RItem,
  type Bases194R,
} from './tds-194r.shared';
import type { TdsMethodology } from '@prisma/client';
import { withholdingTdsPaise } from './tds-methodology.helper';
import type { UploadResult, UploadRowError } from './dto/tds.dto';
import { buildXlsx } from '../common/xlsx';
import { formatINR, paiseToRupees } from '../common/money';

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
// Defined once in tds-194r.shared (the engine + report share them); re-exported for existing importers.
export { noPanPartnerKey, noPanOutletKey, isNoPanKey } from './tds-194r.shared';

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

/** First instant of the month after a "YYYY-MM" period, IST (00:00 IST = previous day 18:30 UTC). */
function nextMonthStartIst(period: string): Date {
  const [y, m] = period.split('-').map((s) => parseInt(s, 10));
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - (5 * 60 + 30) * 60 * 1000);
}

/** "16 Nov 2026" (IST). */
function istDay(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/** Fix round B: the row flag + plain-words notes for payouts reversed off a row's base (D1 / M2 / D3). */
function buildRowReversal(
  items: TdsRowReversal['items'],
  fyLabel: string,
  belowThresholdAfterReversal: boolean,
  extra: string[],
): TdsRowReversal {
  const sorted = [...items].sort((a, b) => a.reversedAt.getTime() - b.reversedAt.getTime());
  const notes = sorted.slice(0, 5).map((i) => `${formatINR(i.amountPaise)} reversed on ${istDay(i.reversedAt)} (payout ${i.period}, outlet ${i.outletCode})`);
  if (sorted.length > 5) notes.push(`…and ${sorted.length - 5} more reversed payouts`);
  if (belowThresholdAfterReversal) notes.push(`PAN below threshold after reversal — no TDS due for FY ${fyLabel} on what remains`);
  const retro = sorted.filter((i) => i.retroactive);
  if (retro.length > 0) {
    notes.push(`Changed after reversal on ${istDay(retro[retro.length - 1].reversedAt)} — revise return if already filed`);
  }
  notes.push(...extra);
  return {
    reversedPaise: items.reduce((s, i) => s + i.amountPaise, 0n),
    items: sorted,
    belowThresholdAfterReversal,
    notes,
  };
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

/**
 * Owner 2026-11-18 (explicit choice): TDS taken FROM THE RETAILER beyond the RETAILER'S share — the whole-year
 * deduct part on the client's CURRENT method — flag only, no refund. So a DEDUCT → GROSS_UP switch after TDS
 * was taken IS flagged (on Gross-up the retailer's share is ₹0; the client bears the liability).
 */
function excessOf(retailerDeductPart: bigint, deducted: bigint): bigint {
  return deducted > retailerDeductPart ? deducted - retailerDeductPart : 0n;
}

/** A recorded carry-forward that the current rules no longer ask to withhold (shown as dropped). */
function droppedOf(lastCarry: bigint, deductPart: bigint, deducted: bigint): bigint {
  const stillToWithhold = deductPart > deducted ? deductPart - deducted : 0n;
  return lastCarry > stillToWithhold ? lastCarry - stillToWithhold : 0n;
}

/**
 * True for a TdsDeposit uploadBatchId written by a DATA IMPORT (e.g. the Bajaj vendor-TDS batch)
 * rather than a portal upload — portal uploads store a deterministic file hash `DEP-<sha256>` /
 * `OP-<sha256>`. Informational only ("of which imported vendor TDS"); never changes an amount.
 */
export function isImportedDepositBatch(uploadBatchId: string | null | undefined): boolean {
  // Portal uploads: `DEP-`/`OP-` + a sha256 file hash, or + a uuid (uploads of 2026-06-18..21).
  return !!uploadBatchId && !/^(DEP|OP)-([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(uploadBatchId);
}

/**
 * Collects the "TDS for month" of the deposits counted on each report row. `fieldFor` returns
 * `{ depositForPeriods }` (sorted, de-duplicated) — or nothing for a row with no dated deposit, so a
 * row without deposits is shaped exactly as before.
 */
class DepositPeriods {
  private readonly byKey = new Map<string, Set<string>>();
  note(key: string, period: string | null): void {
    if (!period) return;
    const set = this.byKey.get(key) ?? new Set<string>();
    set.add(period);
    this.byKey.set(key, set);
  }
  fieldFor(key: string): { depositForPeriods?: string[] } {
    const set = this.byKey.get(key);
    return set && set.size ? { depositForPeriods: [...set].sort() } : {};
  }
}

/**
 * A multi-outlet export cell: values ", "-joined POSITIONALLY (aligned 1:1 with the Outlet Code
 * cell, so a blank stays a blank slot); all-blank → an empty cell.
 */
function alignedCell(values: string[]): string {
  return values.some((v) => v) ? values.join(', ') : '';
}

/** Export cell for a row's deposit months, e.g. "Mar-2026, Apr-2026" (blank when none). */
function depositMonthsCell(periods: string[] | undefined): string {
  return (periods ?? []).map(formatForPeriod).join(', ');
}

/** Identity of a per-deductee no-PAN row (absent on PAN rows and on the unattributed bucket). */
export interface NoPanDeductee {
  partnerId: string | null;
  clientId: string | null;
  /** Owner name (else business name) of the partner, or the outlet name for an owner-less outlet. */
  name: string;
  outletCodes: string[];
}

/**
 * Fix round B (owner D1 / D3 / M2, 2026-11-16) — the PAID payouts an engine reversal took off this row's yearly base.
 * Present ONLY on rows that had such a reversal (every other row — and every LEGACY tenant — is byte-identical).
 */
export interface TdsRowReversal {
  reversedPaise: bigint;
  items: Array<{ amountPaise: bigint; reversedAt: Date; period: string; outletCode: string; clientId: string; retroactive: boolean }>;
  /** The base was above the threshold with the reversed payouts and is not any more. */
  belowThresholdAfterReversal: boolean;
  /** Plain-words call-outs: "₹X reversed on <date>", "PAN below threshold after reversal", M2 revise-return flag, D3. */
  notes: string[];
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
  // ── Owner D10 (2026-11-18): how the liability was worked out (tds-194r.shared liability194R) ──
  /** The client's CURRENT methodology the whole year was computed on. */
  methodology: TdsMethodology;
  /** Whole-percent rate applied (10 with PAN / 20 without). */
  ratePct: number;
  /** Cash benefits: visibility + incentive payouts + cash (UPI/bank) redemptions. */
  cashBasePaise: bigint;
  /** Non-cash benefits: gifts, vouchers, off-platform. */
  nonCashBasePaise: bigint;
  /** Base on which TDS is withheld from the retailer (visibility payouts on DEDUCT, PAN or no-PAN). */
  deductBasePaise: bigint;
  /** Base whose TDS the client bears (gross-up). */
  clientBorneBasePaise: bigint;
  deductLiabilityPaise: bigint;
  clientBorneLiabilityPaise: bigint;
  /** TDS already deducted from this retailer's payouts (net of reversals) — shown, NOT subtracted. */
  deductedPaise: bigint;
  /** Of `depositedPaise`, the part from imported vendor TDS batches (informational). */
  importedVendorDepositPaise: bigint;
  /**
   * Owner 2026-11-18 — over-withholding is ONLY FLAGGED: TDS taken from this retailer beyond the retailer's
   * whole-year deduct part on the client's current method (e.g. DEDUCT → GROSS_UP after TDS was taken, or the
   * year later drops to ₹20,000 or less). No automatic refund.
   */
  excessDeductedPaise: bigint;
  /** WRE: USABLE open 194R TDS credit for this retailer this FY (absent when none) — subtracted before the excess test. */
  openTdsCreditPaise?: bigint;
  /** Re-audit A1: open credit that can never be used (closed FY / gross-up / PAN changed) — stays counted as excess. */
  unusableTdsCreditPaise?: bigint;
  unusableTdsCreditReasons?: string[];
  /** A carry-forward recorded on the ledger that is no longer due under the current rules (dropped, shown). */
  carryForwardDroppedPaise: bigint;
  /** B-M2 / excess: a plain-language flag for a row that needs a look. */
  note?: string;
  /** "TDS for month" (YYYY-MM, ascending) of the deposits counted on this row — absent when none. */
  depositForPeriods?: string[];
  /** Fix round B: payouts reversed off this row's base (absent when none). */
  reversal?: TdsRowReversal;
}

/**
 * DISPLAY-ONLY side channel of compute194R: row key (TdsRow194R.panNumber) → the outlet codes whose
 * payouts make up that row's base. Kept OFF the row type so the rows every other consumer reads
 * (on-screen report, liability, finance dashboard) stay byte-identical.
 */
export type ContributingOutlets194R = Map<string, Set<string>>;

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
  /** See TdsRow194R.depositForPeriods. */
  depositForPeriods?: string[];
}

export interface TdsSummary194R {
  fyLabel: string;
  clientId: string;
  /** Owner 2026-11-18: Σ TDS taken in excess (flag only) + how many retailers have any. */
  totalExcessDeductedPaise?: bigint;
  excessRetailerCount?: number;
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
    // D6: the 194R report computes the whole year on the client's CURRENT methodology.
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ─── Imported (vendor) payouts setting ──────────────────────────────────────

  /**
   * The tenant's "count imported (VENDOR_IMPORT) payouts in the 194R report from" date
   * ('YYYY-MM-DD', IST day), or null when OFF. ONE uncached ProgramSetting read
   * (`tdsImportedPayouts` = { countFrom }). Absent row / explicit null → null (OFF, the default).
   *
   * FAIL CLOSED: a failed read or a malformed stored value THROWS (a visible 500) — a statutory
   * report must never silently drop to OFF and under-state liability. Callers read this ONCE per
   * request and pass it into compute194R (see report194R).
   */
  async importedPayoutsCountFrom(clientId: string): Promise<string | null> {
    let raw: unknown;
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: TDS_IMPORTED_PAYOUTS_SETTING_KEY } },
        select: { settingValue: true },
      });
      raw = row?.settingValue ?? null;
    } catch (e) {
      this.logger.error(`${TDS_IMPORTED_PAYOUTS_SETTING_KEY} read failed for ${clientId}: ${e}`);
      throw new InternalServerErrorException(
        'Could not read the imported-payouts TDS setting — the 194R report was not produced. Please retry.',
      );
    }
    const { countFrom, malformed } = parseImportedPayoutsSetting(raw);
    if (malformed) {
      this.logger.error(`${TDS_IMPORTED_PAYOUTS_SETTING_KEY} for ${clientId} is malformed`);
      throw new InternalServerErrorException(
        'The imported-payouts TDS setting for this client is invalid — re-save it on the TDS Treatment screen. The 194R report was not produced.',
      );
    }
    return countFrom;
  }

  /**
   * EDITOR read of the setting (GET /v1/admin/tds/config/imported-payouts only): unlike
   * importedPayoutsCountFrom, a MALFORMED stored value does NOT throw — it is returned flagged
   * ({ countFrom: null, malformed: true, raw }) so the TDS Treatment card can open and repair it.
   * A failed READ still throws (nothing to show). The REPORT paths stay fail-closed.
   */
  async importedPayoutsSettingForEdit(
    clientId: string,
  ): Promise<{ countFrom: string | null; malformed: boolean; raw?: unknown }> {
    let raw: unknown;
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: TDS_IMPORTED_PAYOUTS_SETTING_KEY } },
        select: { settingValue: true },
      });
      raw = row?.settingValue ?? null;
    } catch (e) {
      this.logger.error(`${TDS_IMPORTED_PAYOUTS_SETTING_KEY} read failed for ${clientId}: ${e}`);
      throw new InternalServerErrorException('Could not read the imported-payouts TDS setting. Please retry.');
    }
    const { countFrom, malformed } = parseImportedPayoutsSetting(raw);
    return malformed ? { countFrom: null, malformed: true, raw } : { countFrom, malformed: false };
  }

  /** True when a tenant (Client row, id = slug) exists — used to 404 config reads/writes for unknown tenants. */
  async clientExists(clientId: string): Promise<boolean> {
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    return !!c;
  }

  /**
   * 194R rows + summary + the imported-payouts disclosure for ONE request — the setting is read
   * exactly once and passed into compute194R (rows computed once; summary derived from them).
   * `importedPayoutsCountedFrom` is non-null only when the date reaches into THIS FY.
   */
  async report194R(
    clientId: string,
    fyLabel: string,
    /** DISPLAY-ONLY sink, passed through to compute194R (see there). Only export194R supplies it. */
    contributingOutlets?: ContributingOutlets194R,
  ): Promise<{
    rows: TdsRow194R[];
    summary: TdsSummary194R;
    importedPayoutsCountedFrom: string | null;
    importedPayoutsNote: string | null;
  }> {
    const countFrom = await this.importedPayoutsCountFrom(clientId);
    const rows = await this.compute194R(clientId, fyLabel, countFrom, contributingOutlets);
    const disclosed = importedCountFromForFy(countFrom, fyLabel);
    return {
      rows,
      summary: {
        fyLabel,
        clientId,
        ...summariseRows(rows),
        totalExcessDeductedPaise: rows.reduce((s, r) => s + r.excessDeductedPaise, 0n),
        excessRetailerCount: rows.filter((r) => r.excessDeductedPaise > 0n).length,
      },
      importedPayoutsCountedFrom: disclosed,
      importedPayoutsNote: disclosed ? importedPayoutsNote(disclosed) : null,
    };
  }

  // ─── 194R ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194R rows for a given clientId and FY label (e.g. "2025-26"), per (client, retailer).
   * The base + liability come from the ONE shared definition (`tds-194r.shared`: collect194RBases +
   * liability194R) that the payout engine also uses — owner decisions 2026-11-18 (D2–D6, D9, D10).
   * Outstanding = liability − deposits uploaded in the portal (Q3; deductions do NOT reduce it).
   */
  async compute194R(
    clientId: string,
    fyLabel: string,
    /** The tenant's imported-payouts countFrom, already read for this request (undefined → read it here). */
    importedCountFrom?: string | null,
    /**
     * DISPLAY-ONLY sink (export194R's Outlet columns): when given, every outlet code whose payout
     * forms a row's base is recorded under that row's key — on-platform CreditPayoutEntry rows
     * (incl. imported VENDOR_IMPORT ones when counted) and off-platform entries carrying an Outlet
     * Code. Deposits and redemptions add nothing. It never changes a row, an amount or a query —
     * the returned rows are byte-identical with or without it.
     */
    contributingOutlets?: ContributingOutlets194R,
  ): Promise<TdsRow194R[]> {
    const noteOutlet = (key: string, code: string | null | undefined) => {
      const c = code?.trim();
      if (!contributingOutlets || !c) return;
      const set = contributingOutlets.get(key) ?? new Set<string>();
      set.add(c);
      contributingOutlets.set(key, set);
    };
    const countFromDate =
      importedCountFrom !== undefined ? importedCountFrom : await this.importedPayoutsCountFrom(clientId);
    const cfg = await this.statutory.getForFy(fyLabel);
    // D6: the client's CURRENT methodology (fail-closed on a malformed stored policy).
    const { methodology } = await this.tenantSettings.resolveTdsPolicy(clientId);

    // ── Base: the ONE shared definition (tds-194r.shared — also used by the payout engine) ──
    const reversed194R = new Map<string, Reversed194RItem[]>();
    const accum = await collect194RBases(this.prisma, {
      clientId,
      fyLabel,
      importedCountFrom: countFromDate,
      noteOutlet: contributingOutlets ? noteOutlet : undefined,
      // WRE D1: V2-reversed PAID payouts are off the base — collected here for the row call-outs.
      reversedSink: (key, item) => {
        const list = reversed194R.get(key) ?? [];
        list.push(item);
        reversed194R.set(key, list);
      },
    });

    // ── Deposited: SUM TdsDeposit (section=SEC_194R, clientId, "TDS for month" in FY) ──
    // Q4: imported vendor TDS IS a deposit (subtracted once); rows from an import batch (any
    // uploadBatchId that is not a portal-upload file hash) are also shown "of which imported".
    const deposits = await this.depositsForFy('SEC_194R', fyLabel, clientId);
    const depCodes = deposits.filter((r) => !r.resolvedKey && isNoPanCell(r.panNumber) && r.outletCode?.trim()).map((r) => r.outletCode!.trim());
    const outletsByCode = await this.outletsByCodeCI(depCodes, clientId);
    const ownerPans = await this.ownerPansOf(outletsByCode);

    const deposited = new Map<string, bigint>();
    const importedDeposited = new Map<string, bigint>();
    const depositPeriods = new DepositPeriods();
    let unlinkedNoPanDepositPaise = 0n;
    // Deductees with a deposit FOR this FY but NO base this FY get ONE row (base 0, outstanding
    // −deposit) so the deposit never drops out of the rows or the totals.
    const depositOnlyPanKeys = new Set<string>();
    for (const d of deposits) {
      // A-H1: a 194R deposit keeps the retailer key AS OF its upload; a legacy row resolves now.
      const key =
        d.resolvedKey ??
        (!isNoPanCell(d.panNumber) ? normalisePan(d.panNumber) : keyForOutletCode(d.outletCode, outletsByCode, ownerPans));
      if (!key) {
        unlinkedNoPanDepositPaise += d.amountPaise;
        depositPeriods.note(UNLINKED_NO_PAN_DEPOSIT_KEY, d.period);
        continue;
      }
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
      if (isImportedDepositBatch(d.uploadBatchId)) {
        importedDeposited.set(key, (importedDeposited.get(key) ?? 0n) + d.amountPaise);
      }
      depositPeriods.note(key, d.period);
      if (!accum.has(key)) depositOnlyPanKeys.add(key);
    }

    // ── Deducted so far (display only — Q3: deductions never reduce the liability) ──
    // Follows the RETAILER through its outlets (A-M4) — the same function the engine nets with.
    const lastCarry = new Map<string, bigint>();
    const deducted = await deducted194RByRetailer(this.prisma, { clientId, fyLabel }, lastCarry);
    // WRE (merge decision A, 2026-11-19): an OPEN TDS credit is ledger TDS that belongs to REVERSED income — the
    // reversal turned it into a credit the next 194R withholding uses — so it is never also flagged as excess.
    // Applied credits are NOT subtracted: once applied, that TDS covers the later payout it reduced (it sits inside
    // the retailer's share). No credits (every tenant without V2 reversals) → empty map → excess unchanged.
    // Re-audit A1: only a USABLE open credit (current FY · DEDUCT now · the retailer's current payee key — exactly what
    // the payout run draws) is subtracted; an unusable one stays counted as excess (flag only) and is said on the row.
    const creditsByKey = await openCredits194RUsability(this.prisma, { clientId, fyLabel, methodology });
    const deductedNetOfCredits = (key: string): bigint => (deducted.get(key) ?? 0n) - (creditsByKey.get(key)?.usable ?? 0n);

    const rowFor = (key: string, b: Bases194R): TdsRow194R => {
      const l = liability194R(b, methodology, cfg);
      const depositedPaise = deposited.get(key) ?? 0n;
      return {
        panNumber: key,
        fyLabel,
        baseFyTotalPaise: l.totalBasePaise,
        liabilityPaise: l.liabilityPaise,
        depositedPaise,
        outstandingPaise: l.liabilityPaise - depositedPaise,
        methodology,
        ratePct: l.ratePct,
        cashBasePaise: l.cashBasePaise,
        nonCashBasePaise: l.nonCashBasePaise,
        deductBasePaise: l.deductBasePaise,
        clientBorneBasePaise: l.clientBorneBasePaise,
        deductLiabilityPaise: l.deductPartPaise,
        clientBorneLiabilityPaise: l.clientBornePartPaise,
        deductedPaise: deducted.get(key) ?? 0n,
        excessDeductedPaise: excessOf(l.deductPartPaise, deductedNetOfCredits(key)),
        carryForwardDroppedPaise: droppedOf(lastCarry.get(key) ?? 0n, l.deductPartPaise, deductedNetOfCredits(key)),
        ...(creditsByKey.has(key)
          ? {
              openTdsCreditPaise: creditsByKey.get(key)!.usable,
              ...(creditsByKey.get(key)!.unusable > 0n
                ? { unusableTdsCreditPaise: creditsByKey.get(key)!.unusable, unusableTdsCreditReasons: creditsByKey.get(key)!.reasons }
                : {}),
            }
          : {}),
        importedVendorDepositPaise: importedDeposited.get(key) ?? 0n,
        ...depositPeriods.fieldFor(key),
      };
    };

    // ── Build result rows ──
    const rows: TdsRow194R[] = [];
    for (const [key, b] of accum) rows.push(rowFor(key, b));
    for (const key of depositOnlyPanKeys) rows.push(rowFor(key, emptyBases194R(!isNoPanKey(key))));
    // B-M2: TDS withheld this FY for a retailer with NO benefit counted and NO deposit this FY still gets
    // its own row (base 0, "deducted so far") — never silently dropped from the report / export.
    for (const [key, amt] of deducted) {
      if (amt !== 0n && !accum.has(key) && !depositOnlyPanKeys.has(key)) {
        rows.push(rowFor(key, emptyBases194R(!isNoPanKey(key))));
      }
    }
    for (const r of rows) {
      const notes: string[] = [];
      if (r.baseFyTotalPaise === 0n && r.deductedPaise !== 0n) {
        notes.push(
          'TDS was withheld from this retailer this year but no benefit is counted this year (for example the payout was ' +
            'reversed or moved) — check before filing.',
        );
      }
      if (r.excessDeductedPaise > 0n) {
        notes.push(
          `TDS taken in excess: ${formatINR(r.excessDeductedPaise)} — more was withheld from this retailer than the ` +
            "retailer's share of the year's TDS on the current rules. Flagged only: no automatic refund.",
        );
      }
      // Audit A4 (no silent pass-through): an open TDS credit lowers the excess — say so with its amount.
      if (r.openTdsCreditPaise !== undefined && r.openTdsCreditPaise > 0n) {
        notes.push(
          `${formatINR(r.openTdsCreditPaise)} open TDS credit (TDS withheld on a reversed payout) — it is used against ` +
            "this retailer's next 194R withholding, so it is not counted as excess.",
        );
      }
      // Re-audit A1: a credit that can never be used is NOT subtracted — it stays in the excess, and the row says why.
      if (r.unusableTdsCreditPaise !== undefined && r.unusableTdsCreditPaise > 0n) {
        notes.push(
          `${formatINR(r.unusableTdsCreditPaise)} TDS credit can no longer be used (later-year reversal / method changed / ` +
            `PAN changed — here: ${(r.unusableTdsCreditReasons ?? []).join(', ')}) — counted as excess.`,
        );
      }
      if (r.carryForwardDroppedPaise > 0n) {
        notes.push(
          `A carry-forward of ${formatINR(r.carryForwardDroppedPaise)} is no longer due under the current rules and will not be withheld.`,
        );
      }
      if (notes.length) r.note = notes.join(' ');
    }
    if (unlinkedNoPanDepositPaise > 0n) {
      rows.push({
        ...rowFor(UNLINKED_NO_PAN_DEPOSIT_KEY, emptyBases194R(false)),
        depositedPaise: unlinkedNoPanDepositPaise,
        outstandingPaise: -unlinkedNoPanDepositPaise,
        unlinkedNoPanDeposit: true as const,
        ...depositPeriods.fieldFor(UNLINKED_NO_PAN_DEPOSIT_KEY),
      });
    }
    // Fix round B (D1/M2): payouts an engine reversal took off a row's base — flag the row (a PAN whose whole base was
    // reversed still gets a base-0 row so the reversal is never silent). No reversals → no change.
    // The very items the shared definition left out of the base (reversedSink) — the engine uses the same split.
    // Re-audit A5: per retailer, the ledger TDS of its reversed payouts minus the credits created for them (no
    // reversed payouts → no query).
    const retainedNoCredit = new Map<string, bigint>();
    const reversedIds = [...reversed194R.values()].flat().map((i) => i.entryId);
    if (reversedIds.length > 0) {
      const keyOfEntry = new Map<string, string>();
      for (const [k, items] of reversed194R) for (const i of items) keyOfEntry.set(i.entryId, k);
      const [ledgerRows, creditRows] = await Promise.all([
        this.prisma.tdsDeductionEntry.findMany({
          where: { clientId, section: 'SEC_194R', creditPayoutEntryId: { in: reversedIds } },
          select: { creditPayoutEntryId: true, tdsDeductedThisPaise: true },
        }),
        this.prisma.tdsCredit.findMany({
          where: { clientId, section: 'SEC_194R', sourcePayoutEntryId: { in: reversedIds } },
          select: { sourcePayoutEntryId: true, amountPaise: true },
        }),
      ]);
      for (const l of ledgerRows ?? []) {
        const k = l.creditPayoutEntryId ? keyOfEntry.get(l.creditPayoutEntryId) : undefined;
        if (k) retainedNoCredit.set(k, (retainedNoCredit.get(k) ?? 0n) + l.tdsDeductedThisPaise);
      }
      for (const c of creditRows ?? []) {
        const k = keyOfEntry.get(c.sourcePayoutEntryId);
        if (k) retainedNoCredit.set(k, (retainedNoCredit.get(k) ?? 0n) - c.amountPaise);
      }
    }
    for (const [key, items] of reversed194R) {
      let row = rows.find((r) => r.panNumber === key);
      if (!row) {
        row = rowFor(key, emptyBases194R(items[0]?.hasPan ?? !isNoPanKey(key)));
        rows.push(row);
      }
      const reversedPaise = items.reduce((s, i) => s + i.amountPaise, 0n);
      const before = row.baseFyTotalPaise + reversedPaise > cfg.thr194rFyPaise;
      const after = row.baseFyTotalPaise > cfg.thr194rFyPaise;
      const open = row.openTdsCreditPaise ?? 0n;
      const kept = retainedNoCredit.get(key) ?? 0n;
      row.reversal = buildRowReversal(
        items.map((i) => ({
          amountPaise: i.amountPaise,
          reversedAt: i.reversedAt,
          period: i.period,
          outletCode: i.outletCode,
          clientId,
          // M2: reversed after the payout's month closed → that month's TDS return may already be filed.
          retroactive: i.reversedAt >= nextMonthStartIst(i.period),
        })),
        fyLabel,
        before && !after,
        [
          ...(open > 0n
            ? [`${formatINR(open)} TDS credit open for this retailer (FY ${fyLabel}) — used against the next 194R withholding; not flagged as excess`]
            : []),
          // Re-audit A5: TDS withheld on the reversed payout(s) that did NOT become a credit (gross-up / closed FY / PAN
          // changed at the time) stays in this year's ledger — never silently: it nets against a later 194R
          // withholding of this FY (already inside "deducted so far"), else it is the flagged excess above.
          ...(kept > 0n
            ? [
                `${formatINR(kept)} TDS withheld on the reversed payout(s) was kept in FY ${fyLabel}'s ledger without a credit — ` +
                  (methodology === 'DEDUCT'
                    ? "it nets against this retailer's later 194R withholding this FY (counted in 'deducted so far'); any part not needed is flagged as excess"
                    : 'counted as TDS taken in excess while the method is gross-up; if the programme switches back to deduct this FY, it nets against the next withholding'),
              ]
            : []),
        ],
      );
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
   * Upper-cased PAN → the entity type (INDIVIDUAL / HUF / COMPANY …) of a non-parent ChannelPartner
   * holding it, platform-wide (case-insensitive PAN match). When several partners share the PAN the
   * oldest-id one with an entity type wins (deterministic). No query for an empty list.
   */
  private async entityTypesByPan(pans: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(pans.map((p) => p.trim().toUpperCase()).filter(Boolean))];
    if (!uniq.length) return out;
    const partners = await this.prisma.channelPartner.findMany({
      where: {
        isParent: false,
        entityType: { not: null },
        OR: uniq.map((p) => ({ panNumber: { equals: p, mode: 'insensitive' as const } })),
      },
      select: { panNumber: true, entityType: true },
      orderBy: { id: 'asc' },
    });
    for (const p of partners) {
      const k = p.panNumber?.trim().toUpperCase();
      if (k && uniq.includes(k) && p.entityType && !out.has(k)) out.set(k, String(p.entityType));
    }
    return out;
  }

  /**
   * TdsDeposit rows that belong to `fyLabel` — assigned by the FY of the MONTH EACH DEPOSIT PAYS FOR
   * ("TDS for month", `forPeriod`), NOT the FY of its deposit date: March TDS deposited on 7 April
   * counts against the March FY. A row with no forPeriod (written by an older build) gets the
   * default rule (defaultDepositForPeriod), which only ever moves a deposit EARLIER (≤ 30 April of
   * the next FY), so the fallback window is [FY start, FY end + 30 days) re-checked in code.
   * `clientId` scopes 194R; omitted for 194C (platform-wide). Each row carries its `period`.
   */
  private async depositsForFy(
    section: 'SEC_194R' | 'SEC_194C',
    fyLabel: string,
    clientId?: string,
  ): Promise<
    Array<{ panNumber: string; amountPaise: bigint; outletCode: string | null; clientId: string | null; period: string | null; uploadBatchId: string | null; resolvedKey: string | null }>
  > {
    const { startPeriod, endPeriod } = periodWindowForFy(fyLabel);
    const { start, endExclusive } = fyFromLabel(fyLabel);
    const fallbackEnd = new Date(endExclusive.getTime() + 30 * 24 * 60 * 60 * 1000);
    const found = await this.prisma.tdsDeposit.findMany({
      where: {
        section,
        ...(clientId !== undefined ? { clientId } : {}),
        OR: [
          { forPeriod: { gte: startPeriod, lte: endPeriod } },
          { forPeriod: null, depositDate: { gte: start, lt: fallbackEnd } },
        ],
      },
      select: { panNumber: true, amountPaise: true, outletCode: true, clientId: true, forPeriod: true, depositDate: true, uploadBatchId: true, resolvedKey: true },
    });
    const out: Array<{ panNumber: string; amountPaise: bigint; outletCode: string | null; clientId: string | null; period: string | null; uploadBatchId: string | null; resolvedKey: string | null }> = [];
    for (const d of found) {
      const period = depositPeriodOf(d);
      // period null only when neither column is present (not possible for a stored row) → trust the query.
      if (period !== null && fyLabelForPeriod(period) !== fyLabel) continue;
      out.push({
        panNumber: d.panNumber,
        amountPaise: d.amountPaise,
        outletCode: d.outletCode ?? null,
        clientId: d.clientId ?? null,
        period,
        uploadBatchId: d.uploadBatchId ?? null,
        resolvedKey: d.resolvedKey ?? null,
      });
    }
    return out;
  }

  /**
   * owner partnerId → its PAN, for owners of the given outlets that have a REAL PAN on file
   * (blank / `__NO_PAN__` excluded). No query when there are no owners.
   */
  /** owner partnerId → its REAL PAN, for owners of the given outlets (shared helper). */
  private async ownerPansOf(
    outletsByCode: Map<string, Array<{ partnerId: string | null }>>,
  ): Promise<Map<string, string>> {
    return sharedOwnerPansOf(this.prisma, outletsByCode);
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
    // Deposits are anchored by THEIR "TDS for month" (forPeriod) FY too — see depositsForFy.

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

    // ── Deposited: SUM TdsDeposit (section=SEC_194C, "TDS for month" in FY) — platform-wide ──
    const deposits = await this.depositsForFy('SEC_194C', fyLabel);

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
    const depositPeriods = new DepositPeriods();
    let unlinkedNoPanDepositPaise = 0n;
    // Deductees with a deposit FOR this FY but NO base this FY — direct PAN deposits, no-PAN-marker
    // deposits attributed to an owner PAN, and ones attributed to a known no-PAN outlet alike (see
    // 194R). One row each (built below with every other base-less key), never a duplicate.
    const depositOnlyPanKeys = new Set<string>();
    for (const d of deposits) {
      let key: string | null = null;
      if (!isNoPanCell(d.panNumber)) {
        key = d.panNumber.trim().toUpperCase();
      } else {
        const oc = d.outletCode?.trim();
        const candidates = oc ? (outletsByCode.get(oc.toUpperCase()) ?? []) : [];
        const scoped = d.clientId ? candidates.filter((c) => c.clientId === d.clientId) : candidates;
        if (scoped.length === 1) {
          const o = scoped[0];
          key = (o.partnerId ? ownerPans194C.get(o.partnerId) : undefined) ?? noPanOutletKey(o.clientId, o.outletCode);
        }
      }
      if (!key) {
        unlinkedNoPanDepositPaise += d.amountPaise;
        depositPeriods.note(UNLINKED_NO_PAN_DEPOSIT_KEY, d.period);
        continue;
      }
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
      depositPeriods.note(key, d.period);
      if (!accum.has(key)) depositOnlyPanKeys.add(key);
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
    /** Per-tenant recovery split for a key, largest share first. */
    const sortedRecoveryList = (key: string): TdsRecoveryAttribution[] => {
      const tenantMap = recoveryByTenant.get(key);
      return tenantMap
        ? [...tenantMap.entries()]
            .map(([clientId, tenantSharePaise]) => ({ clientId, tenantSharePaise }))
            .sort((x, y) =>
              y.tenantSharePaise > x.tenantSharePaise ? 1 : y.tenantSharePaise < x.tenantSharePaise ? -1 : 0,
            )
        : [];
    };

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

      const recoveryList = sortedRecoveryList(key);

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
        ...depositPeriods.fieldFor(key),
      });
    }
    // ── Base-less deductees: no base this FY, but a deposit FOR this FY, a DEDUCT withholding, or a
    // (no-PAN) recovery. Each key gets exactly ONE row (base 0, outstanding = −deposit − withheld)
    // so no amount ever drops out of the rows or the totals:
    //   - deposit-only keys (real PAN, owner PAN of a no-PAN deposit, or a known no-PAN outlet);
    //   - WITHHELD-only keys — real PANs AND no-PAN keys alike (FIX B: a real PAN's withholding used
    //     to appear only when it also had a deposit);
    //   - recovery (report-only, outstanding unaffected): carried on any base-less row of the same
    //     key; a no-PAN key with nothing but a recovery keeps its own row whenever a no-PAN row with a
    //     base exists (unchanged rule).
    const baseLess = new Map<string, TdsRow194C>();
    const baseLessRow = (key: string): TdsRow194C => {
      let r = baseLess.get(key);
      if (!r) {
        r = {
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
          recoveredPaise: 0n,
          recoveryByTenant: [],
        };
        baseLess.set(key, r);
      }
      return r;
    };
    const withheldOnlyKeys = [...withheld.keys()].filter((k) => !accum.has(k));
    const anyNoPanBaseRow = rows.some((r) => isNoPanKey(r.panNumber));
    const hasBaseLessAmount = (key: string) => depositOnlyPanKeys.has(key) || withheldOnlyKeys.includes(key);
    for (const [key, rec] of recovered) {
      if (accum.has(key)) continue;
      if (!hasBaseLessAmount(key) && !(isNoPanKey(key) && anyNoPanBaseRow)) continue;
      const r = baseLessRow(key);
      r.recoveredPaise = rec;
      r.recoveryByTenant = sortedRecoveryList(key);
    }
    for (const key of withheldOnlyKeys) baseLessRow(key).withheldPaise = withheld.get(key) ?? 0n;
    for (const key of depositOnlyPanKeys) baseLessRow(key).depositedPaise = deposited.get(key) ?? 0n;
    // FIX D: a real PAN's base-less row carries that PAN's REAL entity type (it decides the 1% / 2%
    // rate shown in the export) — looked up only when such a row exists; unknown PAN → OTHERS.
    const entityTypes = await this.entityTypesByPan([...baseLess.keys()].filter((k) => !isNoPanKey(k)));
    for (const [key, r] of baseLess) {
      r.outstandingPaise = -r.depositedPaise - r.withheldPaise;
      if (!isNoPanKey(key)) r.entityType = entityTypes.get(key) ?? 'OTHERS';
      const periods = depositPeriods.fieldFor(key);
      if (periods.depositForPeriods) r.depositForPeriods = periods.depositForPeriods;
      rows.push(r);
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
        ...depositPeriods.fieldFor(UNLINKED_NO_PAN_DEPOSIT_KEY),
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
    return sharedOutletsByCodeCI(this.prisma, codes, clientId);
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
      return capUploadResult(result);
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
      // A-H1: store the 194R retailer key AS OF this upload (a later PAN change never moves the row).
      const keys = await this.resolvedKeys194R(clientId, toInsert);
      await this.prisma.tdsOffPlatformEntry.createMany({
        data: toInsert.map((r, i) => ({
          resolvedKey: keys[i],
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

    return capUploadResult(result);
  }

  /**
   * A-H1: the 194R retailer key of each upload row AS OF NOW (stored on the row): a PAN → its normalised
   * form; a no-PAN marker → its Outlet Code's owner key in this client (PAN on file → that PAN; else the
   * no-PAN owner / outlet key); unresolvable → null (the report then shows it as an unlinked deposit).
   */
  private async resolvedKeys194R(
    clientId: string,
    rows: Array<{ panNumber: string; outletCode?: string | null }>,
  ): Promise<Array<string | null>> {
    const codes = rows.filter((r) => isNoPanCell(r.panNumber) && r.outletCode?.trim()).map((r) => r.outletCode!.trim());
    const byCode = await this.outletsByCodeCI(codes, clientId);
    const ownerPans = await this.ownerPansOf(byCode);
    return rows.map((r) =>
      !isNoPanCell(r.panNumber) ? normalisePan(r.panNumber) : keyForOutletCode(r.outletCode, byCode, ownerPans),
    );
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
    const validated = await this.validateNoPanUploadRows(parsed.rows, result, { clientId, section });
    // Cross-upload duplicate check — runs on PREVIEW too, so what Apply will skip is visible first.
    const toInsert = await this.dropAlreadyUploadedDeposits(validated, result, section, clientId);

    if (!apply || toInsert.length === 0) {
      return capUploadResult(result);
    }

    const prismaSection = sectionParamToEnum(section);
    const depositorType = section === '194R' ? 'CLIENT' : 'GIFSY';
    // Hash of the whole (validated) file — the DB partial-unique index stays the race safety-net.
    const uploadBatchId = depositFileHash(validated);

    if (toInsert.length > 0) {
      // A-H1: a 194R deposit stores the retailer key AS OF this upload (194C keeps its own per-outlet rule).
      const keys = prismaSection === 'SEC_194R' && clientId ? await this.resolvedKeys194R(clientId, toInsert) : [];
      await this.prisma.tdsDeposit.createMany({
        data: toInsert.map((r, i) => ({
          ...(keys.length ? { resolvedKey: keys[i] } : {}),
          section: prismaSection,
          depositorType: depositorType as 'CLIENT' | 'GIFSY',
          // 194C (platform) rows keep clientId null, EXCEPT a no-PAN row: it records the tenant of
          // the outlet it was resolved to, so the deductee stays unambiguous later.
          clientId: (r as { resolvedClientId?: string }).resolvedClientId ?? clientId ?? undefined,
          depositDate: r.depositDate,
          panNumber: r.panNumber,
          outletCode: r.outletCode ?? undefined,
          amountPaise: r.amountPaise,
          forPeriod: r.forPeriod,
          uploadBatchId,
          uploadedBy,
        })),
        skipDuplicates: true,
      });
    }

    return capUploadResult(result);
  }

  /**
   * Cross-upload duplicate guard for deposits. A deposit is "the same deposit" when it matches an
   * already-stored one on (tenant, section, PAN / no-PAN marker, Outlet Code if any, deposit date,
   * amount) — REGARDLESS of which file/batch stored it or its "TDS for month" (there is no challan
   * number column to tell two such deposits apart). Per row:
   *   - same deposit, same TDS for month      → skipped ("duplicate entry — already uploaded");
   *   - same deposit, DIFFERENT TDS for month → row error (conflict; never a second deposit — a
   *     stored deposit cannot be edited, so re-uploading with a corrected month must not add one);
   *   - identical to an EARLIER row of this file (incl. the month) → skipped.
   * Matching is one-to-one: N stored copies absorb at most N incoming rows. 194R is scoped to the
   * tenant by the query; 194C compares the stored tenant (a no-PAN row records its outlet's tenant).
   * Counts in `result` are adjusted. Returns the rows still to insert.
   */
  private async dropAlreadyUploadedDeposits<
    R extends {
      panNumber: string;
      outletCode: string | null;
      depositDate: Date;
      amountPaise: bigint;
      forPeriod: string;
      resolvedClientId?: string;
    },
  >(rows: R[], result: UploadResult, section: '194R' | '194C', clientId: string | null): Promise<R[]> {
    if (rows.length === 0) return rows;
    const tenantOf = (cid: string | null | undefined) => (section === '194C' ? (cid ?? '') : '');
    const keyOf = (cid: string | null | undefined, pan: string, outlet: string | null | undefined, date: Date, amt: bigint) =>
      [tenantOf(cid), pan.trim().toUpperCase(), (outlet ?? '').trim().toUpperCase(), date.toISOString(), amt.toString()].join('|');

    const existing = await this.prisma.tdsDeposit.findMany({
      where: {
        section: sectionParamToEnum(section),
        ...(section === '194C' ? {} : { clientId: clientId ?? null }),
        panNumber: { in: [...new Set(rows.map((r) => r.panNumber))] },
        depositDate: { in: [...new Map(rows.map((r) => [r.depositDate.getTime(), r.depositDate])).values()] },
      },
      select: { clientId: true, panNumber: true, depositDate: true, amountPaise: true, outletCode: true, forPeriod: true },
    });
    // natural key → the TDS-for-month of each stored copy (consumed one-to-one below)
    const stored = new Map<string, string[]>();
    for (const e of existing) {
      const k = keyOf(e.clientId, e.panNumber, e.outletCode, e.depositDate, e.amountPaise);
      const list = stored.get(k) ?? [];
      list.push(depositPeriodOf(e) ?? '');
      stored.set(k, list);
    }

    const seenInFile = new Map<string, number>(); // key + month → first sheet row
    const out: R[] = [];
    rows.forEach((r, idx) => {
      const sheetRow = this.sheetRowOf(r) || idx + 2;
      const k = keyOf(r.resolvedClientId ?? clientId, r.panNumber, r.outletCode, r.depositDate, r.amountPaise);
      const list = stored.get(k);
      if (list && list.length) {
        const same = list.indexOf(r.forPeriod);
        if (same >= 0) {
          list.splice(same, 1);
          result.skipped += 1;
          result.succeeded -= 1;
          result.errors.push({
            row: sheetRow,
            message: `Row ${sheetRow}: skipped — duplicate entry (this deposit was already uploaded)`,
          });
        } else {
          const prev = list.shift()!;
          result.failed += 1;
          result.succeeded -= 1;
          result.errors.push({
            row: sheetRow,
            message: `Row ${sheetRow}: this deposit (same PAN, date and amount) was already uploaded with TDS for month ${prev ? formatForPeriod(prev) : '(none)'} — this row says ${formatForPeriod(r.forPeriod)}. Not added: an uploaded deposit cannot be changed or re-dated.`,
          });
        }
        return;
      }
      const fk = `${k}|${r.forPeriod}`;
      const first = seenInFile.get(fk);
      if (first !== undefined) {
        result.skipped += 1;
        result.succeeded -= 1;
        result.errors.push({
          row: sheetRow,
          message: `Row ${sheetRow}: skipped — duplicate entry (same as row ${first} of this file)`,
        });
        return;
      }
      seenInFile.set(fk, sheetRow);
      out.push(r);
    });
    return out;
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
   * DISPLAY-ONLY Outlet Code / Name / Type per 194R export row (see export194R for the rules).
   * Row key → outlets sorted by code. Batched, tenant-scoped lookups (no N+1):
   *   1. outlets by exact code (contributing codes + no-PAN deductee codes) — skipped when none;
   *   2. case-insensitive retry ONLY for codes not found exactly (an off-platform upload's code);
   *   3. PAN fallback: outlets of the non-parent partners holding the PAN — ONLY for PAN rows with
   *      no contributing outlet. `panPartners` = export194R's PAN→name lookup (clientId-scoped,
   *      isParent:false — a parent shares its group's PAN and owns no outlets).
   * A code with no outlet in this tenant is still shown (name/type blank) — it is what was paid.
   */
  private async outletColumns194R(
    clientId: string,
    rows: TdsRow194R[],
    contributing: ContributingOutlets194R,
    panPartners: Array<{ id?: string; panNumber: string | null }>,
  ): Promise<Map<string, Array<{ code: string; name: string; type: string }>>> {
    type OutletInfo = { code: string; name: string; type: string };
    const out = new Map<string, OutletInfo[]>();
    const toInfo = (o: { outletCode: string; name?: string | null; outletType?: { name?: string | null } | null }): OutletInfo => ({
      code: o.outletCode,
      name: o.name ?? '',
      type: o.outletType?.name ?? '',
    });
    const outletSelect = { outletCode: true, name: true, partnerId: true, outletType: { select: { name: true } } } as const;

    // Codes wanted per row (PAN rows: contributing; per-deductee no-PAN rows: their own codes).
    const codesByRow = new Map<string, string[]>();
    for (const r of rows) {
      if (r.unlinkedNoPanDeposit) continue;
      if (!isNoPanKey(r.panNumber)) {
        const set = contributing.get(r.panNumber);
        if (set?.size) codesByRow.set(r.panNumber, [...set]);
      } else if (r.noPanDeductee?.outletCodes.length) {
        codesByRow.set(r.panNumber, [...r.noPanDeductee.outletCodes]);
      }
    }

    // 1 + 2: resolve every wanted code within the tenant.
    const wanted = [...new Set([...codesByRow.values()].flat())];
    const byExact = new Map<string, OutletInfo>();
    if (wanted.length) {
      const found = await this.prisma.outlet.findMany({
        where: { clientId, outletCode: { in: wanted } },
        select: outletSelect,
      });
      for (const o of found) if (o.outletCode) byExact.set(o.outletCode, toInfo(o));
    }
    const missing = wanted.filter((c) => !byExact.has(c));
    const byUpper = new Map<string, OutletInfo[]>();
    if (missing.length) {
      const upper = [...new Set(missing.map((c) => c.toUpperCase()))];
      const found = await this.prisma.outlet.findMany({
        where: { clientId, OR: upper.map((c) => ({ outletCode: { equals: c, mode: 'insensitive' as const } })) },
        select: outletSelect,
      });
      for (const o of found) {
        if (!o.outletCode) continue;
        const k = o.outletCode.toUpperCase();
        const list = byUpper.get(k) ?? [];
        if (!list.some((x) => x.code === o.outletCode)) list.push(toInfo(o));
        byUpper.set(k, list);
      }
    }
    const resolve = (code: string): OutletInfo => {
      const exact = byExact.get(code);
      if (exact) return exact;
      const ci = byUpper.get(code.toUpperCase());
      return ci && ci.length === 1 ? ci[0] : { code, name: '', type: '' };
    };
    const finish = (list: OutletInfo[]): OutletInfo[] => {
      const byCode = new Map<string, OutletInfo>();
      for (const o of list) if (!byCode.has(o.code)) byCode.set(o.code, o);
      return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    };
    for (const [key, codes] of codesByRow) out.set(key, finish(codes.map(resolve)));

    // 3: PAN rows with no contributing outlet → the PAN holders' (non-parent) outlets.
    const fallbackPans = new Set(
      rows.filter((r) => !r.unlinkedNoPanDeposit && !isNoPanKey(r.panNumber) && !out.has(r.panNumber)).map((r) => r.panNumber),
    );
    const partnerIdsByPan = new Map<string, string[]>();
    for (const p of panPartners) {
      if (!p.id || !p.panNumber || !fallbackPans.has(p.panNumber)) continue;
      partnerIdsByPan.set(p.panNumber, [...(partnerIdsByPan.get(p.panNumber) ?? []), p.id]);
    }
    const fallbackIds = [...new Set([...partnerIdsByPan.values()].flat())];
    if (fallbackIds.length) {
      const owned = await this.prisma.outlet.findMany({
        where: { clientId, partnerId: { in: fallbackIds } },
        select: outletSelect,
      });
      const byPartner = new Map<string, OutletInfo[]>();
      for (const o of owned) {
        if (!o.partnerId || !o.outletCode) continue;
        byPartner.set(o.partnerId, [...(byPartner.get(o.partnerId) ?? []), toInfo(o)]);
      }
      for (const [pan, ids] of partnerIdsByPan) {
        const list = finish(ids.flatMap((id) => byPartner.get(id) ?? []));
        if (list.length) out.set(pan, list);
      }
    }
    return out;
  }

  /**
   * Build the 194R reference Excel for a given clientId + FY.
   *
   * One row per PAN. Name resolution (CA-ready, mirroring 26Q deductee sheet):
   *   - On-platform PAN → ChannelPartner (clientId-scoped) → ownerName or businessName
   *   - per-deductee no-PAN row → "<owner name> (NO PAN ON FILE)"; unattributed '__NO_PAN__' → "NO PAN ON FILE"
   *   - Unknown / off-platform PAN → blank name
   *
   * Outlet Code / Outlet Name / Outlet Type (DISPLAY ONLY — always present; owner-approved 2026-11-13):
   *   - PAN row → the outlets whose payouts make up that row's FY base (paid credits incl. counted
   *     imported vendor payouts, and off-platform entries carrying an Outlet Code; deposits and
   *     redemptions add none). None (e.g. an off-platform PAN-only entry, or redemptions only) →
   *     the outlets of this tenant's NON-PARENT partners holding the PAN; still none → blank.
   *   - per-deductee no-PAN row → that deductee's outlets (noPanDeductee.outletCodes, as before).
   *   - unattributed '__NO_PAN__' and "Earlier no-PAN deposits" rows → blank.
   *   Several outlets → ", "-joined, sorted by code; names and types in the SAME order as the codes.
   *   Type = the outlet type's name (blank when unknown). Nothing numeric is affected.
   *
   * Columns: S.No · Deductee Name · PAN · Outlet Code · Outlet Name · Outlet Type · Section
   *          · Amount Paid (₹) · Cash / Non-cash Benefits (₹) · Method · TDS Rate % · Base Deducted
   *          from Retailer / Borne by Client (₹) · TDS — Deducted / Client-borne Part (₹)
   *          · TDS Amount (₹) · Deducted from Payouts So Far (₹) · Already Deposited (₹)
   *          · of which Imported Vendor TDS (₹) · Deposits — TDS for Month(s) · Outstanding (₹) · FY
   *
   * A second "Summary" sheet provides totals.
   *
   * @returns { buffer: Buffer, filename: string }
   */
  async export194R(
    clientId: string,
    fyLabel: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const contributing: ContributingOutlets194R = new Map();
    const { rows, importedPayoutsNote: importedNote } = await this.report194R(clientId, fyLabel, contributing);

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
          select: { id: true, panNumber: true, ownerName: true, businessName: true },
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

    const outletCols = await this.outletColumns194R(clientId, rows, contributing, partners);
    // Audit A4: the "Open TDS Credit" column only when a row has one (an export without WRE credits is unchanged).
    const anyOpenCredit = rows.some((r) => r.openTdsCreditPaise !== undefined);
    const detailRows = rows.map((r, i) => {
      const hasPan = !isNoPanKey(r.panNumber);
      const deducteeName = hasPan ? (panToName.get(r.panNumber) ?? '') : noPanDeducteeName(r.noPanDeductee, r.unlinkedNoPanDeposit);
      const outlets = outletCols.get(r.panNumber) ?? [];

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        'Outlet Code': cellSafe(alignedCell(outlets.map((o) => o.code))),
        'Outlet Name': cellSafe(alignedCell(outlets.map((o) => o.name))),
        'Outlet Type': cellSafe(alignedCell(outlets.map((o) => o.type))),
        Section: '194R',
        'Amount Paid (₹)': moneyCell(r.baseFyTotalPaise),
        // D10: the base split + how the year's TDS was worked out.
        'Cash Benefits (₹)': moneyCell(r.cashBasePaise),
        'Non-cash Benefits (₹)': moneyCell(r.nonCashBasePaise),
        Method: r.methodology === 'DEDUCT' ? 'Deduct' : 'Gross-up',
        'TDS Rate %': r.ratePct,
        'Base Deducted from Retailer (₹)': moneyCell(r.deductBasePaise),
        'Base Borne by Client (₹)': moneyCell(r.clientBorneBasePaise),
        'TDS — Deducted Part (₹)': moneyCell(r.deductLiabilityPaise),
        'TDS — Client-borne Part (₹)': moneyCell(r.clientBorneLiabilityPaise),
        'TDS Amount (₹)': moneyCell(r.liabilityPaise),
        'Deducted from Payouts So Far (₹)': moneyCell(r.deductedPaise),
        // Owner 2026-11-18: over-withholding is flagged (no automatic refund).
        'TDS Taken in Excess (₹)': moneyCell(r.excessDeductedPaise),
        ...(anyOpenCredit ? { 'Open TDS Credit (₹)': moneyCell(r.openTdsCreditPaise ?? 0n) } : {}),
        'Already Deposited (₹)': moneyCell(r.depositedPaise),
        'of which Imported Vendor TDS (₹)': moneyCell(r.importedVendorDepositPaise),
        'Deposits — TDS for Month(s)': depositMonthsCell(r.depositForPeriods),
        'Outstanding (₹)': moneyCell(r.outstandingPaise),
        Note: cellSafe(r.note ?? ''),
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
      // Disclosure — only when the tenant counts imported (vendor) payouts in THIS FY (else the
      // workbook is unchanged).
      ...(importedNote
        ? [{ 'Field': 'Imported (vendor) payouts', 'Value': `${importedNote} — liability only, nothing was withheld` }]
        : []),
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
        'Deposits — TDS for Month(s)': depositMonthsCell(r.depositForPeriods),
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
    /** 194R only — present when imported (vendor) payouts are counted in THIS FY. */
    importedPayoutsCountedFrom?: string;
    importedPayoutsNote?: string;
    rows: Array<{
      panNumber: string;
      noPanDeductee?: NoPanDeductee;
      unlinkedNoPanDeposit?: true;
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
      depositForPeriods?: string[];
      // 194R only (L4 / owner 2026-11-18): deducted so far, TDS taken in excess (flag), the row note.
      deductedPaise?: string;
      excessDeductedPaise?: string;
      note?: string;
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
      // 194R only: Σ TDS taken in excess (flag only).
      excessDeductedPaise?: string;
    };
  }> {
    if (section === '194R') {
      const report = await this.report194R(clientId, fyLabel);
      const rows = report.rows;
      const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
      const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
      const totalOutstanding = report.summary.totalOutstandingPaise;

      return {
        section: '194R',
        fyLabel,
        ...(report.importedPayoutsCountedFrom && report.importedPayoutsNote
          ? {
              importedPayoutsCountedFrom: report.importedPayoutsCountedFrom,
              importedPayoutsNote: report.importedPayoutsNote,
            }
          : {}),
        rows: rows.map((r) => ({
          panNumber: r.panNumber,
          ...(r.noPanDeductee ? { noPanDeductee: r.noPanDeductee } : {}),
          ...(r.unlinkedNoPanDeposit ? { unlinkedNoPanDeposit: true as const } : {}),
          liabilityPaise: r.liabilityPaise.toString(),
          depositedPaise: r.depositedPaise.toString(),
          outstandingPaise: r.outstandingPaise.toString(),
          ...(r.depositForPeriods ? { depositForPeriods: r.depositForPeriods } : {}),
          deductedPaise: r.deductedPaise.toString(),
          excessDeductedPaise: r.excessDeductedPaise.toString(),
          ...(r.note ? { note: r.note } : {}),
        })),
        totals: {
          liabilityPaise: totalLiability.toString(),
          depositedPaise: totalDeposited.toString(),
          outstandingPaise: totalOutstanding.toString(),
          excessDeductedPaise: rows.reduce((s, r) => s + r.excessDeductedPaise, 0n).toString(),
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
        ...(r.depositForPeriods ? { depositForPeriods: r.depositForPeriods } : {}),
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
