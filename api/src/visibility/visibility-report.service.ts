import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import {
  TenantSettingsService,
  VisibilityConfigSettings,
} from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator } from '../common/tenant-scope';
import { visibilityProgramScope, visibilityUniverseWhere } from './visibility-scope.helper';
import {
  monthCaptureWhere,
  monthWindows,
  PLAIN_STATUSES,
  PlainStatus,
  plainStatusOf,
  resolveMonth,
} from './visibility-metrics';
import { readPhotoReviews } from './visibility-types';
import { IMPORTED_MONTH_NOTE, isImportedCaptureFormValues, isVisibilityImportedMonth } from './visibility-import.helper';
import { loadSalesHierarchy } from '../sales/sales-hierarchy.loader';
import { firstActiveApproverId } from '../sales/sales-hierarchy-access.helper';
import type { ReportGroup } from './dto/visibility-report.dto';

/** One outlet-window ("visit due") of the selected month — the unit every report number counts. */
export interface ReportSlot {
  outletId: string;
  outletCode: string;
  outletName: string;
  programme: string | null;
  subProgramme: string | null;
  windowKey: string;
  windowClosed: boolean;
  status: PlainStatus;
  captureId: string | null;
  /** The outlet's currently assigned rep (active assignment) — who is responsible for the visit. */
  repId: string | null;
  repName: string | null;
  repCode: string | null;
  /** The first ACTIVE manager above that rep (vacant levels skipped, like the KYC approver walk). */
  managerId: string | null;
  managerName: string | null;
  /** Who actually captured it: the submitting rep, or "Old app (imported)" for an imported record. */
  capturedBy: string | null;
  capturedOn: Date | null;
  reviewedBy: string | null;
  reviewedOn: Date | null;
  imported: boolean;
}

export interface StatusTally {
  /** Visits due (outlet × window). In an IMPORTED month: only the visits the old app recorded. */
  inScope: number;
  waiting: number;
  approved: number;
  /** Open window only — the rep can still re-take. */
  needsRetake: number;
  /** Open window only — the rep can still capture again. */
  rejected: number;
  /** Re-take requested / rejected and the window has closed — final ("Not approved — window closed"). */
  closedNotApproved: number;
  notCaptured: number;
  missed: number;
  /** Imported months only — no record from the old app (it kept only approved visits). Always 0 here. */
  notTracked: number;
  /** approved ÷ inScope × 100 (1 dp); 0 when nothing is in scope; null for an imported month (not tracked). */
  coveragePct: number | null;
}

export interface BreakdownRow extends StatusTally {
  key: string;
  label: string;
}

export interface ReportOutletsQuery {
  month?: string;
  windowKey?: string;
  status?: PlainStatus;
  group?: ReportGroup;
  groupKey?: string;
  page?: number;
  pageSize?: number;
}

const UNASSIGNED = 'UNASSIGNED';
const NO_MANAGER = 'NONE';
export const IMPORTED_LABEL = 'Old app (imported)';

const STATUS_FIELD: Record<PlainStatus, keyof Omit<StatusTally, 'inScope' | 'coveragePct'>> = {
  WAITING: 'waiting',
  APPROVED: 'approved',
  NEEDS_RETAKE: 'needsRetake',
  REJECTED: 'rejected',
  CLOSED_NOT_APPROVED: 'closedNotApproved',
  NOT_CAPTURED: 'notCaptured',
  MISSED: 'missed',
  NOT_TRACKED: 'notTracked',
};

/**
 * Count slots into the plain buckets. Pure (unit-tested). `coverageTracked = false` (an imported month) →
 * coveragePct null: the old app kept only approved visits, so there is no denominator to divide by.
 */
export function tallySlots(slots: Array<Pick<ReportSlot, 'status'>>, coverageTracked = true): StatusTally {
  const t: StatusTally = {
    inScope: 0, waiting: 0, approved: 0, needsRetake: 0, rejected: 0, closedNotApproved: 0,
    notCaptured: 0, missed: 0, notTracked: 0, coveragePct: 0,
  };
  for (const s of slots) {
    t.inScope += 1;
    t[STATUS_FIELD[s.status]] += 1;
  }
  t.coveragePct = !coverageTracked ? null : t.inScope > 0 ? Math.round((t.approved / t.inScope) * 1000) / 10 : 0;
  return t;
}

/** The breakdown key + label of a slot for a group. Pure. */
export function groupKeyOf(slot: ReportSlot, group: ReportGroup): { key: string; label: string } {
  if (group === 'programme') {
    const p = slot.programme?.trim() || null;
    const s = slot.subProgramme?.trim() || null;
    return { key: JSON.stringify([p ?? '', s ?? '']), label: `${p ?? 'No programme'} / ${s ?? 'No sub-programme'}` };
  }
  if (group === 'rep') {
    if (!slot.repId) return { key: UNASSIGNED, label: 'No rep assigned' };
    return { key: slot.repId, label: `${slot.repName ?? 'Unnamed rep'}${slot.repCode ? ` (${slot.repCode})` : ''}` };
  }
  if (!slot.managerId) return { key: NO_MANAGER, label: 'No active manager' };
  return { key: slot.managerId, label: slot.managerName ?? 'Unnamed manager' };
}

/** Group slots into breakdown rows, sorted by label (the "no …" bucket last). Pure. */
export function breakdown(slots: ReportSlot[], group: ReportGroup, coverageTracked = true): BreakdownRow[] {
  const by = new Map<string, { label: string; slots: ReportSlot[] }>();
  for (const s of slots) {
    const { key, label } = groupKeyOf(s, group);
    const e = by.get(key) ?? { label, slots: [] };
    e.slots.push(s);
    by.set(key, e);
  }
  const isNone = (k: string) => k === UNASSIGNED || k === NO_MANAGER || k === JSON.stringify(['', '']);
  return [...by.entries()]
    .map(([key, e]) => ({ key, label: e.label, ...tallySlots(e.slots, coverageTracked) }))
    .sort((a, b) => Number(isNone(a.key)) - Number(isNone(b.key)) || a.label.localeCompare(b.label));
}

/**
 * Who reviewed a capture, and when. Pure (unit-tested).
 *   - Decided (APPROVED / CHANGES_REQUESTED / REJECTED): the latest photo decision's reviewer, else the whole-capture
 *     reviewer column; the date is the capture's reviewedAt (else that photo decision).
 *   - Waiting for review (fresh, or RESUBMITTED after a re-take): only photo decisions made AFTER its last
 *     (re)submission (`receivedAt`) — the review in progress on the current version. Decisions carried over from
 *     the previous version (e.g. the photos approved before the re-take) are older than the resubmission and are
 *     ignored, so a capture waiting for review never reads as already "reviewed by" someone.
 */
export function reviewerOfCapture(c: {
  status: string;
  photoReviews: unknown;
  approvedByUserId: string | null;
  reviewedAt: Date | null;
  receivedAt: Date | null;
}): { userId: string | null; at: Date | null } {
  const waiting = c.status === 'SUBMITTED';
  const since = waiting && c.receivedAt ? c.receivedAt.getTime() : -Infinity;
  let best: { userId: string; at: number } | null = null;
  for (const r of Object.values(readPhotoReviews(c.photoReviews))) {
    const at = Date.parse(r.reviewedAt);
    if (!r.reviewedByUserId || !Number.isFinite(at) || at < since) continue;
    if (!best || at > best.at) best = { userId: r.reviewedByUserId, at };
  }
  if (waiting) return { userId: best?.userId ?? null, at: best ? new Date(best.at) : null };
  return { userId: best?.userId ?? c.approvedByUserId ?? null, at: c.reviewedAt ?? (best ? new Date(best.at) : null) };
}

const CHUNK = 5000;
function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/**
 * VisibilityReportService — the MONTH-WISE Visibility (POSM) report (VISIBILITY-POSM-DESIGN.md §Metrics).
 * Pick a month (default the current IST month; any past month incl. imported old-app history) and optionally
 * one window of it. Every in-scope outlet × window of the selection is one "visit due" with ONE plain status:
 * Waiting for review · Approved · Needs re-take / Rejected (window open — the rep can still redo it) · Not approved —
 * window closed (re-take / rejection left when the window closed; final) · Not captured yet (window open) · Missed
 * (no capture by window close). An IMPORTED month (before the portal went live — visibility-import.helper) lists only
 * the visits the old app recorded, with coverage / Missed "not tracked" (importedMonthNote). Tiles, the Programme / Rep / Manager breakdowns and the outlet list are all computed from the SAME
 * slot table, so a tile, its breakdown rows and its outlet list always add up. In scope = visibilityUniverseWhere.
 * Captures that exist but are NOT counted (outlet no longer in scope, or a window key the current frequency does
 * not have) are returned in `notCounted` and shown on screen — never silently dropped.
 * The xlsx captures export is the `visibility-captures` export kind (exports/kinds/batch1/visibility-captures.ts).
 */
@Injectable()
export class VisibilityReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** 403 unless the tenant's Visibility master switch is on (also used by the captures export endpoint). */
  async assertEnabled(clientId: string): Promise<void> {
    if (!(await this.tenant.resolveVisibilityEnabled(clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  private async getConfig(clientId: string): Promise<VisibilityConfigSettings> {
    return (await this.tenantSettings.getEffectiveSettings(clientId)).visibilityConfig;
  }

  /** Resolve month + window selection. A windowKey alone implies its month; it must belong to the month. */
  private selection(q: { month?: string; windowKey?: string }, freq: number, now: Date) {
    const wk = q.windowKey?.trim() || undefined;
    let month: string;
    try {
      month = resolveMonth(q.month ?? (wk ? wk.slice(0, 7) : undefined), now);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const windows = monthWindows(month, freq, now);
    if (wk && !windows.some((w) => w.key === wk)) {
      throw new BadRequestException(`Window "${wk}" is not a window of ${month} (${windows.map((w) => w.key).join(', ')}).`);
    }
    const selected = wk ? windows.filter((w) => w.key === wk) : windows;
    return { month, windows, selected, windowKey: wk ?? null };
  }

  /** Build the slot table for a selection (the single source for tiles, breakdowns and lists). */
  private async buildSlots(clientId: string, q: { month?: string; windowKey?: string }) {
    const config = await this.getConfig(clientId);
    const now = new Date();
    const freq = config.frequencyPerMonth;
    const sel = this.selection(q, freq, now);
    const selectedKeys = sel.selected.map((w) => w.key);
    const closedByKey = new Map(sel.selected.map((w) => [w.key, w.closed]));
    const scoped = config.outletScope.length > 0;
    const universe = visibilityUniverseWhere(clientId, config);
    // An IMPORTED (pre-portal) month: the old app kept only approved visits → list only what it recorded, never
    // "Missed" / coverage against today's outlets (visibility-import.helper — the shared go-live rule).
    const importedMonth = await isVisibilityImportedMonth(this.prisma, clientId, sel.month);

    const outlets = scoped
      ? await this.prisma.outlet.findMany({
          where: universe,
          select: { id: true, outletCode: true, name: true, programName: true, programCategory: true },
          orderBy: { outletCode: 'asc' },
        })
      : [];

    const captures = scoped
      ? await this.prisma.visibilityCapture.findMany({
          where: { clientId, windowKey: { in: selectedKeys }, outlet: universe },
          select: {
            id: true,
            outletId: true,
            windowKey: true,
            status: true,
            capturedAt: true,
            receivedAt: true,
            reviewedAt: true,
            photoReviews: true,
            // Only to tell an imported old-app record (photo path under vendor-import/) from a portal capture.
            formValues: true,
            approvedByUserId: true,
            submittedBySalesUserId: true,
            submittedBy: { select: { employeeCode: true, user: { select: { name: true } } } },
          },
        })
      : [];

    // Loud, never silent: captures in the selection we do NOT count, and why.
    const outOfScope = await this.prisma.visibilityCapture.count({
      where: scoped
        ? { clientId, windowKey: { in: selectedKeys }, NOT: { outlet: universe } }
        : { clientId, windowKey: { in: selectedKeys } },
    });
    const otherWindow = sel.windowKey
      ? 0
      : await this.prisma.visibilityCapture.count({
          where: {
            ...monthCaptureWhere(clientId, sel.month),
            windowKey: { startsWith: `${sel.month}-P`, notIn: sel.windows.map((w) => w.key) },
          },
        });

    // Responsible rep (most recent active assignment to a non-deleted rep) + first active manager above them.
    const outletIds = outlets.map((o) => o.id);
    const repByOutlet = new Map<string, string>();
    for (const part of chunks(outletIds)) {
      const rows = await this.prisma.salesUserAssignment.findMany({
        where: { outletId: { in: part }, unassignedAt: null, salesUser: { clientId, deletedAt: null } },
        orderBy: { assignedAt: 'desc' },
        select: { outletId: true, salesUserId: true },
      });
      for (const r of rows) if (r.outletId && !repByOutlet.has(r.outletId)) repByOutlet.set(r.outletId, r.salesUserId);
    }
    const nodes = repByOutlet.size ? await loadSalesHierarchy(this.prisma, clientId) : [];
    const managerByRep = new Map<string, string | null>();
    for (const rep of new Set(repByOutlet.values())) managerByRep.set(rep, firstActiveApproverId(rep, nodes));
    const peopleIds = [...new Set([...repByOutlet.values(), ...[...managerByRep.values()].filter((v): v is string => !!v)])];
    const people = new Map<string, { name: string | null; code: string | null }>();
    for (const part of chunks(peopleIds)) {
      const rows = await this.prisma.salesUser.findMany({
        where: { id: { in: part }, clientId },
        select: { id: true, employeeCode: true, user: { select: { name: true } } },
      });
      for (const r of rows) people.set(r.id, { name: r.user?.name ?? null, code: r.employeeCode ?? null });
    }

    // Reviewer names: the last photo decision's reviewer, else the whole-capture reviewer column.
    const reviewerOf = new Map<string, { userId: string | null; at: Date | null }>();
    for (const c of captures) {
      reviewerOf.set(c.id, reviewerOfCapture(c));
    }
    const reviewerIds = [...new Set([...reviewerOf.values()].map((v) => v.userId).filter((v): v is string => !!v))];
    const reviewerName = new Map<string, string>();
    for (const part of chunks(reviewerIds)) {
      const rows = await this.prisma.user.findMany({ where: { id: { in: part } }, select: { id: true, name: true } });
      for (const r of rows) reviewerName.set(r.id, r.name ?? '');
    }

    const capByKey = new Map(captures.map((c) => [`${c.outletId}|${c.windowKey}`, c]));
    const slots: ReportSlot[] = [];
    for (const o of outlets) {
      const repId = repByOutlet.get(o.id) ?? null;
      const managerId = repId ? managerByRep.get(repId) ?? null : null;
      for (const key of selectedKeys) {
        const c = capByKey.get(`${o.id}|${key}`) ?? null;
        // Imported month: only the visits the old app recorded are listed (no capture = not tracked, not a slot).
        if (importedMonth && !c) continue;
        const rev = c ? reviewerOf.get(c.id) : undefined;
        const imported = !!c && isImportedCaptureFormValues(c.formValues);
        slots.push({
          outletId: o.id,
          outletCode: o.outletCode,
          outletName: o.name,
          programme: o.programName ?? null,
          subProgramme: o.programCategory ?? null,
          windowKey: key,
          windowClosed: closedByKey.get(key) ?? false,
          status: plainStatusOf(c?.status ?? null, closedByKey.get(key) ?? false, importedMonth),
          captureId: c?.id ?? null,
          repId,
          repName: repId ? people.get(repId)?.name ?? null : null,
          repCode: repId ? people.get(repId)?.code ?? null : null,
          managerId,
          managerName: managerId ? people.get(managerId)?.name ?? null : null,
          capturedBy: c
            ? imported
              ? IMPORTED_LABEL
              : c.submittedBy
                ? `${c.submittedBy.user?.name ?? 'Rep'}${c.submittedBy.employeeCode ? ` (${c.submittedBy.employeeCode})` : ''}`
                : 'Rep (no longer on file)'
            : null,
          capturedOn: c ? c.capturedAt ?? c.receivedAt : null,
          reviewedBy: rev?.userId ? reviewerName.get(rev.userId) || null : null,
          reviewedOn: rev?.at ?? null,
          imported,
        });
      }
    }
    return { config, sel, slots, notCounted: { outOfScope, otherWindow }, outletsInScope: outlets.length, importedMonth };
  }

  /** The month report: tiles + breakdowns. */
  private async computeReport(clientId: string, q: { month?: string; windowKey?: string }) {
    const { config, sel, slots, notCounted, outletsInScope, importedMonth } = await this.buildSlots(clientId, q);
    const t = tallySlots(slots, !importedMonth);
    const programScope = visibilityProgramScope(config);
    const allClosed = sel.selected.length > 0 && sel.selected.every((w) => w.closed);
    return {
      month: sel.month,
      /** The single window selected, or null = every window of the month. */
      windowKey: sel.windowKey,
      windows: sel.windows.map((w) => ({ key: w.key, closed: w.closed })),
      windowClosed: allClosed,
      frequencyPerMonth: config.frequencyPerMonth,
      outletScope: config.outletScope,
      ...(programScope.programs.length ? { programs: programScope.programs } : {}),
      ...(programScope.subPrograms.length ? { subPrograms: programScope.subPrograms } : {}),
      outletsInScope,
      /**
       * true = a month before the portal went live (imported old-app history): `summary.inScope` = the visits the old
       * app recorded, coverage is null and nothing is "Missed" — `importedMonthNote` says why, in plain words.
       */
      importedMonth,
      ...(importedMonth ? { importedMonthNote: IMPORTED_MONTH_NOTE } : {}),
      summary: t,
      notCounted,
      breakdowns: {
        programme: breakdown(slots, 'programme', !importedMonth),
        rep: breakdown(slots, 'rep', !importedMonth),
        manager: breakdown(slots, 'manager', !importedMonth),
      },
    };
  }

  /** The outlets behind a tile (status) and/or a breakdown row (group + groupKey), paged. */
  private async computeOutlets(clientId: string, q: ReportOutletsQuery) {
    if (q.status && !(PLAIN_STATUSES as readonly string[]).includes(q.status)) {
      throw new BadRequestException(`status must be one of ${PLAIN_STATUSES.join(', ')}`);
    }
    if (q.group && !q.groupKey) throw new BadRequestException('groupKey is required with group.');
    const { sel, slots } = await this.buildSlots(clientId, q);
    const filtered = slots.filter(
      (s) => (!q.status || s.status === q.status) && (!q.group || groupKeyOf(s, q.group).key === q.groupKey),
    );
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map((s) => ({
      outletId: s.outletId,
      outletCode: s.outletCode,
      outletName: s.outletName,
      programme: s.programme,
      subProgramme: s.subProgramme,
      windowKey: s.windowKey,
      status: s.status,
      captureId: s.captureId,
      rep: s.repName ? `${s.repName}${s.repCode ? ` (${s.repCode})` : ''}` : null,
      manager: s.managerName,
      capturedBy: s.capturedBy,
      capturedOn: s.capturedOn,
      reviewedBy: s.reviewedBy,
      reviewedOn: s.reviewedOn,
      imported: s.imported,
    }));
    return {
      month: sel.month,
      windowKey: sel.windowKey,
      status: q.status ?? null,
      group: q.group ?? null,
      groupKey: q.groupKey ?? null,
      groupLabel: q.group ? (filtered[0] ? groupKeyOf(filtered[0], q.group).label : null) : null,
      rows,
      pagination: { page, pageSize, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / pageSize)) },
    };
  }

  private assertGifsy(user: JwtPayload) {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (!isGifsyOperator(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
  }

  /** GIFSY admin month report (default = current IST month, every window). */
  async gifsyReport(user: JwtPayload, q: { month?: string; windowKey?: string } = {}) {
    this.assertGifsy(user);
    await this.assertEnabled(user.clientId);
    return this.computeReport(user.clientId, q);
  }

  /** CLIENT_ADMIN read-only month report (same shape as the GIFSY report). */
  async tenantReport(user: JwtPayload, q: { month?: string; windowKey?: string } = {}) {
    await this.assertEnabled(user.clientId);
    return this.computeReport(user.clientId, q);
  }

  async gifsyOutlets(user: JwtPayload, q: ReportOutletsQuery) {
    this.assertGifsy(user);
    await this.assertEnabled(user.clientId);
    return this.computeOutlets(user.clientId, q);
  }

  async tenantOutlets(user: JwtPayload, q: ReportOutletsQuery) {
    await this.assertEnabled(user.clientId);
    return this.computeOutlets(user.clientId, q);
  }
}
