/**
 * Bajaj payout tracker — DATA COLLECTOR. Builds the TrackerInput (payout-tracker.types.ts) for one tenant × month from
 * Prisma (outlet master, targets, sales, KYC approval, sales chain, visibility) + the points engine's READ-ONLY preview
 * (PointsComputeService.previewCompute — the same unguarded call the Compute page preview uses). It never re-implements
 * a rule: every ₹ / point comes from an engine row.
 *
 * Refusals (thrown, never a silent 0):
 *   - malformed / future month;
 *   - no points-engine first live month set for the tenant (could not tell imported months from live ones);
 *   - a month before the tenant's points-engine first live month (imported from the old system) — checked BEFORE any
 *     compute, and again on the engine's own `importedMonths` flag;
 *   - the points engine switched OFF (preview-only figures are money-critical — never sent);
 * HELD BACK, not refused (owner 2026-11-27) — PER-OUTLET rule / config problems: an ERROR engine row (monthly or
 * quarterly), an OK row on a KPI the tracker has no column for, an award type that does not fit the programme (₹ PAYOUT
 * for Unnati / SAMT, POINTS for BSC), SAMT paying on ADHO / NON ADHO / FB, an Unnati TOTAL rule that is not the
 * visibility rule (identified from the RULE's inputs), or a visibility-reading rule with no visibility data. The outlet
 * is left OFF TrackerInput.outlets (so rows / summary / totals exclude it); a client note gives the count only and an
 * ops note per outlet names its programme + the exact problem (KPI / rule / engine text). The report still goes out.
 * Anything left off the report, paid 0 for want of a rule, or not computed (unknown outlet codes, NO_RULE / SKIP rows,
 * outlets the engine said nothing about, chain cycles, quarter bonus not computed, visibility still pending) is
 * returned in `notes` so the caller prints it — never dropped silently.
 *
 * Performance: one query per entity type (no per-outlet query); ~7,000 outlets.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PointsComputeService } from '../../points-engine/points-compute.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { parseQuarter, quarterKeyForMonth } from '../../points-engine/points-engine.quarter';
import { isVisibilityInput } from '../../points-engine/points-engine.helper';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type { ComputePreview, ComputePreviewRow } from '../../points-engine/points-compute.types';
import { KPI, type ChainLink, type OutletInput, type PartResult, type TrackerInput, type TrackerNote, type VisStatus } from './payout-tracker.types';

/** Kept as an alias — TrackerInput itself now carries the loud `notes` (About sheet + email "Data notes"). */
export type TrackerBuild = TrackerInput;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MAX_CHAIN_DEPTH = 8;
const NAMES_KEY = '__names';
const LIST_MAX = 20;

type RlpPart = keyof NonNullable<OutletInput['payout']>;
type Route = 'RLP_UNNATI' | 'RLP_SAMT' | 'BSC' | null;

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

function routeOf(program: string | null | undefined): Route {
  const p = norm(program);
  if (p === 'unnati') return 'RLP_UNNATI';
  if (p === 'samt') return 'RLP_SAMT';
  if (p === 'bsc') return 'BSC';
  return null;
}

function monthLong(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_LONG[m - 1]} ${y}`;
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function istMonthKey(d: Date): string {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

function istDayLabel(d: Date): string {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return `${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** A stored KPI value → number | null (numeric strings accepted; blank / non-numeric = null). */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function kpiMap(json: unknown): Partial<Record<string, number | null>> {
  const out: Partial<Record<string, number | null>> = {};
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (k === NAMES_KEY) continue;
    out[k] = toNum(v);
  }
  return out;
}

function listCodes(codes: string[]): string {
  return codes.length > LIST_MAX ? `${codes.slice(0, LIST_MAX).join(', ')} … (+${codes.length - LIST_MAX} more)` : codes.join(', ');
}

function visStatusOf(statuses: Set<string> | undefined): VisStatus {
  if (!statuses) return null;
  if (statuses.has('APPROVED')) return 'APPROVED';
  if (statuses.has('SUBMITTED')) return 'SUBMITTED';
  if (statuses.has('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (statuses.has('REJECTED')) return 'REJECTED';
  return null;
}

/** Why an OK row's award type does not fit the programme (₹ PAYOUT for Unnati / SAMT, POINTS for BSC); null = fits. */
function awardMismatch(r: ComputePreviewRow, expected: 'PAYOUT' | 'POINTS'): string | null {
  return r.awardType === expected ? null : `the rule pays ${r.awardType ?? 'nothing'} but this programme must be ${expected}`;
}

/** Engine row → whole amount (caller has checked the award type with awardMismatch). */
function amountOf(r: ComputePreviewRow, expected: 'PAYOUT' | 'POINTS'): number {
  const v = expected === 'PAYOUT' ? r.payoutRupees : r.points;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

function part(r: ComputePreviewRow, expected: 'PAYOUT' | 'POINTS'): PartResult {
  const amount = amountOf(r, expected);
  const reason = amount === 0 ? (r.reason ?? '').trim() || null : null;
  return { amount, reason };
}

/** Client-facing hold-back note (owner 2026-11-27) — never names codes or rules. */
export function heldBackClientNote(n: number): string {
  return `${n} outlet(s) held back pending a data check — they will appear once fixed.`;
}

const RLP_KPI: Record<string, RlpPart> = {
  [KPI.ADHO]: 'ADHO',
  [KPI.NON_ADHO]: 'NON ADHO',
  [KPI.FB]: 'FOCUS BRAND',
  [KPI.LINES]: 'LINES',
};
const BSC_KPI: Record<string, 'base' | 'fb1' | 'fb2'> = { [KPI.TOTAL]: 'base', [KPI.FB]: 'fb1', [KPI.FB2]: 'fb2' };

@Injectable()
export class PayoutTrackerDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compute: PointsComputeService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  async buildInput(clientId: string, month: string, now: Date = new Date()): Promise<TrackerBuild> {
    if (!MONTH_RE.test(month ?? '')) throw new BadRequestException(`Payout tracker: month must be YYYY-MM (got "${month}").`);
    if (month > istMonthKey(now)) throw new BadRequestException(`Payout tracker: ${monthLong(month)} is a future month.`);

    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    const firstLive = settings.pointsEngine?.firstLiveMonth ?? null;
    if (!firstLive) {
      // Without it the engine cannot tell imported (old-system) months from live ones — never risk computing them.
      throw new BadRequestException(
        `Payout tracker: the points-engine first live month is not set for this tenant (settings.pointsEngine.firstLiveMonth) — set it before the tracker can run, so months imported from the old system are never computed.`,
      );
    }
    if (month < firstLive) {
      throw new BadRequestException(
        `Payout tracker: ${monthLong(month)} is before this programme's first live month (${monthLong(firstLive)}) — its data was imported from the old system and is never computed.`,
      );
    }

    const notes: TrackerNote[] = [];
    const opsNote = (text: string) => notes.push({ audience: 'ops', text }); // housekeeping: ops heads-up only
    const clientNote = (text: string) => notes.push({ audience: 'client', text }); // caveat the client must read
    const quarter = parseQuarter(quarterKeyForMonth(month))!;
    const isQuarterEnd = quarter.months[2] === month;
    const lm = prevMonth(month);

    // ── 1. Month universe: codes with a target or a sales record this month ──────────────────────────
    const [targets, sales, lastMonth, monthStatus, daySet, client] = await Promise.all([
      this.prisma.outletTarget.findMany({ where: { clientId, month }, select: { outletCode: true, targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({
        where: { clientId, month },
        select: { outletCode: true, kpiValues: true, updatedAt: true },
      }),
      this.prisma.outletSalesRecord.findMany({ where: { clientId, month: lm }, select: { outletCode: true, kpiValues: true } }),
      this.prisma.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } }, select: { state: true, lastAppliedAt: true } }),
      this.prisma.salesDaySet.findUnique({ where: { clientId_month: { clientId, month } }, select: { lastDay: true } }),
      this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, internalName: true, branding: true } }),
    ]);
    const targetsBy = new Map(targets.map((t) => [t.outletCode, kpiMap(t.targetValues)]));
    const salesBy = new Map(sales.map((s) => [s.outletCode, kpiMap(s.kpiValues)]));
    const lmBy = new Map(lastMonth.map((s) => [s.outletCode, kpiMap(s.kpiValues)]));
    const codes = [...new Set([...targetsBy.keys(), ...salesBy.keys()])];

    // ── 2. Master + related entities (one query each) ───────────────────────────────────────────────
    const outlets = codes.length
      ? await this.prisma.outlet.findMany({
          where: { clientId, deletedAt: null, outletCode: { in: codes } },
          select: {
            id: true, outletCode: true, name: true, ownerName: true, zone: true, state: true, city: true, beat: true, metro: true,
            distributorCode: true, distributorName: true, programName: true, programCategory: true, partnerId: true,
            outletType: { select: { code: true, name: true } },
            partner: { select: { ownerName: true } },
          },
          orderBy: { outletCode: 'asc' },
        })
      : [];
    const known = new Set(outlets.map((o) => o.outletCode));
    const missing = codes.filter((c) => !known.has(c)).sort();
    if (missing.length) {
      opsNote(
        `${missing.length} outlet code(s) have targets/sales for ${monthLong(month)} but no live outlet master row (deleted or unknown) — not on the report: ${listCodes(missing)}`,
      );
    }

    const outletIds = outlets.map((o) => o.id);
    const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
    const [assignments, salesUsers, kyc, captures] = await Promise.all([
      outletIds.length
        ? this.prisma.salesUserAssignment.findMany({
            where: { outletId: { in: outletIds }, unassignedAt: null },
            select: { outletId: true, salesUserId: true, assignedAt: true },
            orderBy: { assignedAt: 'desc' },
          })
        : Promise.resolve([]),
      this.prisma.salesUser.findMany({
        where: { clientId },
        select: {
          id: true, employeeCode: true, reportingToId: true, isActive: true, deletedAt: true,
          hierarchyLevel: { select: { code: true } },
          user: { select: { name: true } },
        },
      }),
      partnerIds.length
        ? this.prisma.kycSubmission.findMany({
            where: { partnerId: { in: partnerIds }, status: 'APPROVED' },
            select: { partnerId: true },
          })
        : Promise.resolve([]),
      this.prisma.visibilityCapture.findMany({
        where: { clientId, windowKey: { startsWith: `${month}-` } },
        select: { outletCode: true, status: true },
      }),
    ]);

    const approvedPartners = new Set(kyc.map((k) => k.partnerId).filter((p): p is string => !!p));
    const leafByOutlet = new Map<string, string>();
    for (const a of assignments) if (a.outletId && !leafByOutlet.has(a.outletId)) leafByOutlet.set(a.outletId, a.salesUserId); // newest first
    const suById = new Map(salesUsers.map((s) => [s.id, s]));
    const visBy = new Map<string, Set<string>>();
    for (const c of captures) {
      let s = visBy.get(c.outletCode);
      if (!s) visBy.set(c.outletCode, (s = new Set()));
      s.add(String(c.status));
    }

    // Memo per leaf: the chain + whether it was cut — so EVERY outlet on a cut chain is listed, not only the first.
    const chainMemo = new Map<string, { chain: ChainLink[]; cut: 'cycle' | 'deep' | null }>();
    const cycleCodes: string[] = [];
    const deepCodes: string[] = [];
    const chainOf = (leafId: string | undefined, outletCode: string): ChainLink[] => {
      if (!leafId) return [];
      const hit = chainMemo.get(leafId);
      if (hit) {
        if (hit.cut === 'cycle') cycleCodes.push(outletCode);
        else if (hit.cut === 'deep') deepCodes.push(outletCode);
        return hit.chain;
      }
      const chain: ChainLink[] = [];
      const seen = new Set<string>();
      let cut: 'cycle' | 'deep' | null = null;
      let cur = suById.get(leafId);
      while (cur) {
        if (seen.has(cur.id)) {
          cycleCodes.push(outletCode);
          cut = 'cycle';
          break;
        }
        if (chain.length >= MAX_CHAIN_DEPTH) {
          deepCodes.push(outletCode);
          cut = 'deep';
          break;
        }
        seen.add(cur.id);
        chain.push({
          level: cur.hierarchyLevel?.code ?? '',
          hq: cur.employeeCode ?? '',
          name: cur.user?.name ?? null,
          active: !!cur.isActive && !cur.deletedAt,
        });
        cur = cur.reportingToId ? suById.get(cur.reportingToId) : undefined;
      }
      chainMemo.set(leafId, { chain, cut });
      return chain;
    };

    // ── 3. Engine (read-only preview, the month, all programmes) ────────────────────────────────────
    const user: JwtPayload = { sub: 'system:payout-tracker', role: 'GIFSY_ADMIN', clientId, phone: '', name: 'Payout tracker' };
    const monthly = await this.compute.previewCompute(user, { period: month });
    if (monthly.importedMonths?.months?.length) {
      throw new BadRequestException(
        `Payout tracker: ${monthly.importedMonths.monthLabels.join(', ')} is imported from the old system (before the first live month) — never computed.`,
      );
    }
    if (monthly.engineDisabled) {
      // Money-critical: never send a client report off a preview-only engine.
      throw new BadRequestException(
        'Payout tracker: the points engine is switched OFF for this tenant — figures would be a preview only. Switch the engine on before the tracker can be sent.',
      );
    }
    const vs = monthly.visibility;
    if (vs) {
      if (!vs.available) {
        opsNote(`Visibility data for ${monthLong(month)} is unavailable${vs.unavailableReason ? `: ${vs.unavailableReason}` : ''}.`);
      } else if (vs.outletsPending > 0) {
        clientNote(
          `Visibility (${monthLong(month)}): ${vs.outletsPending} outlet(s) can still change — ${vs.outletsWaitingReview} waiting for review, ${vs.outletsOpenWindow} with an open window; they count as not approved for now.`,
        );
      }
    }

    const routeBy = new Map(outlets.map((o) => [o.outletCode, routeOf(o.programName)]));

    // PER-OUTLET rule / config problems (owner 2026-11-27): the report still goes out — the affected outlets are HELD
    // BACK (off the report, so rows / summary / totals exclude them), with a client note (count only) and one ops note
    // per outlet naming its programme + the exact problem (KPI / rule / engine text). Tenant-wide problems still refuse.
    const held = new Map<string, string[]>();
    const hold = (code: string, text: string) => {
      let list = held.get(code);
      if (!list) held.set(code, (list = []));
      if (!list.includes(text)) list.push(text);
    };
    const holdErrors = (p: ComputePreview, prefix: string) => {
      for (const r of p.rows) {
        if (r.status !== 'ERROR' || !known.has(r.outletCode)) continue;
        hold(r.outletCode, `${prefix}${r.kpiCode} (rule ${ruleLabel(r)}): ${(r.reason ?? '').trim() || 'engine error (no message)'}`);
      }
    };

    // Which rules read visibility — from the RULE DEFINITIONS the engine resolved (inputs with a `visibility:*`
    // source), never inferred from whether a row happens to carry visibility facts. One query.
    const okRuleIds = [
      ...new Set(monthly.rows.filter((r) => r.status !== 'ERROR' && known.has(r.outletCode) && r.ruleId).map((r) => r.ruleId as string)),
    ];
    const ruleDefs = okRuleIds.length
      ? await this.prisma.pointsRule.findMany({
          where: { clientId, ruleId: { in: okRuleIds } },
          select: { ruleId: true, version: true, name: true, inputs: true },
        })
      : [];
    const readsVisBy = new Map<string, boolean>();
    const ruleLabelBy = new Map<string, string>();
    for (const d of ruleDefs) {
      const k = `${d.ruleId}@${d.version}`;
      readsVisBy.set(
        k,
        Array.isArray(d.inputs) && (d.inputs as unknown[]).some((i) => !!i && typeof i === 'object' && isVisibilityInput(i as { source?: string | null })),
      );
      ruleLabelBy.set(d.ruleId, (typeof d.name === 'string' && d.name.trim()) || d.ruleId);
    }
    const ruleKey = (r: ComputePreviewRow) => (r.ruleId && r.ruleVersion !== undefined ? `${r.ruleId}@${r.ruleVersion}` : null);
    const ruleLabel = (r: ComputePreviewRow) => (r.ruleName?.trim() || (r.ruleId ? ruleLabelBy.get(r.ruleId) ?? r.ruleId : '(unknown rule)'));
    const readsVisibility = (r: ComputePreviewRow): boolean | undefined => {
      const k = ruleKey(r);
      return k ? readsVisBy.get(k) : undefined;
    };

    holdErrors(monthly, '');

    // A rule that reads visibility but got NO visibility facts = the tenant's visibility data is unavailable → its
    // payout would be computed as "not approved". Hold those outlets back, naming the rule.
    for (const r of monthly.rows) {
      if (r.status === 'OK' && known.has(r.outletCode) && routeBy.get(r.outletCode) && readsVisibility(r) === true && !r.visibility) {
        hold(
          r.outletCode,
          `${r.kpiCode}: visibility data unavailable for rule ${ruleLabel(r)} (it reads visibility)${vs?.unavailableReason ? ` — ${vs.unavailableReason}` : ''}`,
        );
      }
    }

    /** Thrown inside rlpKeyOf (strict) for an Unnati TOTAL rule that is not the visibility rule — caught → hold. */
    class HoldOutlet extends Error {}

    /** The payout part a KPI row lands in for a route — undefined = no column for it. Unnati TOTAL needs the rule. */
    const rlpKeyOf = (r: ComputePreviewRow, route: 'RLP_UNNATI' | 'RLP_SAMT', strict: boolean): RlpPart | undefined => {
      if (r.kpiCode === KPI.TOTAL) {
        if (route === 'RLP_SAMT') return 'TOTAL';
        const reads = readsVisibility(r);
        if (reads === true) return 'VISIBILITY';
        if (!strict && reads === undefined) return 'VISIBILITY'; // NO_RULE / SKIP with no rule: the only Unnati TOTAL part
        if (!strict) return undefined;
        throw new HoldOutlet(
          `TOTAL (rule ${ruleLabel(r)}): ${reads === false ? 'does not read visibility' : 'could not be identified'} — not a known Unnati payout part (Unnati TOTAL = the visibility payout)`,
        );
      }
      const key = RLP_KPI[r.kpiCode];
      // SAMT's Total Payout = the TOTAL rule + LINES only — any other KPI has no place on the sheet.
      if (route === 'RLP_SAMT' && key !== 'LINES') return undefined;
      return key;
    };

    const NO_RULE_REASON = 'No rule for this outlet (check programme / sub-programme)';
    const payoutBy = new Map<string, NonNullable<OutletInput['payout']>>();
    const bscBy = new Map<string, Partial<Record<'base' | 'fb1' | 'fb2', PartResult>>>();
    const okOutlets = new Set<string>();
    const notPaid = new Map<string, Set<string>>(); // "NO_RULE ADHO" / "SKIP LINES" → outlet codes
    for (const r of monthly.rows) {
      if (!known.has(r.outletCode) || held.has(r.outletCode)) continue;
      const route = routeBy.get(r.outletCode) ?? null;
      if (route === null) continue; // unknown programme → rows.ts lists the outlet as an exception
      if (r.status === 'SKIP' && r.skipKind === 'KPI_SCOPE') continue; // outside the KPI's scope — expected

      if (r.status === 'NO_RULE' || r.status === 'SKIP') {
        // Nothing paid — but never silent: the reason goes on the part (when it has a column) + a data note.
        const label = `${r.status === 'NO_RULE' ? 'no rule' : 'skipped by the rule'} for ${r.kpiCode}`;
        let set = notPaid.get(label);
        if (!set) notPaid.set(label, (set = new Set()));
        set.add(r.outletCode);
        const reason = r.status === 'NO_RULE' ? NO_RULE_REASON : (r.reason ?? '').trim() || `Skipped by the ${r.kpiCode} rule`;
        const zero: PartResult = { amount: 0, reason };
        if (route === 'BSC') {
          const key = BSC_KPI[r.kpiCode];
          if (!key) continue;
          let m = bscBy.get(r.outletCode);
          if (!m) bscBy.set(r.outletCode, (m = {}));
          if (!m[key]) m[key] = zero;
        } else {
          const key = rlpKeyOf(r, route, false);
          if (!key) continue;
          let m = payoutBy.get(r.outletCode);
          if (!m) payoutBy.set(r.outletCode, (m = {}));
          if (!m[key]) m[key] = zero;
        }
        continue;
      }
      if (r.status !== 'OK') continue; // ERROR rows already held back above
      okOutlets.add(r.outletCode);
      const expected = route === 'BSC' ? 'POINTS' : 'PAYOUT';
      const mismatch = awardMismatch(r, expected);
      if (mismatch) {
        hold(r.outletCode, `${r.kpiCode} (rule ${ruleLabel(r)}): ${mismatch}`);
        continue;
      }
      if (route === 'BSC') {
        const key = BSC_KPI[r.kpiCode];
        if (!key) {
          hold(r.outletCode, unexpectedKpiText(r, 'BSC', ruleLabel(r)));
          continue;
        }
        let m = bscBy.get(r.outletCode);
        if (!m) bscBy.set(r.outletCode, (m = {}));
        m[key] = part(r, 'POINTS');
        continue;
      }
      let key: RlpPart | undefined;
      try {
        key = rlpKeyOf(r, route, true);
      } catch (e) {
        if (!(e instanceof HoldOutlet)) throw e;
        hold(r.outletCode, e.message);
        continue;
      }
      if (!key) {
        // SAMT: a rule on ADHO / NON ADHO / FB that PAYS would vanish from Total Payout → hold back. One that pays 0
        // moves no money (and has no column) → ignored. Unnati / Lite: any OK row on a column-less KPI is held back.
        if (route === 'RLP_SAMT' && r.kpiCode !== KPI.TOTAL && RLP_KPI[r.kpiCode] && amountOf(r, 'PAYOUT') === 0) continue;
        hold(r.outletCode, unexpectedKpiText(r, route === 'RLP_SAMT' ? 'SAMT' : 'Unnati', ruleLabel(r)));
        continue;
      }
      let m = payoutBy.get(r.outletCode);
      if (!m) payoutBy.set(r.outletCode, (m = {}));
      m[key] = part(r, 'PAYOUT');
    }

    // ── 4. Quarterly consistency bonus (quarter-end month only) ─────────────────────────────────────
    // Per BSC outlet, from the quarter preview: OK row(s) → computed (summed; a genuine 0 keeps its reason); no OK row
    // (NO_RULE / SKIP / no row at all) → not computed with its own reason; KPI-scope-only skips → not applicable.
    type BonusState =
      | { status: 'computed'; points: number; reason: string | null }
      | { status: 'not-computed'; reason: string }
      | { status: 'not-applicable' };
    let bonusBy: Map<string, BonusState> | null = null;
    let bonusNote: string | undefined;
    if (isQuarterEnd) {
      const importedInQuarter = quarter.months.filter((m) => m < firstLive);
      const notComputed = (why: string) => {
        bonusNote = why;
        clientNote(`Consistency bonus (${quarter.label}) not computed: ${why}. The bonus column shows "not computed" and Final Points = Total Points.`);
      };
      if (importedInQuarter.length) {
        const list = importedInQuarter.map(monthLong).join(', ');
        notComputed(`${list} ${importedInQuarter.length > 1 ? 'were' : 'was'} imported from the old system`);
      } else {
        const q = await this.compute.previewCompute(user, { period: quarter.key });
        if (q.engineDisabled) {
          throw new BadRequestException(
            `Payout tracker: the points engine is switched OFF for this tenant — the ${quarter.label} consistency bonus would be a preview only. Switch the engine on before the tracker can be sent.`,
          );
        }
        if (q.importedMonths?.months?.length) {
          notComputed(`${q.importedMonths.monthLabels.join(', ')} imported from the old system`);
        } else if (q.rows.length === 0) {
          notComputed((q.emptyReason ?? 'no quarterly rule').replace(/\.\s*$/, ''));
        } else {
          const qPrefix = `${quarter.label} consistency bonus — `;
          holdErrors(q, qPrefix);
          for (const r of q.rows) {
            if (r.status !== 'OK' || !known.has(r.outletCode) || routeBy.get(r.outletCode) !== 'BSC') continue;
            const mismatch = awardMismatch(r, 'POINTS');
            if (mismatch) hold(r.outletCode, `${qPrefix}${r.kpiCode} (rule ${ruleLabel(r)}): ${mismatch}`);
          }
          const acc = new Map<string, { ok: number; points: number; okReasons: string[]; noRule: boolean; skipReasons: string[]; scopeOnly: boolean }>();
          for (const r of q.rows) {
            if (!known.has(r.outletCode) || held.has(r.outletCode) || routeBy.get(r.outletCode) !== 'BSC') continue;
            let a = acc.get(r.outletCode);
            if (!a) acc.set(r.outletCode, (a = { ok: 0, points: 0, okReasons: [], noRule: false, skipReasons: [], scopeOnly: true }));
            if (r.status === 'SKIP' && r.skipKind === 'KPI_SCOPE') continue;
            a.scopeOnly = false;
            const why = (r.reason ?? '').trim();
            if (r.status === 'OK') {
              a.ok++;
              a.points += amountOf(r, 'POINTS');
              if (why && !a.okReasons.includes(why)) a.okReasons.push(why);
            } else if (r.status === 'NO_RULE') a.noRule = true;
            else if (r.status === 'SKIP' && why && !a.skipReasons.includes(why)) a.skipReasons.push(why);
          }
          bonusBy = new Map();
          const notComputedCodes: string[] = [];
          for (const o of outlets) {
            if (routeBy.get(o.outletCode) !== 'BSC' || held.has(o.outletCode)) continue;
            const a = acc.get(o.outletCode);
            let st: BonusState;
            if (a && a.ok > 0) st = { status: 'computed', points: a.points, reason: a.points === 0 ? a.okReasons.join('; ') || null : null };
            else if (a && a.scopeOnly) st = { status: 'not-applicable' };
            else {
              const reason = !a
                ? 'no quarterly result for this outlet'
                : a.skipReasons.length
                  ? a.skipReasons.join('; ')
                  : a.noRule
                    ? 'no quarterly rule for this outlet'
                    : 'skipped by the quarterly rule';
              st = { status: 'not-computed', reason };
              notComputedCodes.push(o.outletCode);
            }
            bonusBy.set(o.outletCode, st);
          }
          if (notComputedCodes.length) {
            const codes = notComputedCodes.sort();
            opsNote(
              `Consistency bonus (${quarter.label}) not computed for ${codes.length} BSC outlet(s): ${listCodes(codes)} — no OK quarterly row (no rule / skipped / missing); each row shows its reason and Final Points = Total Points.`,
            );
          }
        }
      }
    }

    // Housekeeping lists — emitted after every hold-back is known, so a held outlet is never listed twice.
    for (const [label, set] of [...notPaid.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const codes = [...set].filter((c) => !held.has(c)).sort();
      if (codes.length) opsNote(`${codes.length} outlet(s) paid 0 — ${label}: ${listCodes(codes)}`);
    }

    // ── 5. Assemble (held-back outlets are OFF the report) ──────────────────────────────────────────
    const bonusFields = (route: Route, code: string): Pick<OutletInput, 'consistencyBonus' | 'bonusStatus' | 'bonusReason'> => {
      if (!isQuarterEnd || route !== 'BSC') return { consistencyBonus: null, bonusStatus: 'not-applicable' };
      if (!bonusBy) return { consistencyBonus: null, bonusStatus: 'not-computed', ...(bonusNote ? { bonusReason: bonusNote } : {}) };
      const st = bonusBy.get(code);
      if (!st) return { consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: 'no quarterly result for this outlet' };
      if (st.status === 'computed') return { consistencyBonus: st.points, bonusStatus: 'computed', ...(st.reason ? { bonusReason: st.reason } : {}) };
      if (st.status === 'not-applicable') return { consistencyBonus: null, bonusStatus: 'not-applicable' };
      return { consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: st.reason };
    };
    const zeroPart = (): PartResult => ({ amount: 0, reason: null });
    const out: OutletInput[] = outlets.filter((o) => !held.has(o.outletCode)).map((o) => {
      const route = routeBy.get(o.outletCode) ?? null;
      const lmRec = lmBy.get(o.outletCode);
      const input: OutletInput = {
        code: o.outletCode,
        name: o.name ?? '',
        // Outlet.ownerName is empty for Bajaj on prod — the KYC'd partner's owner name is the real one.
        ownerName: o.partner?.ownerName?.trim() || o.ownerName?.trim() || null,
        zone: o.zone ?? null,
        state: o.state ?? null,
        town: o.city ?? null,
        beat: o.beat ?? null,
        metro: o.metro ?? null,
        sapCode: o.distributorCode ?? null,
        dbName: o.distributorName ?? null,
        program: o.programName ?? null,
        subProgram: o.programCategory ?? null,
        outletTypeCode: o.outletType?.code ?? null,
        outletTypeLabel: o.outletType?.name ?? null,
        gifsyApproved: !!o.partnerId && approvedPartners.has(o.partnerId),
        visibility: visStatusOf(visBy.get(o.outletCode)),
        chain: chainOf(leafByOutlet.get(o.id), o.outletCode),
        targets: targetsBy.get(o.outletCode) ?? {},
        achievements: salesBy.get(o.outletCode) ?? {},
        lastMonthTotal: lmRec ? (lmRec[KPI.TOTAL] ?? 0) : null,
        ...bonusFields(route, o.outletCode),
      };
      if (route === 'RLP_UNNATI' || route === 'RLP_SAMT') {
        const p = payoutBy.get(o.outletCode);
        if (p) input.payout = p;
      } else if (route === 'BSC') {
        const b = bscBy.get(o.outletCode) ?? {};
        input.bsc = { base: b.base ?? zeroPart(), fb1: b.fb1 ?? zeroPart(), fb2: b.fb2 ?? zeroPart() };
      }
      return input;
    });

    // An RLP / BSC outlet with targets this month but no OK engine row AND no reason on any part → the engine said
    // nothing about it (not in its universe / no attachment). Never a silent ₹0.
    const silent = out
      .filter((o) => routeBy.get(o.code) !== null && routeBy.get(o.code) !== undefined)
      .filter((o) => Object.values(o.targets ?? {}).some((v) => v !== null && v !== undefined))
      .filter((o) => !okOutlets.has(o.code))
      .filter((o) => {
        const parts: Array<PartResult | undefined> = [...Object.values(o.payout ?? {}), o.bsc?.base, o.bsc?.fb1, o.bsc?.fb2];
        return !parts.some((p) => p && (p.reason ?? '').trim());
      })
      .map((o) => o.code)
      .sort();
    if (silent.length) {
      opsNote(
        `${silent.length} outlet(s) have targets but the engine returned no payout / points row and no reason for them (check the programme / rules): ${listCodes(silent)}`,
      );
    }

    // Every affected outlet, uncapped (the chain columns of these rows are incomplete — ops must see them all).
    const allCodes = (c: string[]) => [...new Set(c)].sort().join(', ');
    if (cycleCodes.length) {
      opsNote(`Sales chain has a reporting cycle (cut at the repeat) for ${new Set(cycleCodes).size} outlet(s): ${allCodes(cycleCodes)}`);
    }
    if (deepCodes.length) {
      opsNote(`Sales chain deeper than ${MAX_CHAIN_DEPTH} levels (cut) for ${new Set(deepCodes).size} outlet(s): ${allCodes(deepCodes)}`);
    }

    if (held.size) {
      clientNote(heldBackClientNote(held.size));
      const byCode = new Map(outlets.map((o) => [o.outletCode, o]));
      for (const code of [...held.keys()].sort()) {
        const o = byCode.get(code);
        const prog = `${o?.programName?.trim() || '(no programme)'}${o?.programCategory?.trim() ? ` / ${o.programCategory.trim()}` : ''}`;
        opsNote(`Held back: ${code} (${prog}) — ${held.get(code)!.join(' | ')}`);
      }
    }

    // salesAsOf = the LAST INVOICE DAY in the applied DMS file (SalesDaySet.lastDay) — not the apply time. Without a
    // day set, fall back to the apply time, labelled as such.
    let salesAsOf = '—';
    const [yy, mm] = month.split('-').map(Number);
    if (daySet && Number.isInteger(daySet.lastDay) && daySet.lastDay >= 1 && daySet.lastDay <= 31) {
      salesAsOf = `${daySet.lastDay} ${MONTH_SHORT[mm - 1]} ${yy}`;
    } else {
      let applied: Date | null = monthStatus?.lastAppliedAt ?? null;
      if (!applied) for (const s of sales) if (s.updatedAt && (!applied || s.updatedAt > applied)) applied = s.updatedAt;
      if (applied) salesAsOf = `data applied ${istDayLabel(applied)}`;
    }
    const branding = (client?.branding ?? {}) as { displayName?: unknown };
    const clientName =
      (typeof branding.displayName === 'string' && branding.displayName.trim()) || client?.internalName?.trim() || clientId;

    return {
      clientName,
      month,
      monthLabel: monthLong(month),
      salesAsOf,
      provisional: monthStatus?.state !== 'CLOSED',
      quarterLabel: quarter.label,
      bonusPaidIn: monthLong(quarter.months[2]),
      isQuarterEnd,
      outlets: out,
      notes,
      ...(bonusNote ? { bonusNote } : {}),
    };
  }
}

function unexpectedKpiText(r: ComputePreviewRow, programme: string, rule: string): string {
  return `${r.kpiCode} (rule ${rule}): a ${programme} rule on a KPI the tracker has no column for — its payout would be missing from Total Payout`;
}
