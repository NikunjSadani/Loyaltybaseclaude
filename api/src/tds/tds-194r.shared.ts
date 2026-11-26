/**
 * 194R — the ONE shared definition of "what counts" and "how much is due", used by BOTH the payout
 * engine (credits.service buildPayoutTdsPlan → withholding on 194R visibility DEDUCT payouts) and the
 * 194R report (tds.service compute194R). Owner decisions 2026-11-18 (D2/D3/D4/D5/D6/D9 + Q1–Q6):
 *
 *  WHAT COUNTS (per client, per retailer, per FY — never across clients):
 *    - VISIBILITY payouts whose FROZEN section is 194R (Q6)                      → "vis" (cash)
 *    - INCENTIVE payouts (always 194R) + imported vendor incentive payouts paid
 *      on/after the client's `tdsImportedPayouts.countFrom` (D9)                → "cash" (client-borne)
 *    - DELIVERED redemptions: UPI / BANK_TRANSFER                                → "cash" (client-borne)
 *                             GIFT_CARD / PHYSICAL_GIFT (vouchers, gifts)        → "nonCash"
 *    - TdsOffPlatformEntry (194R)                                                → "nonCash"
 *      (except a marker row REPLACED by a live off-portal payment — the payment counts instead, never both)
 *    - OffPortalPayment (194R, not void; owner 2026-11-25) by PAYMENT DATE: incentive cash → "cash",
 *      visibility cash → "vis", any gift → "nonCash". Paid in full — nothing withheld.
 *
 *  DATES (owner FY rule 2026-11-18): a payout that went through a bank file — PAID or PROCESSING —
 *  belongs to the FY its BANK FILE was made (`download.downloadedAt`; the engine counts the run it is
 *  building at the run date = that file's date); the UTR / payment date never moves it. A PAID payout
 *  with no bank file and imported vendor payouts count by `paidAt`; redemptions by `deliveredAt`;
 *  off-platform by `entryDate`. FAILED / REVERSED / PENDING payouts are not counted.
 *
 *  WHO (owner rule 2026-11-18): TDS is keyed by PAN, using the payee SNAPSHOT taken when the payout went
 *  into a bank file (CreditPayoutEntry.payeePan) or the redemption was delivered (RedemptionOrder.payeePan):
 *  a PAN change SPLITS the year at the change — everything paid before stays with the OLD PAN (or the no-PAN
 *  owner key), everything after goes to the NEW PAN. A row without a snapshot falls back to the current owner.
 *  (D4) A PAN holder is keyed by PAN. Without a PAN, all outlets of one ChannelPartner are ONE
 *  retailer (`__NO_PAN__:<partnerId>`); an outlet with no partner counts alone
 *  (`__NO_PAN__:outlet:<clientId>:<outletCode>`).
 *
 *  HOW MUCH (D5/D6/Q1/Q3): total base > ₹20,000 (FY, statutory config) → TDS on the WHOLE year.
 *  Rate = 10% with PAN / 20% without (statutory config, never a fixed fraction).
 *    - deduct part      = the visibility base when the client's CURRENT method is DEDUCT → base ×
 *                         rate% (10% with PAN, 20% without — owner 2026-11-18: a no-PAN retailer's
 *                         visibility IS withheld at 20%), withheld from the retailer's visibility payouts.
 *    - client-borne part = everything else (incentives, cash redemptions, gifts, vouchers,
 *                         off-platform, and ALL visibility under GROSS_UP) → base × rate / (100 − rate).
 *    Each part is rounded to the rupee separately. Liability = deduct part + client-borne part.
 *    Outstanding (report) = liability − deposits uploaded in the portal. Deductions do NOT reduce the
 *    liability; the engine withholds (deduct part − already deducted, net of reversals), capped at
 *    the payout, carrying the rest forward.
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { Prisma, TdsMethodology } from '@prisma/client';
import {
  effectiveEntrySection,
  financialYear,
  fyFromLabel,
  grossUpTdsPaise,
  IMPORTED_INCENTIVE_PAYOUT_FIELD_ID,
  istDayStartInstant,
  parseImportedPayoutsSetting,
  rate194RFrom,
  TDS_IMPORTED_PAYOUTS_SETTING_KEY,
  type ResolvedTdsStatutory,
} from './tds.helpers';
import { withholdingTdsPaise } from './tds-methodology.helper';

/** A Prisma client OR an interactive-transaction client (the engine reads inside its download tx). */
export type Tds194RDb = Prisma.TransactionClient;

// ─── No-PAN deductee keys (shared with the 194R/194C report) ─────────────────
export const NO_PAN_KEY = '__NO_PAN__';
export const noPanPartnerKey = (partnerId: string): string => `${NO_PAN_KEY}:${partnerId}`;
export const noPanOutletKey = (clientId: string, outletCode: string): string =>
  `${NO_PAN_KEY}:outlet:${clientId}:${outletCode}`;
/** True for the bare unattributed key AND every per-deductee no-PAN key. */
export const isNoPanKey = (key: string): boolean => key === NO_PAN_KEY || key.startsWith(`${NO_PAN_KEY}:`);

/**
 * Off-portal payments register: the 194R key of a NO-PAN off-portal payment — payeeKeyFor on the outlet's (current)
 * owner with no PAN: `__NO_PAN__:<partnerId>`, else (no owner / not on the portal) `__NO_PAN__:outlet:<client>:<code>`
 * using the portal's spelling of the code when the outlet exists. Shared by the upload preview and the 194R base.
 */
export function offPortalNoPanKey(
  clientId: string,
  outletCode: string,
  portalOutlet: { outletCode: string; partnerId: string | null } | null | undefined,
): string {
  return payeeKeyFor(
    clientId,
    portalOutlet?.outletCode ?? outletCode,
    portalOutlet?.partnerId ? { id: portalOutlet.partnerId, panNumber: null } : null,
  );
}

/**
 * A-M2 — the ONE PAN normaliser. Every character in PAN_WS_CLASS (space, \t \n \r \f \v, NBSP, zero-width
 * space, BOM) is removed — anywhere, not only at the ends — and the result upper-cased. The SQL twin is
 * PAN_NORMALISE_SQL (identical character class, used by the engine scope query, the DELIVERED snapshot and
 * the 20261118180000_tds_payee_snapshot backfill). Keep the two in lock-step.
 */
export const PAN_WS_CLASS = '[ \\t\\n\\r\\f\\v\\u00a0\\u200b\\ufeff]';
const PAN_WS_RE = new RegExp(PAN_WS_CLASS, 'g');
export function normalisePan(pan: string): string {
  return pan.replace(PAN_WS_RE, '').toUpperCase();
}
/** SQL twin of normalisePan for a column/expression `x`: upper(regexp_replace(x, PAN_WS_CLASS, '', 'g')). */
export const PAN_NORMALISE_SQL = (x: string): string => `upper(regexp_replace(${x}, '${PAN_WS_CLASS}', '', 'g'))`;

/** A STORED PAN value that means "no PAN": blank (after normalising), or a `__NO_PAN__…` sentinel. */
export const isNoPanCell = (pan: string | null | undefined): boolean => {
  if (!pan) return true;
  const n = normalisePan(pan);
  return !n || isNoPanKey(n);
};

/**
 * The 194R payee key of a payout / redemption / upload AS OF NOW: the owner's normalised PAN, else the
 * no-PAN owner key `__NO_PAN__:<partnerId>`, else (no owner) `__NO_PAN__:outlet:<clientId>:<outletCode>`.
 * A-L1: every writer of a payee snapshot (bank file, delivery, deposit / off-platform uploads, and ANY
 * future import script) must use this so keys are identical everywhere.
 */
export function payeeKeyFor(
  clientId: string,
  outletCode: string | null,
  partner: { id: string; panNumber: string | null } | null | undefined,
): string {
  if (partner && !isNoPanCell(partner.panNumber)) return normalisePan(partner.panNumber!);
  if (partner?.id) return noPanPartnerKey(partner.id);
  return noPanOutletKey(clientId, outletCode ?? '');
}

/**
 * Normalise a 194R TdsDeductionEntry.panNumber to the retailer key: a real PAN is upper-cased; a no-PAN
 * owner key (`__NO_PAN__:<partnerId>` / `__NO_PAN__:outlet:…`) is kept EXACTLY (ids are case-sensitive).
 */
export function retailerKeyOfLedgerPan(panNumber: string): string {
  const t = panNumber.trim();
  return isNoPanKey(t.toUpperCase()) ? t : normalisePan(t);
}

/** Redemption modes that are CASH (paid to the retailer's bank/UPI); the rest are gifts/vouchers. */
export const CASH_REDEMPTION_MODES: ReadonlySet<string> = new Set(['UPI', 'BANK_TRANSFER']);

/** One retailer's 194R base for the FY, split by how its TDS is borne. */
export interface Bases194R {
  hasPan: boolean;
  /** Visibility payouts frozen 194R (cash). */
  visPaise: bigint;
  /** Incentive payouts (incl. counted imported ones) + cash redemptions. */
  cashPaise: bigint;
  /** Gifts, vouchers, off-platform benefits. */
  nonCashPaise: bigint;
}

export const emptyBases194R = (hasPan: boolean): Bases194R => ({ hasPan, visPaise: 0n, cashPaise: 0n, nonCashPaise: 0n });

export interface Liability194R {
  totalBasePaise: bigint;
  cashBasePaise: bigint;
  nonCashBasePaise: bigint;
  thresholdMet: boolean;
  /** Whole-percent rate applied (10 with PAN / 20 without, from the FY statutory config). */
  ratePct: number;
  methodology: TdsMethodology;
  /** Base on which TDS is WITHHELD from the retailer (visibility on DEDUCT — with or without a PAN). */
  deductBasePaise: bigint;
  /** Base whose TDS the CLIENT bears (gross-up). */
  clientBorneBasePaise: bigint;
  deductPartPaise: bigint;
  clientBornePartPaise: bigint;
  liabilityPaise: bigint;
}

/** The single 194R liability formula (pure). See the module header. */
export function liability194R(b: Bases194R, methodology: TdsMethodology, cfg: ResolvedTdsStatutory): Liability194R {
  const rate = rate194RFrom(cfg, b.hasPan);
  const cashBasePaise = b.visPaise + b.cashPaise;
  const totalBasePaise = cashBasePaise + b.nonCashPaise;
  const thresholdMet = totalBasePaise > cfg.thr194rFyPaise;
  // Owner 2026-11-18: on DEDUCT the visibility base is withheld for EVERY retailer — 10% with a PAN,
  // 20% without (the no-PAN rate). Everything else stays client-borne gross-up.
  const withheld = methodology === 'DEDUCT';
  const deductBasePaise = withheld ? b.visPaise : 0n;
  const clientBorneBasePaise = totalBasePaise - deductBasePaise;
  const deductPartPaise = thresholdMet && deductBasePaise > 0n ? withholdingTdsPaise(deductBasePaise, rate) : 0n;
  const clientBornePartPaise =
    thresholdMet && clientBorneBasePaise > 0n ? grossUpTdsPaise(clientBorneBasePaise, rate) : 0n;
  return {
    totalBasePaise,
    cashBasePaise,
    nonCashBasePaise: b.nonCashPaise,
    thresholdMet,
    ratePct: rate.num,
    methodology,
    deductBasePaise,
    clientBorneBasePaise,
    deductPartPaise,
    clientBornePartPaise,
    liabilityPaise: deductPartPaise + clientBornePartPaise,
  };
}

/**
 * The tenant's imported-payouts countFrom ('YYYY-MM-DD') or null (OFF). FAIL CLOSED: a malformed
 * stored value throws — a statutory figure must never silently drop the imported payouts.
 */
export async function importedPayoutsCountFromOrThrow(db: Tds194RDb, clientId: string): Promise<string | null> {
  const row = await db.programSetting.findUnique({
    where: { clientId_settingKey: { clientId, settingKey: TDS_IMPORTED_PAYOUTS_SETTING_KEY } },
    select: { settingValue: true },
  });
  const { countFrom, malformed } = parseImportedPayoutsSetting(row?.settingValue ?? null);
  if (malformed) {
    throw new InternalServerErrorException(
      'The imported-payouts TDS setting for this client is invalid — re-save it on the TDS Treatment screen.',
    );
  }
  return countFrom;
}

/**
 * UPPER-cased outlet code → every matching outlet (several = ambiguous across tenants), matched
 * case-insensitively. No query when there is nothing to resolve.
 */
export async function outletsByCodeCI(
  db: Tds194RDb,
  codes: string[],
  clientId: string | null,
): Promise<Map<string, Array<{ outletCode: string; clientId: string; partnerId: string | null }>>> {
  const out = new Map<string, Array<{ outletCode: string; clientId: string; partnerId: string | null }>>();
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean).map((c) => c.toUpperCase()))];
  if (!uniq.length) return out;
  const found = await db.outlet.findMany({
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

/** owner partnerId → its REAL PAN (upper-cased), for the owners of the given outlets. */
export async function ownerPansOf(
  db: Tds194RDb,
  outletsByCode: Map<string, Array<{ partnerId: string | null }>>,
): Promise<Map<string, string>> {
  const ids = [...new Set([...outletsByCode.values()].flat().map((o) => o.partnerId).filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const owners = await db.channelPartner.findMany({ where: { id: { in: ids } }, select: { id: true, panNumber: true } });
  for (const o of owners) if (!isNoPanCell(o.panNumber)) out.set(o.id, normalisePan(o.panNumber!));
  return out;
}

/**
 * Resolve a (no-PAN-cell) outlet code of THIS client to its deductee key: the owner's PAN when one is
 * on file, else the owner's own no-PAN key (owner-less outlet → per-outlet key). Unknown / ambiguous
 * code → null.
 */
export function keyForOutletCode(
  code: string | null | undefined,
  outletsByCode: Map<string, Array<{ outletCode: string; clientId: string; partnerId: string | null }>>,
  ownerPans: Map<string, string>,
): string | null {
  const c = code?.trim();
  if (!c) return null;
  const matches = outletsByCode.get(c.toUpperCase()) ?? [];
  if (matches.length !== 1) return null;
  const o = matches[0];
  const pan = o.partnerId ? ownerPans.get(o.partnerId) : null;
  if (pan) return pan;
  return o.partnerId ? noPanPartnerKey(o.partnerId) : noPanOutletKey(o.clientId, o.outletCode);
}

export interface Collect194RArgs {
  clientId: string;
  fyLabel: string;
  /** The tenant's imported-payouts countFrom (already read), or null (OFF). */
  importedCountFrom: string | null;
  /**
   * Engine restriction (the PANs of one payout run): only these outlets' payouts, these partners'
   * redemptions, and off-platform rows naming these PANs / outlet codes are read. Omitted → the whole
   * client (the report).
   */
  scope?: { outletCodes: string[]; partnerIds: string[]; pans: string[]; keys?: string[] };
  /** DISPLAY-ONLY sink: deductee key → contributing outlet code (export columns). */
  noteOutlet?: (key: string, outletCode: string) => void;
  /**
   * Wallet Reversal Engine D1 (owner 2026-11-16, kept by the 2026-11-19 merge decision A): a PAID payout that a V2
   * reversal took off the base (`tdsBaseReversedAt` set) is NOT counted — the income was reversed. It is reported
   * here instead (same key / bucket it would have counted under), for the report's call-outs, the engine's hand-back
   * explanation and the reversal credit cap. Only V2 reversals set the marker → every other tenant is unchanged.
   */
  reversedSink?: (key: string, item: Reversed194RItem) => void;
  /** Off-portal payments register (2026-11-25): every off-portal payment counted, under its key (report call-outs). */
  offPortalSink?: (key: string, item: OffPortal194RItem) => void;
  /**
   * ENGINE view (owner 2026-11-26): off-portal payments COUNT toward the yearly threshold but NEVER drive automatic
   * withholding on later portal payouts. True → off-portal visibility is counted in the non-cash bucket (still in the
   * total base → threshold) instead of the visibility bucket the DEDUCT engine withholds on. The report leaves it
   * false (the full liability, with the shortfall said on the row).
   */
  offPortalForThresholdOnly?: boolean;
}

/** An off-portal payment counted in the 194R base (paid in full outside the portal — nothing withheld). */
export interface OffPortal194RItem {
  id: string;
  hasPan: boolean;
  bucket: 'visPaise' | 'cashPaise' | 'nonCashPaise';
  amountPaise: bigint;
  paymentDate: Date;
  outletCode: string;
}

/** A payout taken off the 194R base by a V2 reversal (D1). */
export interface Reversed194RItem {
  entryId: string;
  hasPan: boolean;
  bucket: 'visPaise' | 'cashPaise';
  amountPaise: bigint;
  reversedAt: Date;
  period: string;
  outletCode: string;
  /** The partner paid (bank-file snapshot) — the retailer whose current key decides "PAN changed". */
  payeePartnerId?: string | null;
}

/**
 * Collect every 194R benefit of ONE client for ONE FY, keyed by deductee (PAN or no-PAN key), split
 * vis / cash / nonCash. The single source of "what counts" for the engine AND the report.
 */
export async function collect194RBases(db: Tds194RDb, args: Collect194RArgs): Promise<Map<string, Bases194R>> {
  const { clientId, fyLabel, importedCountFrom, scope, noteOutlet, reversedSink, offPortalSink } = args;
  const { start, endExclusive } = fyFromLabel(fyLabel);
  const out = new Map<string, Bases194R>();
  const add = (key: string, hasPan: boolean, bucket: keyof Omit<Bases194R, 'hasPan'>, amount: bigint): void => {
    const b = out.get(key) ?? emptyBases194R(hasPan);
    b[bucket] += amount;
    out.set(key, b);
  };
  const keyOf = (pan: string | null | undefined, noPanKey: string): { key: string; hasPan: boolean } =>
    isNoPanCell(pan) ? { key: noPanKey, hasPan: false } : { key: normalisePan(pan!), hasPan: true };

  const visibilityFields = await db.creditField.findMany({
    where: { clientId, payoutStream: 'VISIBILITY' },
    select: { id: true },
  });
  const visIds = new Set(visibilityFields.map((f) => f.id));
  // Engine scope: rows SNAPSHOTTED to one of the run's retailer keys, or (no snapshot) on their outlets.
  const scopeKeys = scope ? (scope.keys ?? scope.pans) : [];
  const outletFilter = scope
    ? { OR: [{ payeePan: { in: scopeKeys } }, { payeePan: null, outletId: { in: scope.outletCodes } }] }
    : {};
  const sel = {
    id: true, clientId: true, amountPaise: true, fieldId: true, outletId: true, tdsSection: true, payeePan: true,
    period: true, tdsBaseReversedAt: true, status: true, payeePartnerId: true,
  } as const;

  // ── Source 1: payouts. OWNER FY RULE (2026-11-18): a payout that went through a bank file belongs to
  // the FY the BANK FILE was made (download.downloadedAt) — PAID or PROCESSING alike; the UTR /
  // payment date never moves it (a 30-Mar file paid on 2-Apr stays in the March FY, matching the
  // engine's ledger FY = run date). A PAID payout with NO bank file falls back to paidAt; imported
  // vendor payouts (no bank file) count by paidAt from the client's countFrom date. ──
  const banked = await db.creditPayoutEntry.findMany({
    where: {
      clientId,
      status: { in: ['PAID', 'PROCESSING'] },
      download: { downloadedAt: { gte: start, lt: endExclusive } },
      // NULL-safe exclusion of VENDOR_IMPORT history (counted below only from countFrom).
      batch: { OR: [{ sourceKind: null }, { sourceKind: { not: 'VENDOR_IMPORT' } }] },
      ...outletFilter,
    },
    select: sel,
  });
  const paidNoFile = await db.creditPayoutEntry.findMany({
    where: {
      clientId,
      status: 'PAID',
      downloadId: null,
      paidAt: { gte: start, lt: endExclusive },
      batch: { OR: [{ sourceKind: null }, { sourceKind: { not: 'VENDOR_IMPORT' } }] },
      ...outletFilter,
    },
    select: sel,
  });
  const importFrom = importedCountFrom ? istDayStartInstant(importedCountFrom) : null;
  const imported =
    importFrom && importFrom < endExclusive
      ? await db.creditPayoutEntry.findMany({
          where: {
            clientId,
            status: 'PAID',
            paidAt: { gte: importFrom > start ? importFrom : start, lt: endExclusive },
            fieldId: IMPORTED_INCENTIVE_PAYOUT_FIELD_ID,
            batch: { sourceKind: 'VENDOR_IMPORT' },
            ...outletFilter,
          },
          select: sel,
        })
      : [];
  // Re-audit A2: a PAID payout FULLY withheld as TDS that a V2 reversal turned REVERSED (owner D2 — the TDS stays
  // deposited) is no longer PAID, so the two reads above miss it. It must still REPORT (reversedSink): the row keeps its
  // reversal flag, "below threshold after reversal", the M2 revise-return warning and the engine's hand-back priorDue.
  // Never counted in the base (it carries the marker → the loop below sends it to the sink). Only V2 sets the marker.
  const reversedRetained = reversedSink
    ? await db.creditPayoutEntry.findMany({
        where: {
          clientId,
          status: 'REVERSED',
          tdsBaseReversedAt: { not: null },
          OR: [
            { download: { downloadedAt: { gte: start, lt: endExclusive } } },
            { downloadId: null, paidAt: { gte: start, lt: endExclusive } },
          ],
          batch: { OR: [{ sourceKind: null }, { sourceKind: { not: 'VENDOR_IMPORT' } }] },
          ...(scope ? { AND: [outletFilter] } : {}),
        },
        select: sel,
      })
    : [];
  const byId = new Map<string, (typeof banked)[number]>();
  for (const e of [...banked, ...paidNoFile, ...imported]) if (!byId.has(e.id)) byId.set(e.id, e);
  // (a REVERSED row without the marker can never count — guarded in JS too)
  for (const e of reversedRetained ?? []) {
    if (e.tdsBaseReversedAt && String(e.status) === 'REVERSED' && !byId.has(e.id)) byId.set(e.id, e);
  }
  const entries = [...byId.values()].filter(
    (e) => (!e.clientId || e.clientId === clientId) && effectiveEntrySection(e.tdsSection, visIds.has(e.fieldId)) === 'SEC_194R',
  );

  const codes = [...new Set(entries.map((e) => e.outletId))];
  const outlets = codes.length
    ? await db.outlet.findMany({ where: { outletCode: { in: codes }, clientId }, select: { outletCode: true, partnerId: true } })
    : [];
  const outletToPartner = new Map(outlets.map((o) => [o.outletCode, o.partnerId]));
  const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))] as string[];
  const partners = partnerIds.length
    ? await db.channelPartner.findMany({ where: { id: { in: partnerIds }, isParent: false }, select: { id: true, panNumber: true } })
    : [];
  const partnerPan = new Map(partners.map((p) => [p.id, p.panNumber]));
  for (const e of entries) {
    const partnerId = outletToPartner.get(e.outletId) ?? null;
    const pan = partnerId ? (partnerPan.get(partnerId) ?? null) : null;
    // The payee SNAPSHOT (PAN or no-PAN key at payment time) wins; no snapshot → the current owner.
    const { key, hasPan } = e.payeePan
      ? { key: e.payeePan, hasPan: !isNoPanKey(e.payeePan) }
      : keyOf(pan, partnerId ? noPanPartnerKey(partnerId) : noPanOutletKey(clientId, e.outletId));
    const bucket = visIds.has(e.fieldId) ? 'visPaise' : 'cashPaise';
    if (e.tdsBaseReversedAt) {
      // D1: reversed by the engine → off the base; said instead of counted.
      reversedSink?.(key, {
        entryId: e.id, hasPan, bucket, amountPaise: e.amountPaise, reversedAt: new Date(e.tdsBaseReversedAt),
        period: e.period, outletCode: e.outletId, payeePartnerId: e.payeePartnerId ?? null,
      });
      continue;
    }
    add(key, hasPan, bucket, e.amountPaise);
    noteOutlet?.(key, e.outletId);
  }

  // ── Source 2: DELIVERED redemptions (by deliveredAt) — cash vs gift/voucher by mode ──
  const redemptions = await db.redemptionOrder.findMany({
    where: {
      status: 'DELIVERED',
      deliveredAt: { gte: start, lt: endExclusive },
      partner: { clientId },
      valuePaise: { not: null },
      ...(scope ? { OR: [{ payeePan: { in: scopeKeys } }, { payeePan: null, partnerId: { in: scope.partnerIds } }] } : {}),
    },
    select: { valuePaise: true, redemptionMode: true, payeePan: true, partner: { select: { id: true, panNumber: true } } },
  });
  for (const r of redemptions) {
    if (r.valuePaise == null) continue;
    const { key, hasPan } = r.payeePan
      ? { key: r.payeePan, hasPan: !isNoPanKey(r.payeePan) }
      : keyOf(r.partner?.panNumber, r.partner?.id ? noPanPartnerKey(r.partner.id) : NO_PAN_KEY);
    add(key, hasPan, CASH_REDEMPTION_MODES.has(String(r.redemptionMode)) ? 'cashPaise' : 'nonCashPaise', r.valuePaise);
  }

  // ── Source 3: off-platform 194R benefits (by entryDate) — non-cash ──
  const offPlatform = await db.tdsOffPlatformEntry.findMany({
    where: {
      clientId,
      section: 'SEC_194R',
      entryDate: { gte: start, lt: endExclusive },
      ...(scope
        ? {
            OR: [
              { resolvedKey: { in: scopeKeys } },
              { resolvedKey: null, panNumber: { in: scope.pans, mode: 'insensitive' as const } },
              { resolvedKey: null, outletCode: { in: scope.outletCodes, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: { id: true, panNumber: true, amountPaise: true, outletCode: true, resolvedKey: true },
  });
  // Off-portal payments register: a legacy marker row REPLACED by a live off-portal payment is not counted here — the
  // payment (Source 4, with its true cash / gift bucket) counts instead. Never both. (No live payment → unchanged.)
  // `offPortalPayment` is absent only on narrow unit-test fakes; the real client always has it.
  const offPortalDelegate = (db as Partial<Tds194RDb>).offPortalPayment;
  const replaced = offPlatform.length && offPortalDelegate
    ? new Set(
        (
          await offPortalDelegate.findMany({
            where: { clientId, voidedAt: null, supersedesOffPlatformEntryId: { in: offPlatform.map((r) => r.id).filter(Boolean) } },
            select: { supersedesOffPlatformEntryId: true },
          })
        ).map((p) => p.supersedesOffPlatformEntryId),
      )
    : new Set<string | null>();
  for (let i = offPlatform.length - 1; i >= 0; i--) if (offPlatform[i].id && replaced.has(offPlatform[i].id)) offPlatform.splice(i, 1);
  const noPanCodes = offPlatform
    .filter((r) => !r.resolvedKey && isNoPanCell(r.panNumber) && r.outletCode?.trim())
    .map((r) => r.outletCode!.trim());
  const byCode = await outletsByCodeCI(db, noPanCodes, clientId);
  const ownerPans = await ownerPansOf(db, byCode);
  for (const e of offPlatform) {
    let key: string;
    let hasPan: boolean;
    if (e.resolvedKey) {
      // A-H1: the retailer key AS OF the upload (a later PAN change never moves it).
      key = e.resolvedKey;
      hasPan = !isNoPanKey(key);
    } else if (!isNoPanCell(e.panNumber)) {
      key = normalisePan(e.panNumber);
      hasPan = true;
    } else {
      key = keyForOutletCode(e.outletCode, byCode, ownerPans) ?? NO_PAN_KEY;
      hasPan = !isNoPanKey(key);
    }
    add(key, hasPan, 'nonCashPaise', e.amountPaise);
    if (noteOutlet && e.outletCode?.trim()) {
      const m = isNoPanCell(e.panNumber) ? byCode.get(e.outletCode.trim().toUpperCase()) : undefined;
      noteOutlet(key, m && m.length === 1 ? m[0].outletCode : e.outletCode);
    }
  }

  // ── Source 4: OFF-PORTAL payments register (owner 2026-11-25) — paid IN FULL outside the portal, by PAYMENT DATE ──
  // Key: the PAN frozen at upload (file PAN, else the portal owner's PAN then); no PAN → the outlet's CURRENT no-PAN
  // owner key (`__NO_PAN__:<partnerId>`, else `__NO_PAN__:outlet:<clientId>:<code>` — so an Outlet ID that registers
  // later joins its owner's no-PAN year). Bucket: Incentive → cash / gift → non-cash; Visibility (194R) → visibility
  // (cash) / gift → non-cash. Voided rows never count. 194C visibility rows are read by the 194C report instead.
  if (offPortalDelegate) {
    const scopeCodes = scope ? [...new Set(scope.outletCodes.map((c) => c.trim().toUpperCase()))] : [];
    const offPortal = await offPortalDelegate.findMany({
      where: {
        clientId,
        voidedAt: null,
        tdsSection: 'SEC_194R',
        paymentDate: { gte: start, lt: endExclusive },
        ...(scope ? { OR: [{ panNumber: { in: scopeKeys } }, { panNumber: null, outletCodeKey: { in: scopeCodes } }] } : {}),
      },
      select: { id: true, outletCode: true, outletCodeKey: true, panNumber: true, amountPaise: true, paymentDate: true, payoutStream: true, paymentMode: true },
    });
    const noPanOp = offPortal.filter((p) => isNoPanCell(p.panNumber)).map((p) => p.outletCode);
    const opOutlets = await outletsByCodeCI(db, noPanOp, clientId);
    for (const p of offPortal) {
      let key: string;
      let hasPan: boolean;
      if (!isNoPanCell(p.panNumber)) {
        key = normalisePan(p.panNumber!);
        hasPan = true;
      } else {
        const m = opOutlets.get(p.outletCodeKey) ?? [];
        const o = m.length === 1 ? m[0] : null;
        // The SAME resolver the portal's payee snapshot uses (payeeKeyFor), on the outlet's CURRENT owner, without a PAN
        // (owner rule: a no-PAN payment stays no-PAN even if the owner adds a PAN later — the year splits at the change).
        key = offPortalNoPanKey(clientId, p.outletCode, o);
        hasPan = false;
      }
      const bucket: OffPortal194RItem['bucket'] =
        p.paymentMode === 'GIFT' ? 'nonCashPaise' : p.payoutStream === 'VISIBILITY' ? 'visPaise' : 'cashPaise';
      add(key, hasPan, args.offPortalForThresholdOnly && bucket === 'visPaise' ? 'nonCashPaise' : bucket, p.amountPaise);
      noteOutlet?.(key, p.outletCode);
      offPortalSink?.(key, { id: p.id, hasPan, bucket, amountPaise: p.amountPaise, paymentDate: p.paymentDate, outletCode: p.outletCode });
    }
  }
  return out;
}

/**
 * Wallet Reversal Engine (merge decision A, 2026-11-19) — OPEN 194R TDS credits (amount − applied > 0) of ONE client
 * for ONE FY, keyed by the retailer key the credit was raised on (the ledger row's own PAN / no-PAN key). A credit is
 * TDS already in the ledger (`deducted194RByRetailer`) that belongs to reversed income: the report's excess and the
 * engine's credit explanation subtract it. Credits are strictly per client (194R: the client is the deductor).
 */
export async function openCredits194RByRetailer(
  db: Tds194RDb,
  a: { clientId: string; fyLabel: string; scope?: { keys: string[] } },
): Promise<Map<string, bigint>> {
  const rows = await db.tdsCredit.findMany({
    where: {
      clientId: a.clientId,
      section: 'SEC_194R',
      fyLabel: a.fyLabel,
      ...(a.scope ? { panNumber: { in: a.scope.keys } } : {}),
    },
    select: { panNumber: true, amountPaise: true, appliedPaise: true },
  });
  const out = new Map<string, bigint>();
  for (const r of rows ?? []) {
    const open = r.amountPaise - r.appliedPaise;
    if (open <= 0n || !r.panNumber?.trim()) continue;
    const key = retailerKeyOfLedgerPan(r.panNumber);
    out.set(key, (out.get(key) ?? 0n) + open);
  }
  return out;
}

/**
 * Re-audit A1 (2026-11-19) — the open 194R TDS credits of one client for one FY, split into USABLE and UNUSABLE by the
 * SAME three conditions under which the payout run draws a credit (credits.service plan194RDeductions loads credits
 * for the run date's FY and the run's CURRENT payee keys only, and only runs on DEDUCT):
 *   (a) the credit's FY is the current (open) FY;  (b) the client's current method is DEDUCT;
 *   (c) the credit's key equals the key this retailer's future payouts use (its source payout's outlet owner today).
 * The 194R report subtracts only the usable part from "deducted so far" before the excess test; the unusable part
 * stays counted as excess (owner rule: flag only) and is called out on the row.
 */
export interface OpenCredits194R {
  usable: bigint;
  unusable: bigint;
  reasons: string[];
}
export async function openCredits194RUsability(
  db: Tds194RDb,
  a: { clientId: string; fyLabel: string; methodology: string; now?: Date },
): Promise<Map<string, OpenCredits194R>> {
  const rows = await db.tdsCredit.findMany({
    where: { clientId: a.clientId, section: 'SEC_194R', fyLabel: a.fyLabel },
    select: { panNumber: true, amountPaise: true, appliedPaise: true, sourcePayoutEntryId: true },
  });
  const open = (rows ?? []).filter((r) => r.amountPaise - r.appliedPaise > 0n && r.panNumber?.trim());
  const out = new Map<string, OpenCredits194R>();
  if (open.length === 0) return out;
  const currentFy = financialYear(a.now ?? new Date()).fyLabel;
  // (c) the retailer the credit belongs to = the payee recorded on its source payout (payeePartnerId snapshot).
  const src = await db.creditPayoutEntry.findMany({
    where: { id: { in: open.map((r) => r.sourcePayoutEntryId) } },
    select: { id: true, payeePartnerId: true },
  });
  const payeeOf = new Map((src ?? []).map((e) => [e.id, e.payeePartnerId ?? null]));
  const keys = open.map((r) => retailerKeyOfLedgerPan(r.panNumber));
  const nowKeys = await currentRetailerKeys(
    db,
    a.clientId,
    open.map((r, i) => ({ key: keys[i], payeePartnerId: payeeOf.get(r.sourcePayoutEntryId) ?? null })),
  );
  open.forEach((r, i) => {
    const key = keys[i];
    const reason = creditUnusableReason(
      { fyLabel: a.fyLabel, key },
      { currentFy, methodology: a.methodology, currentKey: nowKeys[i] },
    );
    const b = out.get(key) ?? { usable: 0n, unusable: 0n, reasons: [] };
    const amt = r.amountPaise - r.appliedPaise;
    if (reason) {
      b.unusable += amt;
      if (!b.reasons.includes(UNUSABLE_REASON_TEXT[reason])) b.reasons.push(UNUSABLE_REASON_TEXT[reason]);
    } else {
      b.usable += amt;
    }
    out.set(key, b);
  });
  return out;
}

/** Why a 194R TDS credit (or an automatic ledger hand-back) can not be used — null when it can. */
export type CreditUnusableReason = 'FY_CLOSED' | 'GROSS_UP' | 'PAN_CHANGED';
export const UNUSABLE_REASON_TEXT: Record<CreditUnusableReason, string> = {
  FY_CLOSED: 'later-year reversal / FY closed',
  GROSS_UP: 'method changed to gross-up',
  PAN_CHANGED: 'PAN changed',
};

/**
 * Final dual-audit (2026-11-19) — the ONE usability rule, shared by credit creation (recordReceivableTds), the hand-back
 * call-out, the 194R report and the TDS credits register. The payout run draws a credit / nets a ledger surplus only
 * for (a) the run date's FY, (b) a client on DEDUCT, (c) the retailer's CURRENT payee key — so:
 */
export function creditUnusableReason(
  c: { fyLabel: string; key: string },
  ctx: { currentFy: string; methodology: string | null | undefined; currentKey: string | null },
): CreditUnusableReason | null {
  if (c.fyLabel !== ctx.currentFy) return 'FY_CLOSED';
  if (ctx.methodology != null && ctx.methodology !== 'DEDUCT') return 'GROSS_UP';
  if (ctx.currentKey !== retailerKeyOfLedgerPan(c.key)) return 'PAN_CHANGED';
  return null;
}

/**
 * Final dual-audit item 4 — the key the payout run would use TODAY for the RETAILER a ledger key belongs to (not the
 * source outlet's current owner): the retailer is the partner paid (the payout's `payeePartnerId` snapshot, when known),
 * else the partner behind a no-PAN owner key, else the client's partner(s) holding that PAN. Its current key is
 * `payeeKeyFor` of that partner (its PAN today, else its no-PAN key). A PAN no partner of the client holds any more →
 * null (changed). An owner-less outlet key resolves through the outlet's owner today.
 */
export async function currentRetailerKeys(
  db: Tds194RDb,
  clientId: string,
  items: Array<{ key: string; payeePartnerId?: string | null }>,
): Promise<Array<string | null>> {
  const OUTLET = `${NO_PAN_KEY}:outlet:${clientId}:`;
  const partnerIdOf = (it: { key: string; payeePartnerId?: string | null }): string | null => {
    const k = retailerKeyOfLedgerPan(it.key);
    if (it.payeePartnerId) return it.payeePartnerId;
    if (isNoPanKey(k) && !k.startsWith(`${NO_PAN_KEY}:outlet:`) && k.startsWith(`${NO_PAN_KEY}:`)) return k.slice(NO_PAN_KEY.length + 1);
    return null;
  };
  const ids = [...new Set(items.map(partnerIdOf).filter((x): x is string => !!x))];
  const partners = ids.length
    ? await db.channelPartner.findMany({ where: { id: { in: ids } }, select: { id: true, panNumber: true } })
    : [];
  const byId = new Map((partners ?? []).map((p) => [p.id, p]));
  const outletCodes = items.map((it) => retailerKeyOfLedgerPan(it.key)).filter((k) => k.startsWith(OUTLET)).map((k) => k.slice(OUTLET.length));
  const outlets = outletCodes.length
    ? await db.outlet.findMany({
        where: { clientId, outletCode: { in: [...new Set(outletCodes)] } },
        select: { outletCode: true, partner: { select: { id: true, panNumber: true } } },
      })
    : [];
  const ownerOf = new Map((outlets ?? []).map((o) => [o.outletCode, o.partner ?? null]));
  const needPanHolders = items.some((it) => !partnerIdOf(it) && !isNoPanKey(retailerKeyOfLedgerPan(it.key)));
  const holders = needPanHolders
    ? await db.channelPartner.findMany({ where: { clientId }, select: { id: true, panNumber: true } })
    : [];
  const heldPans = new Set((holders ?? []).filter((p) => !isNoPanCell(p.panNumber)).map((p) => normalisePan(p.panNumber!)));
  return items.map((it) => {
    const k = retailerKeyOfLedgerPan(it.key);
    const pid = partnerIdOf(it);
    if (pid) {
      const p = byId.get(pid);
      return p ? payeeKeyFor(clientId, null, p) : null;
    }
    if (k.startsWith(OUTLET)) {
      const code = k.slice(OUTLET.length);
      return payeeKeyFor(clientId, code, ownerOf.get(code) ?? null);
    }
    return heldPans.has(k) ? k : null;
  });
}

/**
 * TDS already deducted from each 194R retailer this FY (net of FAILED / reversal offsets), keyed by the
 * ledger row's OWN stored key — the PAN (or no-PAN owner key) at the time of withholding. Owner rule
 * 2026-11-18: TDS is by PAN, a PAN change splits the year, so a row is never moved to another PAN.
 * Shared by the engine (scope = this run's retailer keys) and the 194R report (no scope = whole client).
 */
export async function deducted194RByRetailer(
  db: Tds194RDb,
  a: { clientId: string; fyLabel: string; scope?: { keys: string[] } },
  /** Optional sink: the carry-forward recorded on each retailer's LATEST ledger row (report only). */
  lastCarryForward?: Map<string, bigint>,
): Promise<Map<string, bigint>> {
  const { clientId, fyLabel, scope } = a;
  const rows = await db.tdsDeductionEntry.findMany({
    where: {
      clientId,
      section: 'SEC_194R',
      fyLabel,
      ...(scope ? { panNumber: { in: scope.keys } } : {}),
    },
    select: { id: true, clientId: true, panNumber: true, outletCode: true, tdsDeductedThisPaise: true, carryForwardPaise: true, createdAt: true },
  });
  const mine = (rows ?? []).filter((r) => !r.clientId || r.clientId === clientId);
  const out = new Map<string, bigint>();
  // A-L3: a DETERMINISTIC order — (createdAt, id) ascending — so the carry-forward read below is the
  // LAST row of each retailer's latest ledger group (rows of one download share createdAt), never whichever
  // row the database happened to return last.
  const atOf = (r: { createdAt?: Date | string | null }) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  const ordered = [...mine].sort((x, y) => atOf(x) - atOf(y) || String(x.id ?? '').localeCompare(String(y.id ?? '')));
  for (const r of ordered) {
    if (!r.panNumber?.trim()) continue; // a legacy blank key has no retailer
    const key = retailerKeyOfLedgerPan(r.panNumber);
    out.set(key, (out.get(key) ?? 0n) + r.tdsDeductedThisPaise);
    if (lastCarryForward && r.carryForwardPaise != null) lastCarryForward.set(key, r.carryForwardPaise);
  }
  return out;
}
