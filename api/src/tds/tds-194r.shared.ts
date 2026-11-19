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
}

/**
 * Collect every 194R benefit of ONE client for ONE FY, keyed by deductee (PAN or no-PAN key), split
 * vis / cash / nonCash. The single source of "what counts" for the engine AND the report.
 */
export async function collect194RBases(db: Tds194RDb, args: Collect194RArgs): Promise<Map<string, Bases194R>> {
  const { clientId, fyLabel, importedCountFrom, scope, noteOutlet, reversedSink } = args;
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
    period: true, tdsBaseReversedAt: true,
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
  const byId = new Map<string, (typeof banked)[number]>();
  for (const e of [...banked, ...paidNoFile, ...imported]) if (!byId.has(e.id)) byId.set(e.id, e);
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
        period: e.period, outletCode: e.outletId,
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
    select: { panNumber: true, amountPaise: true, outletCode: true, resolvedKey: true },
  });
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
