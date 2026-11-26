/**
 * OFF-PORTAL PAYMENTS REGISTER (owner-approved 2026-11-25, platform-wide, all clients).
 *
 * Records payments ALREADY MADE outside the portal (bank transfer / UPI / gift) so that:
 *   (a) the 194R / 194C yearly totals per payee are right   → tds-194r.shared collect194RBases + tds.service compute194C
 *   (b) Fund Reconciliation shows them paid from the advance → fund-sources.loader (type OFF_PORTAL_PAYMENT)
 *   (c) the outlet's payout history shows them               → common/payout-statement.helper (partner app + admin/sales)
 *   (+) the Payments Report lists them (separate sheet / totals) → payments-report
 *
 * Who: uploads + voids = GIFSY_ADMIN ASSUMED into the client (never staff, never a client admin). The register list /
 * export = that admin or the client's own CLIENT_ADMIN (phone / bank / PAN / UPI MASKED for anyone but a Gifsy admin).
 *
 * Flow: template → upload (PREVIEW: every row classified; every warning category listed with its rows) → CONFIRM with
 * the SAME file + an explicit tick for EVERY warning category present (server-enforced) → ONE transaction (client
 * advisory lock, re-analysed inside it) writes the upload, the payments, the off-portal payees and an audit row. The
 * file is stored. A mistaken entry is VOIDED (reason, audited) — every consumer ignores a voided row, so its TDS / fund
 * / history effect is reversed (fund shows it returned on the void date).
 *
 * Owner rule "no silent failure": an invalid row is never dropped quietly (category INVALID, listed with its errors);
 * nothing is recorded until every category is ticked.
 * PII: never logged. Audit rows carry counts / amounts / ids only.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type OffPortalPayment, type TdsMethodology, type TdsSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { REPORTS_CLIENT_ID } from '../common/report-recipients';
import { istDateKey, istDayRangeFilter } from '../common/ist-date';
import { buildXlsx } from '../common/xlsx';
import { formatINR } from '../common/money';
import { financialYear, fyLabelForPeriod } from '../tds/tds.helpers';
import { clientHasOffPortalPayments, invalidateOffPortalPresence } from './off-portal-presence';
import { isNoPanCell, isNoPanKey, normalisePan, offPortalNoPanKey, retailerKeyOfLedgerPan } from '../tds/tds-194r.shared';
import {
  buildOffPortalTemplate,
  duplicateKey,
  maskPanValue,
  maskTail,
  maskUpi,
  outletKeyOf,
  parseOffPortalFile,
  type ParsedOffPortalFile,
  type ParsedOffPortalRow,
} from './off-portal-payments.parse';

export const OFF_PORTAL_CATEGORIES = [
  'INVALID',
  'NEW_PAYEE',
  'NAME_DIFFERS',
  'PAN_MISMATCH',
  'NO_PAN',
  'FILE_PAN_ONLY',
  'PORTAL_PAN_USED',
  'DUPLICATE',
  'POSSIBLE_DUPLICATE',
  'PAID_ON_PORTAL',
  'REPLACES_TDS_ENTRY',
  'TDS_ENTRY_OTHER_PAYEE',
  'NO_FUND_OPENING',
  'BEFORE_FUND_OPENING',
  'GIFT_NO_AGENCY_FEE',
  'TDS_NOT_WITHHELD',
] as const;
export type OffPortalCategory = (typeof OFF_PORTAL_CATEGORIES)[number];

export const OFF_PORTAL_CATEGORY_LABEL: Record<OffPortalCategory, string> = {
  INVALID: 'Rows with errors — they will NOT be recorded',
  NEW_PAYEE:
    'Outlet IDs not on the portal — recorded as off-portal payees (their history links automatically when an outlet registers with the same Outlet ID)',
  NAME_DIFFERS: 'Outlet name in the file differs from the portal outlet — check the Outlet ID is the right outlet',
  PAN_MISMATCH: "PAN in the file differs from the portal PAN — TDS for these payments counts under the FILE's PAN",
  NO_PAN: 'No PAN in the file or on the portal — TDS at the no-PAN rate',
  FILE_PAN_ONLY:
    "PAN in the file, but the portal outlet's owner has NO PAN — these payments count under the FILE's PAN; the outlet's portal payouts keep counting under its no-PAN key (two separate yearly totals)",
  PORTAL_PAN_USED: "No PAN in the file — these payments count under the PAN the portal holds for the outlet's owner",
  DUPLICATE:
    'Looks like a repeat (same outlet, amount, payment date and UTR already recorded, or repeated in this file) — these WILL be recorded again',
  POSSIBLE_DUPLICATE:
    'Possible repeat — the same outlet was already paid the same amount within 3 days (different or no UTR) — these WILL be recorded',
  NO_FUND_OPENING:
    "This client has NO fund opening balance yet — EVERY payment below will be charged from the client's advance in Fund Reconciliation",
  GIFT_NO_AGENCY_FEE:
    'Gifts — no agency fee is charged on them in Fund Reconciliation (owner decision 2026-11-26: off-portal gifts carry no agency fee)',
  REPLACES_TDS_ENTRY:
    'Matches an earlier TDS off-platform entry (same outlet / PAN, amount and date) — the payment REPLACES that entry in the 194R base (never counted twice)',
  PAID_ON_PORTAL:
    'Matches a payout already PAID through the portal to this outlet (same UTR, or same amount on the same day) — recording it would count it twice',
  TDS_ENTRY_OTHER_PAYEE:
    'Matches an earlier TDS off-platform entry (same date and amount) recorded under a DIFFERENT payee — BOTH will count in 194R; correct one of them',
  BEFORE_FUND_OPENING:
    "Dated before the client's fund opening balance — NOT shown in Fund Reconciliation (already inside the opening figure)",
  TDS_NOT_WITHHELD:
    'The client is on the Deduct method — these were paid in full with NO TDS withheld. They count toward the yearly threshold, ' +
    'but NO TDS is ever withheld for them from later portal payouts: visibility TDS on them (with a PAN) is reported as a SHORTFALL; ' +
    'incentive / gift TDS is borne by the client (194R liability); 194C without a PAN is recovered from the client with the outlet\'s next portal payout run (not a shortfall)',
};

/** Owner decision 2026-11-26: a gross-up client's visibility (194C, TDS paid on top) must go through the portal. */
export const GROSS_UP_194C_REFUSED =
  "Visibility payouts for this client (194C, TDS paid on top) must be paid through the portal's payout flow, not recorded as off-portal.";

export interface AnalysedRow extends ParsedOffPortalRow {
  onPortal: boolean;
  /** The portal outlet's own spelling of the code (when on the portal). */
  portalOutletCode: string | null;
  portalOutletName: string | null;
  portalPan: string | null;
  panNumber: string | null;
  tdsSection: TdsSection;
  tdsMethodology: TdsMethodology;
  /** The TDS key the payment counts under (PAN, or a no-PAN owner / outlet key). */
  tdsKey: string;
  /** Plain words: how its TDS is treated (shown on the preview). */
  tdsTreatment: string;
  flags: OffPortalCategory[];
  notes: string[];
  supersedesOffPlatformEntryId: string | null;
}

export interface Analysis {
  sha256: string;
  rowsInFile: number;
  blankRows: number;
  rows: AnalysedRow[];
  invalid: Array<{ rowNumber: number; outletCode: string; outletName: string; errors: string[] }>;
  counts: Partial<Record<OffPortalCategory, number>>;
  totalPaise: bigint;
  policy: { section: TdsSection; methodology: TdsMethodology };
}

type Db = Prisma.TransactionClient;

const EXPORT_ROW_CAP = 50_000;
const CHUNK = 1000;

const chunks = <T>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const nameKey = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** The file's name "is" the portal outlet when it equals / contains (or is contained in) one of its names. */
export function namesAgree(fileName: string, portalNames: Array<string | null | undefined>): boolean {
  const f = nameKey(fileName);
  if (!f) return false;
  return portalNames.some((p) => {
    const k = nameKey(p);
    if (!k) return false;
    if (k === f) return true;
    const [short, long] = k.length < f.length ? [k, f] : [f, k];
    return short.length >= 4 && long.includes(short);
  });
}

export interface ListQuery {
  from?: string;
  to?: string;
  q?: string;
  stream?: 'INCENTIVE' | 'VISIBILITY';
  mode?: 'CASH' | 'GIFT';
  status?: 'ACTIVE' | 'VOIDED' | 'ALL';
  uploadId?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class OffPortalPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** Nav / screen hint: does this client have any off-portal payment? (Gifsy admins always see the screen.) */
  async presence(user: JwtPayload) {
    const clientId = this.readerClient(user);
    return { hasEntries: await clientHasOffPortalPayments(this.prisma, clientId), canWrite: user.role === 'GIFSY_ADMIN' && !!user.assumed };
  }

  // ── Guards ──────────────────────────────────────────────────────────────────────────────────

  /** Uploads + voids: a GIFSY_ADMIN working INSIDE a client (assumed). Returns that clientId. */
  writerClient(user: JwtPayload): string {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Only a Gifsy admin can record or void off-portal payments.');
    if (!user.assumed || !user.clientId || user.clientId === REPORTS_CLIENT_ID) {
      throw new BadRequestException('Open the client first (switch into the client from the Gifsy console) to record its off-portal payments.');
    }
    return user.clientId;
  }

  /** Register reads: the assumed Gifsy admin, or the client's own admin. */
  readerClient(user: JwtPayload): string {
    if (user.role !== 'GIFSY_ADMIN' && user.role !== 'CLIENT_ADMIN') throw new ForbiddenException('Forbidden');
    if (platformWide(user) || !user.clientId || user.clientId === REPORTS_CLIENT_ID) {
      throw new BadRequestException('Open a client first (switch into the client from the Gifsy console) to see its off-portal payments.');
    }
    return user.clientId;
  }

  template(): Buffer {
    return buildOffPortalTemplate();
  }

  // ── Analysis (shared by preview and confirm — confirm re-runs it INSIDE its transaction) ────────

  async analyse(db: Db, clientId: string, parsed: ParsedOffPortalFile, policy: { section: TdsSection; methodology: TdsMethodology }): Promise<Analysis> {
    const invalid = [...parsed.invalid];
    const keys = [...new Set(parsed.rows.map((r) => r.outletKey))];

    // Portal outlets of THIS client, case-insensitive on the code.
    const outletsByKey = new Map<string, Array<{ outletCode: string; name: string; partner: { id: string; panNumber: string | null; businessName: string | null; ownerName: string | null } | null }>>();
    for (const part of chunks(keys)) {
      const found = await db.outlet.findMany({
        where: { clientId, outletCode: { in: part, mode: 'insensitive' } },
        select: { outletCode: true, name: true, partner: { select: { id: true, panNumber: true, businessName: true, ownerName: true } } },
      });
      for (const o of found) {
        const k = outletKeyOf(o.outletCode);
        const list = outletsByKey.get(k) ?? [];
        list.push(o);
        outletsByKey.set(k, list);
      }
    }

    // Already-recorded (live) payments for these outlets → duplicate keys.
    const existing = new Map<string, string>();
    /** outletKey → recorded (live) payments, for the ±3-day "possible duplicate" check. */
    const existingByOutlet = new Map<string, Array<{ amountPaise: bigint; day: string }>>();
    for (const part of chunks(keys)) {
      const rows = await db.offPortalPayment.findMany({
        where: { clientId, voidedAt: null, outletCodeKey: { in: part } },
        select: { outletCodeKey: true, amountPaise: true, paymentDate: true, utr: true, createdAt: true },
      });
      for (const r of rows) {
        existing.set(
          duplicateKey({ outletKey: r.outletCodeKey, amountPaise: r.amountPaise, paymentDay: istDateKey(r.paymentDate), utr: r.utr }),
          istDateKey(r.createdAt),
        );
        existingByOutlet.set(r.outletCodeKey, [...(existingByOutlet.get(r.outletCodeKey) ?? []), { amountPaise: r.amountPaise, day: istDateKey(r.paymentDate) }]);
      }
    }

    // Legacy TDS off-platform marker rows (194R) in the file's date window, not already replaced by a live payment.
    const days = parsed.rows.map((r) => r.paymentDay).sort();
    const legacy: Array<{ id: string; day: string; panNumber: string; outletCode: string | null; amountPaise: bigint; resolvedKey: string | null }> = [];
    if (days.length) {
      const lo = new Date(parsed.rows.reduce((m, r) => (r.paymentDate < m ? r.paymentDate : m), parsed.rows[0].paymentDate).getTime() - 86_400_000);
      const hi = new Date(parsed.rows.reduce((m, r) => (r.paymentDate > m ? r.paymentDate : m), parsed.rows[0].paymentDate).getTime() + 2 * 86_400_000);
      const [cands, taken] = await Promise.all([
        db.tdsOffPlatformEntry.findMany({
          where: { clientId, section: 'SEC_194R', entryDate: { gte: lo, lt: hi } },
          select: { id: true, entryDate: true, panNumber: true, outletCode: true, amountPaise: true, resolvedKey: true },
        }),
        db.offPortalPayment.findMany({
          where: { clientId, voidedAt: null, supersedesOffPlatformEntryId: { not: null } },
          select: { supersedesOffPlatformEntryId: true },
        }),
      ]);
      const takenIds = new Set(taken.map((t) => t.supersedesOffPlatformEntryId));
      for (const c of cands) if (!takenIds.has(c.id)) legacy.push({ id: c.id, day: istDateKey(c.entryDate), panNumber: c.panNumber, outletCode: c.outletCode, amountPaise: c.amountPaise, resolvedKey: c.resolvedKey ?? null });
    }
    const legacyUsed = new Set<string>();

    // Payouts already PAID through the portal to these outlets in the file's window (credit / visibility payouts by
    // outlet code; cash redemptions by the outlet's owner) — a row matching one is flagged PAID_ON_PORTAL.
    const normUtr = (u: string) => u.replace(/\s/g, '').toUpperCase();
    const portalPaid = new Map<string, Array<{ amountPaise: bigint; day: string; utr: string | null }>>();
    if (parsed.rows.length) {
      const lo = new Date(Math.min(...parsed.rows.map((r) => r.paymentDate.getTime())) - 3 * 86_400_000);
      const hi = new Date(Math.max(...parsed.rows.map((r) => r.paymentDate.getTime())) + 4 * 86_400_000);
      const push = (k: string, v: { amountPaise: bigint; day: string; utr: string | null }) => portalPaid.set(k, [...(portalPaid.get(k) ?? []), v]);
      for (const part of chunks(keys)) {
        // PAID (by paid date) and PROCESSING (in a bank file, by the file's date) — both are portal payments.
        const paid = await db.creditPayoutEntry.findMany({
          where: {
            clientId,
            outletId: { in: part, mode: 'insensitive' },
            OR: [
              { status: 'PAID', paidAt: { gte: lo, lt: hi } },
              { status: 'PROCESSING', download: { downloadedAt: { gte: lo, lt: hi } } },
            ],
          },
          select: { outletId: true, amountPaise: true, paidAt: true, utr: true, status: true, download: { select: { downloadedAt: true } } },
        });
        for (const p of paid) {
          const at = p.paidAt ?? p.download?.downloadedAt;
          if (!at) continue;
          push(outletKeyOf(p.outletId), { amountPaise: p.amountPaise, day: istDateKey(at), utr: p.status === 'PAID' ? p.utr : null });
        }
      }
      const ownerToKeys = new Map<string, string[]>();
      for (const [k, list] of outletsByKey) for (const o of list) if (o.partner) ownerToKeys.set(o.partner.id, [...(ownerToKeys.get(o.partner.id) ?? []), k]);
      for (const part of chunks([...ownerToKeys.keys()])) {
        const txns = await db.payoutTransaction.findMany({
          where: { partnerId: { in: part }, status: 'SUCCESS', completedAt: { gte: lo, lt: hi }, partner: { clientId } },
          select: { partnerId: true, amountPaise: true, completedAt: true, providerRefId: true },
        });
        for (const t of txns) for (const k of ownerToKeys.get(t.partnerId) ?? []) push(k, { amountPaise: t.amountPaise, day: istDateKey(t.completedAt!), utr: t.providerRefId });
      }
    }

    const opening = await db.fundReceipt.findFirst({ where: { clientId, entryType: 'OPENING_BALANCE' }, select: { receivedAt: true } });

    const seenInFile = new Map<string, number>();
    const seenNear = new Map<string, Array<{ amountPaise: bigint; day: string; row: number }>>();
    const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
    const rows: AnalysedRow[] = [];
    for (const r of parsed.rows) {
      const matches = outletsByKey.get(r.outletKey) ?? [];
      if (matches.length > 1) {
        invalid.push({
          rowNumber: r.rowNumber,
          outletCode: r.outletCode,
          outletName: r.outletName,
          errors: [`Outlet ID "${r.outletCode}" matches ${matches.length} portal outlets that differ only in upper / lower case — fix the outlet codes first`],
        });
        continue;
      }
      const o = matches[0] ?? null;
      const portalPan = o?.partner && !isNoPanCell(o.partner.panNumber) ? normalisePan(o.partner.panNumber!) : null;
      const panNumber = r.filePan ?? portalPan;
      const tdsSection: TdsSection = r.payoutStream === 'INCENTIVE' ? 'SEC_194R' : policy.section;
      const flags: OffPortalCategory[] = [];
      const notes: string[] = [];
      if (!o) flags.push('NEW_PAYEE');
      if (o && !namesAgree(r.outletName, [o.name, o.partner?.businessName, o.partner?.ownerName])) {
        flags.push('NAME_DIFFERS');
        notes.push(`Portal outlet is "${o.name}"`);
      }
      // TDS key — the SAME resolution the portal uses for this outlet now: the PAN (file, else the portal owner's),
      // else the owner's no-PAN key, else the outlet's own no-PAN key (not on the portal / no owner).
      const tdsKey = panNumber ?? offPortalNoPanKey(clientId, r.outletCode, o ? { outletCode: o.outletCode, partnerId: o.partner?.id ?? null } : null);
      const keyWords = panNumber ? `PAN ${panNumber}` : o?.partner ? "the owner's no-PAN key" : "this Outlet ID's no-PAN key";
      if (r.filePan && portalPan && r.filePan !== portalPan) {
        flags.push('PAN_MISMATCH');
        notes.push(`File PAN ${r.filePan} · portal PAN ${portalPan} — counts under ${r.filePan}`);
      }
      if (r.filePan && o?.partner && !portalPan) {
        flags.push('FILE_PAN_ONLY');
        notes.push(`Counts under file PAN ${r.filePan}; the outlet's portal payouts count under its no-PAN key`);
      }
      if (!r.filePan && portalPan) {
        flags.push('PORTAL_PAN_USED');
        notes.push(`Counts under portal PAN ${portalPan}`);
      }
      if (!panNumber) {
        flags.push('NO_PAN');
        notes.push(`Counts under ${keyWords} (no-PAN rate)`);
      }
      const dk = duplicateKey(r);
      if (existing.has(dk)) {
        flags.push('DUPLICATE');
        notes.push(`Same payment already recorded (on ${existing.get(dk)})`);
      } else if (seenInFile.has(dk)) {
        flags.push('DUPLICATE');
        notes.push(`Repeats row ${seenInFile.get(dk)} of this file`);
      } else {
        // Same outlet + amount within ±3 days (UTR differs or is blank) — recorded earlier or earlier in this file.
        const near = [...(existingByOutlet.get(r.outletKey) ?? []), ...(seenNear.get(r.outletKey) ?? [])].find(
          (x) => x.amountPaise === r.amountPaise && dayGap(x.day, r.paymentDay) <= 3,
        );
        if (near) {
          flags.push('POSSIBLE_DUPLICATE');
          notes.push(`Same amount to this outlet on ${near.day}${'row' in near ? ` (row ${near.row} of this file)` : ' (already recorded)'}`);
        }
      }
      if (!seenInFile.has(dk)) seenInFile.set(dk, r.rowNumber);
      seenNear.set(r.outletKey, [...(seenNear.get(r.outletKey) ?? []), { amountPaise: r.amountPaise, day: r.paymentDay, row: r.rowNumber }]);
      let supersedes: string | null = null;
      if (tdsSection === 'SEC_194R') {
        const hit = legacy.find(
          (l) =>
            !legacyUsed.has(l.id) &&
            l.day === r.paymentDay &&
            l.amountPaise === r.amountPaise &&
            ((l.outletCode && outletKeyOf(l.outletCode) === r.outletKey) || (!isNoPanCell(l.panNumber) && panNumber && normalisePan(l.panNumber) === panNumber)),
        );
        if (hit) {
          // Replace ONLY when the legacy entry counts under the SAME payee key as this payment — otherwise the base
          // would silently move from one PAN to another. A same-benefit entry under another payee is flagged instead
          // (both keep counting until someone fixes one of them).
          const payKey = tdsKey;
          const legacyKey = hit.resolvedKey
            ? retailerKeyOfLedgerPan(hit.resolvedKey)
            : !isNoPanCell(hit.panNumber)
              ? normalisePan(hit.panNumber)
              : payKey; // a no-PAN marker on this outlet → this outlet's key
          legacyUsed.add(hit.id);
          if (legacyKey === payKey) {
            supersedes = hit.id;
            flags.push('REPLACES_TDS_ENTRY');
          } else {
            flags.push('TDS_ENTRY_OTHER_PAYEE');
            notes.push(
              `An earlier TDS off-platform entry for the same date and amount counts under ${isNoPanKey(legacyKey) ? 'a no-PAN key' : `PAN ${legacyKey}`}` +
                ` — this payment counts under ${isNoPanKey(payKey) ? 'a no-PAN key' : `PAN ${payKey}`}; BOTH will count`,
            );
          }
        }
      }
      // Already paid THROUGH the portal (same outlet; same UTR, or the same amount within ±3 days — PAID or in a bank
      // file) → recording it would count it twice.
      const portalHit = (portalPaid.get(r.outletKey) ?? []).find(
        (p) => (r.utr && p.utr && normUtr(p.utr) === normUtr(r.utr)) || (p.amountPaise === r.amountPaise && dayGap(p.day, r.paymentDay) <= 3),
      );
      if (portalHit) {
        flags.push('PAID_ON_PORTAL');
        notes.push(`A portal payout of ${formatINR(portalHit.amountPaise)} on ${portalHit.day}${portalHit.utr ? ` (UTR ${portalHit.utr})` : ''} matches`);
      }
      if (!opening) flags.push('NO_FUND_OPENING');
      else if (r.paymentDate < opening.receivedAt) flags.push('BEFORE_FUND_OPENING');
      if (r.paymentMode === 'GIFT') flags.push('GIFT_NO_AGENCY_FEE');
      // How its TDS is treated. 194R: incentive and every gift are CLIENT-BORNE (gross-up) whatever the visibility
      // method; only 194R visibility cash follows the client's method. 194C follows the client's method.
      const tdsMethodology: TdsMethodology =
        tdsSection === 'SEC_194R' && (r.payoutStream === 'INCENTIVE' || r.paymentMode === 'GIFT') ? 'GROSS_UP' : policy.methodology;
      let tdsTreatment: string;
      if (tdsSection === 'SEC_194R') {
        tdsTreatment =
          tdsMethodology === 'DEDUCT'
            ? `194R · Deduct: counts toward the threshold; TDS NOT withheld — shortfall (never withheld from later payouts) · ${keyWords}`
            : `194R · borne by the client (gross-up) · ${keyWords}`;
      } else {
        // 194C rows are always Deduct here (a gross-up client's visibility is refused — owner 2026-11-26).
        tdsTreatment = panNumber
          ? `194C · Deduct: counts toward the threshold; TDS NOT withheld — shortfall (never withheld from later payouts) · ${keyWords}`
          : `194C · no PAN: never withheld; recovered from the client with this outlet's next portal payout run (not a shortfall) · ${keyWords}`;
      }
      if (policy.methodology === 'DEDUCT') flags.push('TDS_NOT_WITHHELD');
      rows.push({
        ...r,
        onPortal: !!o,
        portalOutletCode: o?.outletCode ?? null,
        portalOutletName: o?.name ?? null,
        portalPan,
        panNumber,
        tdsSection,
        tdsMethodology,
        tdsKey,
        tdsTreatment,
        flags,
        notes,
        supersedesOffPlatformEntryId: supersedes,
      });
    }

    const counts: Partial<Record<OffPortalCategory, number>> = {};
    if (invalid.length) counts.INVALID = invalid.length;
    for (const r of rows) for (const f of r.flags) counts[f] = (counts[f] ?? 0) + 1;
    invalid.sort((a, b) => a.rowNumber - b.rowNumber);
    return {
      sha256: parsed.sha256,
      rowsInFile: parsed.rowsInFile,
      blankRows: parsed.blankRows,
      rows,
      invalid,
      counts,
      totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0n),
      policy,
    };
  }

  /**
   * Owner decision 2026-11-26: a client whose visibility is 194C on GROSS-UP (TDS paid on top by Gifsy and invoiced to
   * the client) must pay visibility through the portal's payout flow — such rows are never recorded off-portal. The
   * WHOLE file is refused, listing every such row.
   */
  private refuseGrossUp194C(parsed: ParsedOffPortalFile, policy: { section: TdsSection; methodology: TdsMethodology }): void {
    if (!(policy.section === 'SEC_194C' && policy.methodology === 'GROSS_UP')) return;
    const bad = parsed.rows.filter((r) => r.payoutStream === 'VISIBILITY').map((r) => r.rowNumber);
    if (!bad.length) return;
    throw new BadRequestException({
      message: `${GROSS_UP_194C_REFUSED} Rows: ${bad.join(', ')}. Nothing was recorded.`,
      details: { refusedRows: bad, reason: 'GROSS_UP_194C_VISIBILITY' },
    });
  }
  private presentCategories(a: Analysis): OffPortalCategory[] {
    return OFF_PORTAL_CATEGORIES.filter((c) => (a.counts[c] ?? 0) > 0);
  }

  private parseOrThrow(file: Express.Multer.File | undefined): ParsedOffPortalFile {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
    const parsed = parseOffPortalFile(file.buffer);
    if (parsed.fileError) throw new BadRequestException(parsed.fileError);
    return parsed;
  }

  /** The preview the screen shows — Gifsy admins only, so values are unmasked. */
  private previewBody(a: Analysis) {
    const categories = this.presentCategories(a).map((c) => ({ category: c, label: OFF_PORTAL_CATEGORY_LABEL[c], count: a.counts[c] ?? 0 }));
    // EVERY row (uncapped — a file is at most MAX_ROWS rows): the screen groups the warned rows by category and pages them.
    const rows = a.rows.map((r) => ({
      rowNumber: r.rowNumber,
      outletCode: r.outletCode,
      outletName: r.outletName,
      onPortal: r.onPortal,
      portalOutletName: r.portalOutletName,
      amountPaise: r.amountPaise.toString(),
      paymentDate: r.paymentDay,
      period: r.period,
      payoutStream: r.payoutStream,
      paymentMode: r.paymentMode,
      utr: r.utr,
      panNumber: r.panNumber,
      panSource: r.filePan ? 'FILE' : r.portalPan ? 'PORTAL' : 'NONE',
      tdsSection: r.tdsSection === 'SEC_194R' ? '194R' : '194C',
      tdsMethodology: r.tdsMethodology,
      tdsKey: r.tdsKey,
      tdsTreatment: r.tdsTreatment,
      flags: r.flags,
      notes: r.notes,
    }));
    return {
      fileSha256: a.sha256,
      rowsInFile: a.rowsInFile,
      blankRows: a.blankRows,
      recordableCount: a.rows.length,
      recordableTotalPaise: a.totalPaise.toString(),
      invalidCount: a.invalid.length,
      tdsPolicy: { visibilitySection: a.policy.section === 'SEC_194R' ? '194R' : '194C', methodology: a.policy.methodology },
      categories,
      requiredAcknowledgements: categories.map((c) => c.category),
      invalid: a.invalid,
      invalidTruncated: false,
      rows,
      rowsTruncated: false,
    };
  }

  async preview(user: JwtPayload, file: Express.Multer.File | undefined) {
    const clientId = this.writerClient(user);
    const parsed = this.parseOrThrow(file);
    const policy = await this.tenantSettings.resolveTdsPolicy(clientId);
    this.refuseGrossUp194C(parsed, policy);
    const a = await this.analyse(this.prisma, clientId, parsed, policy);
    return this.previewBody(a);
  }

  async confirm(
    user: JwtPayload,
    file: Express.Multer.File | undefined,
    body: { fileSha256?: string; acknowledged?: string[] | string },
  ) {
    const clientId = this.writerClient(user);
    const parsed = this.parseOrThrow(file);
    if (!body.fileSha256 || body.fileSha256 !== parsed.sha256) {
      throw new BadRequestException('This is not the file that was previewed (or it changed since). Preview it again before confirming.');
    }
    const ackRaw = Array.isArray(body.acknowledged) ? body.acknowledged : typeof body.acknowledged === 'string' ? body.acknowledged.split(',') : [];
    const acked = new Set(ackRaw.map((s) => s.trim()).filter(Boolean));
    const policy = await this.tenantSettings.resolveTdsPolicy(clientId);
    this.refuseGrossUp194C(parsed, policy);

    const fileKey = this.storage.generateKey(`off-portal-payments/${clientId}`, file!.originalname || 'off-portal-payments.xlsx');
    await this.storage.uploadFile(file!.buffer, fileKey, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'off-portal-payments:' + clientId}))`;
          const a = await this.analyse(tx, clientId, parsed, policy);
          const present = this.presentCategories(a);
          const missing = present.filter((c) => !acked.has(c));
          if (missing.length) {
            throw new BadRequestException({
              // `details` is what the global error filter passes through to the browser.
              details: { missingAcknowledgements: missing },
              message: `Tick every warning before confirming — not ticked: ${missing.map((c) => `${OFF_PORTAL_CATEGORY_LABEL[c]} (${a.counts[c]})`).join('; ')}. Nothing was recorded.`,
              missingAcknowledgements: missing,
            });
          }
          if (a.rows.length === 0) throw new BadRequestException('No row in the file can be recorded. Nothing was recorded.');
          const acknowledged = Object.fromEntries(present.map((c) => [c, a.counts[c] ?? 0]));
          const upload = await tx.offPortalPaymentUpload.create({
            data: {
              clientId,
              fileName: (file!.originalname || 'off-portal-payments.xlsx').slice(0, 255),
              fileKey,
              fileSha256: a.sha256,
              rowsInFile: a.rowsInFile,
              recordedCount: a.rows.length,
              skippedCount: a.invalid.length,
              totalPaise: a.totalPaise,
              acknowledged,
              uploadedById: user.sub,
            },
          });
          for (const part of chunks(a.rows, 500)) {
            await tx.offPortalPayment.createMany({
              data: part.map((r) => ({
                clientId,
                uploadId: upload.id,
                rowNumber: r.rowNumber,
                outletCode: r.portalOutletCode ?? r.outletCode,
                outletCodeKey: r.outletKey,
                outletName: r.outletName,
                onPortalAtUpload: r.onPortal,
                phone: r.phone,
                filePan: r.filePan,
                portalPan: r.portalPan,
                panNumber: r.panNumber,
                bankAccountNumber: r.bankAccountNumber,
                ifsc: r.ifsc,
                upiId: r.upiId,
                amountPaise: r.amountPaise,
                paymentDate: r.paymentDate,
                utr: r.utr,
                payoutStream: r.payoutStream,
                paymentMode: r.paymentMode,
                period: r.period,
                narration: r.narration,
                tdsSection: r.tdsSection,
                tdsMethodology: r.tdsMethodology,
                flags: r.flags,
                supersedesOffPlatformEntryId: r.supersedesOffPlatformEntryId,
                createdById: user.sub,
              })),
            });
          }
          // Off-portal payees: the latest details per Outlet ID that is not on the portal.
          const payees = new Map<string, AnalysedRow>();
          for (const r of a.rows) if (!r.onPortal) payees.set(r.outletKey, r);
          if (payees.size) {
            const have = new Set<string>();
            for (const part of chunks([...payees.keys()])) {
              const found = await tx.offPortalPayee.findMany({ where: { clientId, outletCodeKey: { in: part } }, select: { outletCodeKey: true } });
              for (const f of found) have.add(f.outletCodeKey);
            }
            const details = (r: AnalysedRow) => ({
              outletCode: r.outletCode,
              name: r.outletName,
              phone: r.phone,
              panNumber: r.filePan,
              bankAccountNumber: r.bankAccountNumber,
              ifsc: r.ifsc,
              upiId: r.upiId,
            });
            const fresh = [...payees.values()].filter((r) => !have.has(r.outletKey));
            for (const part of chunks(fresh, 500)) {
              await tx.offPortalPayee.createMany({
                data: part.map((r) => ({ clientId, outletCodeKey: r.outletKey, createdById: user.sub, ...details(r) })),
                skipDuplicates: true,
              });
            }
            for (const r of [...payees.values()].filter((x) => have.has(x.outletKey))) {
              // Keep earlier details where this file leaves a column blank.
              const d = details(r);
              const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== ''));
              await tx.offPortalPayee.update({ where: { clientId_outletCodeKey: { clientId, outletCodeKey: r.outletKey } }, data });
            }
          }
          await tx.auditLog.create({
            data: {
              action: 'IMPORT',
              entityType: 'OFF_PORTAL_PAYMENT_UPLOAD',
              entityId: upload.id,
              actorId: user.sub,
              newValues: {
                clientId,
                recorded: a.rows.length,
                skippedInvalid: a.invalid.length,
                totalPaise: a.totalPaise.toString(),
                fileSha256: a.sha256,
                acknowledged,
              },
              metadata: { action: 'off_portal_payments_upload', tdsPolicy: { section: policy.section, methodology: policy.methodology } },
            },
          });
          invalidateOffPortalPresence(clientId);
          return {
            uploadId: upload.id,
            recorded: a.rows.length,
            recordedTotalPaise: a.totalPaise.toString(),
            skippedInvalid: a.invalid.length,
            acknowledged,
            message:
              `Recorded ${a.rows.length} off-portal payment${a.rows.length === 1 ? '' : 's'} (${formatINR(a.totalPaise)})` +
              (a.invalid.length ? `; ${a.invalid.length} row${a.invalid.length === 1 ? '' : 's'} with errors NOT recorded` : '') +
              '.',
          };
        },
        { timeout: 120_000, maxWait: 15_000 },
      );
    } catch (e) {
      await this.storage.deleteFile(fileKey).catch(() => undefined);
      throw e;
    }
  }

  // ── Void ───────────────────────────────────────────────────────────────────────────────────

  async void(user: JwtPayload, id: string, reasonRaw: string | undefined) {
    const clientId = this.writerClient(user);
    const reason = (reasonRaw ?? '').trim();
    if (reason.length < 5) throw new BadRequestException('Give a reason for voiding (at least 5 characters).');
    if (reason.length > 500) throw new BadRequestException('Reason is longer than 500 characters.');
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.offPortalPayment.findFirst({
        where: { id, clientId },
        select: {
          id: true, voidedAt: true, amountPaise: true, paymentDate: true, outletCode: true, uploadId: true, supersedesOffPlatformEntryId: true,
          panNumber: true, tdsSection: true, outletCodeKey: true, period: true,
        },
      });
      if (!p) throw new NotFoundException('Off-portal payment not found.');
      if (p.voidedAt) throw new ConflictException('This off-portal payment is already void.');
      // TDS already WITHHELD (on portal payouts) from the SAME payee key in the same FY — matched exactly as the ledger
      // keys it (retailerKeyOfLedgerPan; 194R per client by payment-date FY, 194C per PAN by payout-period FY). Off-portal
      // amounts never drive withholding, so the void never "gives back" TDS; it can lower the year's TDS due, which the
      // next payout run nets against what was already withheld. Said, never silent.
      let withheldPaise = 0n;
      if (p.tdsSection === 'SEC_194R') {
        let key = p.panNumber ? normalisePan(p.panNumber) : null;
        if (!key) {
          const o = await tx.outlet.findFirst({
            where: { clientId, outletCode: { equals: p.outletCodeKey, mode: 'insensitive' } },
            select: { outletCode: true, partnerId: true },
          });
          key = offPortalNoPanKey(clientId, p.outletCode, o);
        }
        const rows = await tx.tdsDeductionEntry.findMany({
          where: { clientId, section: 'SEC_194R', fyLabel: financialYear(p.paymentDate).fyLabel },
          select: { panNumber: true, tdsDeductedThisPaise: true },
        });
        for (const r of rows) if (r.panNumber?.trim() && retailerKeyOfLedgerPan(r.panNumber) === key) withheldPaise += r.tdsDeductedThisPaise;
      } else if (p.panNumber) {
        const pan = normalisePan(p.panNumber);
        const rows = await tx.tdsDeductionEntry.findMany({
          where: { section: 'SEC_194C', fyLabel: fyLabelForPeriod(p.period), panNumber: { equals: pan, mode: 'insensitive' } },
          select: { panNumber: true, tdsDeductedThisPaise: true },
        });
        for (const r of rows) if (r.panNumber && normalisePan(r.panNumber) === pan) withheldPaise += r.tdsDeductedThisPaise;
      }
      const withheld = withheldPaise > 0n;
      const now = new Date();
      const res = await tx.offPortalPayment.updateMany({
        where: { id, clientId, voidedAt: null },
        data: { voidedAt: now, voidedById: user.sub, voidReason: reason },
      });
      if (res.count !== 1) throw new ConflictException('This off-portal payment is already void.');
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'OFF_PORTAL_PAYMENT',
          entityId: p.id,
          actorId: user.sub,
          oldValues: { voidedAt: null },
          newValues: {
            clientId,
            tdsWithheldThisFyPaise: withheldPaise.toString(),
            voidedAt: now.toISOString(),
            reason,
            amountPaise: p.amountPaise.toString(),
            paymentDate: istDateKey(p.paymentDate),
            uploadId: p.uploadId,
            releasedOffPlatformEntryId: p.supersedesOffPlatformEntryId,
          },
          metadata: { action: 'off_portal_payment_void' },
        },
      });
      return {
        id: p.id,
        voidedAt: now.toISOString(),
        message:
          `Voided ${formatINR(p.amountPaise)} paid on ${istDateKey(p.paymentDate)}: it no longer counts in TDS, payout history or the payments report; ` +
          'Fund Reconciliation shows it returned today.' +
          (p.supersedesOffPlatformEntryId ? ' The earlier TDS off-platform entry it replaced counts again.' : '') +
          (withheld
            ? ` NOTE: ${formatINR(withheldPaise)} TDS was already withheld (${p.tdsSection === 'SEC_194R' ? '194R' : '194C'}) from this payee's portal payouts this financial year — it stays deposited. ` +
              "This void can lower the year's TDS due (e.g. back below the threshold): the next payout run nets that against what was already withheld, " +
              'and any part that is never needed is flagged as "TDS taken in excess" in the TDS report (no automatic refund).'
            : ''),
      };
    });
  }

  // ── Register (list / export / uploads) ───────────────────────────────────────────────────────

  private listWhere(clientId: string, q: ListQuery): Prisma.OffPortalPaymentWhereInput {
    const where: Prisma.OffPortalPaymentWhereInput = { clientId };
    const status = q.status ?? 'ACTIVE';
    if (status === 'ACTIVE') where.voidedAt = null;
    else if (status === 'VOIDED') where.voidedAt = { not: null };
    const range = istDayRangeFilter(q.from, q.to);
    if (range) where.paymentDate = range;
    if (q.stream) where.payoutStream = q.stream;
    if (q.mode) where.paymentMode = q.mode;
    if (q.uploadId) where.uploadId = q.uploadId;
    const s = q.q?.trim();
    if (s) {
      where.OR = [
        { outletCode: { contains: s, mode: 'insensitive' } },
        { outletName: { contains: s, mode: 'insensitive' } },
        { utr: { contains: s, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  private shape(
    p: OffPortalPayment,
    unmasked: boolean,
    onPortalNow: boolean,
  ) {
    return {
      id: p.id,
      uploadId: p.uploadId,
      rowNumber: p.rowNumber,
      outletCode: p.outletCode,
      outletName: p.outletName,
      onPortalAtUpload: p.onPortalAtUpload,
      onPortalNow,
      phone: unmasked ? p.phone : maskTail(p.phone),
      panNumber: unmasked ? p.panNumber : maskPanValue(p.panNumber),
      panSource: p.filePan ? 'FILE' : p.portalPan ? 'PORTAL' : 'NONE',
      bankAccountNumber: unmasked ? p.bankAccountNumber : maskTail(p.bankAccountNumber),
      ifsc: p.ifsc,
      upiId: unmasked ? p.upiId : maskUpi(p.upiId),
      amountPaise: p.amountPaise.toString(),
      paymentDate: istDateKey(p.paymentDate),
      utr: p.utr,
      payoutStream: p.payoutStream,
      paymentMode: p.paymentMode,
      period: p.period,
      narration: p.narration,
      tdsSection: p.tdsSection === 'SEC_194R' ? '194R' : '194C',
      tdsMethodology: p.tdsMethodology,
      flags: Array.isArray(p.flags) ? p.flags : [],
      replacesTdsEntry: !!p.supersedesOffPlatformEntryId,
      voidedAt: p.voidedAt ? p.voidedAt.toISOString() : null,
      voidReason: p.voidReason,
      createdAt: p.createdAt.toISOString(),
    };
  }

  private async onPortalKeys(clientId: string, keys: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks([...new Set(keys)])) {
      if (!part.length) continue;
      const found = await this.prisma.outlet.findMany({
        where: { clientId, outletCode: { in: part, mode: 'insensitive' } },
        select: { outletCode: true },
      });
      for (const o of found) out.add(outletKeyOf(o.outletCode));
    }
    return out;
  }

  async list(user: JwtPayload, q: ListQuery) {
    const clientId = this.readerClient(user);
    const unmasked = user.role === 'GIFSY_ADMIN';
    const where = this.listWhere(clientId, q);
    const pageSize = Math.min(200, Math.max(1, Math.floor(q.pageSize ?? 50)));
    const [agg, liveAgg] = await Promise.all([
      this.prisma.offPortalPayment.aggregate({ where, _count: { _all: true }, _sum: { amountPaise: true } }),
      this.prisma.offPortalPayment.aggregate({ where: { ...where, voidedAt: null }, _count: { _all: true }, _sum: { amountPaise: true } }),
    ]);
    const total = agg._count?._all ?? 0;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.floor(q.page ?? 1)), lastPage);
    const rows = await this.prisma.offPortalPayment.findMany({
      where,
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const portal = await this.onPortalKeys(clientId, rows.map((r) => r.outletCodeKey));
    return {
      page,
      pageSize,
      totalRows: total,
      totalPages: Math.ceil(total / pageSize),
      totals: {
        count: total,
        amountPaise: (agg._sum?.amountPaise ?? 0n).toString(),
        liveCount: liveAgg._count?._all ?? 0,
        liveAmountPaise: (liveAgg._sum?.amountPaise ?? 0n).toString(),
      },
      piiMasked: !unmasked,
      canWrite: user.role === 'GIFSY_ADMIN' && !!user.assumed,
      rows: rows.map((r) => this.shape(r, unmasked, portal.has(r.outletCodeKey))),
    };
  }

  async exportXlsx(user: JwtPayload, q: ListQuery): Promise<{ buffer: Buffer; filename: string }> {
    const clientId = this.readerClient(user);
    const unmasked = user.role === 'GIFSY_ADMIN';
    const where = this.listWhere(clientId, q);
    const count = await this.prisma.offPortalPayment.count({ where });
    if (count > EXPORT_ROW_CAP) {
      throw new BadRequestException(`${count} rows match — the export limit is ${EXPORT_ROW_CAP}. Narrow the date range and export in parts.`);
    }
    const rows = await this.prisma.offPortalPayment.findMany({ where, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    const portal = await this.onPortalKeys(clientId, rows.map((r) => r.outletCodeKey));
    const sheetRows = rows.map((r, i) => {
      const s = this.shape(r, unmasked, portal.has(r.outletCodeKey));
      return {
        'S.No': i + 1,
        'Outlet ID': s.outletCode,
        'Outlet name': s.outletName,
        'On portal now': s.onPortalNow ? 'Yes' : 'No',
        Phone: s.phone ?? '',
        PAN: s.panNumber ?? '',
        'PAN from': s.panSource === 'FILE' ? 'File' : s.panSource === 'PORTAL' ? 'Portal' : 'None (no-PAN rate)',
        'Bank account no.': s.bankAccountNumber ?? '',
        IFSC: s.ifsc ?? '',
        'UPI ID': s.upiId ?? '',
        'Amount (₹)': Number(r.amountPaise) / 100,
        'Payment date': s.paymentDate,
        'UTR / reference': s.utr ?? '',
        'Payment type': r.payoutStream === 'INCENTIVE' ? 'Incentive' : 'Visibility',
        'Cash or Gift': r.paymentMode === 'CASH' ? 'Cash' : 'Gift',
        Month: s.period,
        Narration: s.narration ?? '',
        'TDS section': s.tdsSection,
        // B6: "not withheld — shortfall" only on rows that carry TDS_NOT_WITHHELD and are on the Deduct method.
        // #4: a no-PAN 194C payment is recovered from the client with the outlet's next portal run — not a shortfall.
        'TDS method':
          r.tdsMethodology === 'DEDUCT'
            ? r.tdsSection === 'SEC_194C' && !r.panNumber
              ? 'Deduct — no PAN: recovered from the client (not a shortfall)'
              : (s.flags as string[]).includes('TDS_NOT_WITHHELD')
                ? 'Deduct — TDS not withheld (shortfall)'
                : 'Deduct'
            : 'Borne by the client (gross-up)',
        Warnings: (s.flags as string[]).map((f) => OFF_PORTAL_CATEGORY_LABEL[f as OffPortalCategory] ?? f).join(' | '),
        Status: s.voidedAt ? 'VOID' : 'Recorded',
        'Void reason': s.voidReason ?? '',
        'Recorded at': istDateKey(r.createdAt),
      };
    });
    const live = rows.filter((r) => !r.voidedAt);
    const summary = [
      { Field: 'Rows', Value: rows.length },
      { Field: 'Recorded (not void) — count', Value: live.length },
      { Field: 'Recorded (not void) — amount (₹)', Value: Number(live.reduce((s, r) => s + r.amountPaise, 0n)) / 100 },
      { Field: 'Phone / PAN / bank / UPI', Value: unmasked ? 'Shown in full (Gifsy admin)' : 'Masked' },
    ];
    await this.prisma.auditLog.create({
      data: {
        action: 'EXPORT',
        entityType: 'OFF_PORTAL_PAYMENT',
        entityId: clientId,
        actorId: user.sub,
        metadata: { action: 'off_portal_payments_export', rows: rows.length, masked: !unmasked },
      },
    });
    return {
      buffer: buildXlsx([
        { name: 'Off-portal payments', rows: sheetRows },
        { name: 'Summary', rows: summary },
      ]),
      filename: `off-portal-payments-${clientId}.xlsx`,
    };
  }

  async uploads(user: JwtPayload) {
    const clientId = this.readerClient(user);
    const ups = await this.prisma.offPortalPaymentUpload.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // B8: voided rows per upload → "Recorded N · voided M · counting N − M".
    const voided = ups.length
      ? await this.prisma.offPortalPayment.groupBy({
          by: ['uploadId'],
          where: { clientId, uploadId: { in: ups.map((u) => u.id) }, voidedAt: { not: null } },
          _count: { _all: true },
          _sum: { amountPaise: true },
        })
      : [];
    const voidedOf = new Map(voided.map((v) => [v.uploadId, { count: v._count?._all ?? 0, paise: v._sum?.amountPaise ?? 0n }]));
    const userIds = [...new Set(ups.map((u) => u.uploadedById))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return ups.map((u) => ({
      id: u.id,
      fileName: u.fileName,
      rowsInFile: u.rowsInFile,
      recordedCount: u.recordedCount,
      skippedCount: u.skippedCount,
      totalPaise: u.totalPaise.toString(),
      voidedCount: voidedOf.get(u.id)?.count ?? 0,
      voidedPaise: (voidedOf.get(u.id)?.paise ?? 0n).toString(),
      countingCount: u.recordedCount - (voidedOf.get(u.id)?.count ?? 0),
      countingPaise: (u.totalPaise - (voidedOf.get(u.id)?.paise ?? 0n)).toString(),
      acknowledged: u.acknowledged,
      uploadedBy: nameOf.get(u.uploadedById) ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }
}
