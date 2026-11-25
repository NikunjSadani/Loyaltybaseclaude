/**
 * points-engine-visibility.loader.ts — the outlet's VISIBILITY (POSM) result for a compute month, as Points
 * Compute Engine inputs (`source: "visibility:approved | approvedWindows | windows | inScope"`). Owner decision
 * 2026-11-25 (shared engine, owner-approved) — POINTS-COMPUTE-ENGINE-DESIGN.md §3a.
 *
 * Loaded by PointsComputeService ONLY when a resolved rule declares a visibility input (so a tenant whose rules do
 * not use visibility — Deoleo today — runs exactly the queries it ran before). Tenant-scoped (clientId on every
 * query), bounded and N+1-free: PHOTO_APPROVAL = the month's captures (1 query) + the in-scope outlets of each
 * window (≤ 4 queries, one per window of the frequency) + the old-app go-live lookups (2, one cached);
 * AMOUNT_UPLOAD = the month's uploaded status records (1 query). Keyed by outletCode.
 *
 * ── "Approved" — the visibility module's rule ─────────────────────────────────────────────────────────────────
 * PHOTO_APPROVAL: a window counts as approved when the capture's FINAL status is APPROVED (per-photo review rolls up
 * server-side: all required photos approved → APPROVED) and EITHER
 *   (a) the outlet is in THAT window's visibility universe (visibilityWindowUniverseWhere — the Visibility report's
 *       per-window rule: a closed window = outlets live + KYC-approved during it; an open one = today's in-scope), OR
 *   (b) the outlet's type / programme is in the visibility programme (an APPROVED capture is proof the visit
 *       happened — it counts even when the outlet's created / KYC dates put it outside the dated universe, e.g. an
 *       outlet loaded into the system after its window). These are counted and reported (`countedOutsideDatedScope`).
 * Imported old-app captures are stored APPROVED → they count. SUBMITTED, CHANGES_REQUESTED, REJECTED never count.
 * NOT counted but always reported (summary + the outlet's row): an APPROVED capture of an outlet whose type /
 * programme is not in the visibility programme, and an APPROVED capture under an OLDER frequency's window key
 * (e.g. `-P2` after the tenant moved to once a month — its day range is unknown).
 *
 * `windows` per outlet = the windows of the month the outlet was actually in scope for (≤ the month's windows), so
 * "every window approved" (approvedWindows ≥ windows) is fair to an outlet that joined mid-month.
 *
 * PENDING (never silent): per outlet, windows still WAITING FOR REVIEW (SUBMITTED) and windows STILL OPEN without an
 * approval. The preview counts the outlets affected; export / payout report / direct credit are refused until the
 * admin accepts that count (PointsComputeService.assertVisibilityPendingAccepted).
 *
 * AMOUNT_UPLOAD: the month's uploaded OutletVisibilityRecord; APPROVED → 1 of 1. PENDING / UNDER_REVIEW → 0 and
 * counted as waiting for review. No record → 0, inScope 0 ("no status uploaded").
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { EvalContext } from './points-engine.types';
import { monthWindows } from '../visibility/visibility-metrics';
import { windowRangeUtc } from '../visibility/visibility-report-scope';
import { visibilityNotApplicable, visibilityWindowUniverseWhere } from '../visibility/visibility-scope.helper';
import {
  classifyWindowAgainstGoLive,
  importedWindowKeys,
  visibilityPortalGoLive,
  type GoLiveWindowClass,
} from '../visibility/visibility-portal-go-live';
import { VISIBILITY_WORDS } from '../visibility/visibility-report-labels';

export type VisibilityScopeState = 'IN_SCOPE' | 'NOT_IN_SCOPE' | 'NO_RECORD';

/** One outlet's visibility facts for the month (+ the plain line the preview trace shows). */
export interface OutletVisibilityFacts {
  approvedWindows: number;
  approved: 0 | 1;
  /** Windows of the month this outlet was in scope for (1 for AMOUNT_UPLOAD with a record; 0 when out of scope). */
  windows: number;
  /** 1 when the outlet is in the visibility programme for the month, else 0 (rules can tell "n/a" from "not approved"). */
  inScope: 0 | 1;
  scope: VisibilityScopeState;
  /** Windows whose capture / uploaded status is still waiting for review. */
  waitingWindows: number;
  /** PHOTO_APPROVAL: in-scope windows still OPEN with no approval and nothing waiting (the rep can still capture). */
  openWindows: number;
  /** PHOTO_APPROVAL: windows with a re-take request / rejection. */
  notApprovedWindows: number;
  /** APPROVED captures of this outlet that were NOT counted, by reason. */
  excludedApprovals: { olderFrequency: number; notInProgramme: number };
  /** Plain one-liner for the explanation ("Visibility 2026-11: 1 of 2 windows approved … → approved=1"). */
  note: string;
}

export interface VisibilityInputData {
  month: string;
  mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  /** false → no usable visibility data for this tenant: every visibility input is ABSENT (its nullAs applies). */
  available: boolean;
  unavailableReason?: string;
  /** Windows in the month (1–4; 1 for AMOUNT_UPLOAD). */
  windows: number;
  /** Windows of the month not yet closed (PHOTO_APPROVAL). */
  openWindowsInMonth: number;
  byOutlet: Map<string, OutletVisibilityFacts>;
  /** APPROVED captures counted although the outlet was outside the dated window universe (rule (b) above). */
  countedOutsideDatedScope: number;
  /** APPROVED captures NOT counted, by reason (outlet codes kept so out-of-scope rows can say so). */
  excluded: { olderFrequency: number; notInProgramme: number };
  excludedByOutlet: Map<string, { olderFrequency: number; notInProgramme: number }>;
  scopeConfig?: { outletScope: string[]; programs: string[]; subPrograms: string[] };
}

/** Summary on ComputePreview.visibility (only when a rule used visibility). */
export interface VisibilityPreviewSummary {
  month: string;
  mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  available: boolean;
  unavailableReason?: string;
  windows: number;
  /** Windows of the month still open at compute time. */
  openWindowsInMonth: number;
  /** Outlets with ≥ 1 approved window this month. */
  outletsApproved: number;
  /** Outlets in the visibility scope (PHOTO_APPROVAL) / with an uploaded status (AMOUNT_UPLOAD). */
  outletsWithData: number;
  /** Outlets with ≥ 1 window waiting for review. */
  outletsWaitingReview: number;
  /** Outlets with ≥ 1 in-scope window still open without an approval. */
  outletsOpenWindow: number;
  /**
   * Outlets whose visibility can still change (waiting for review OR an open window) — they read "not approved" for
   * those windows NOW. Export / payout report / direct credit need the admin to accept exactly this number.
   */
  outletsPending: number;
  countedOutsideDatedScope: number;
  excluded: { olderFrequency: number; notInProgramme: number };
}

interface VisibilityConfigLike {
  outletScope?: string[] | null;
  frequencyPerMonth?: number | null;
  programs?: string[] | null;
  subPrograms?: string[] | null;
}

type LoaderPrisma = Pick<PrismaService, 'visibilityCapture' | 'outlet' | 'outletVisibilityRecord' | '$queryRaw'>;

function emptyData(month: string, mode: VisibilityInputData['mode'], windows: number): VisibilityInputData {
  return {
    month, mode, available: true, windows, openWindowsInMonth: 0, byOutlet: new Map(), countedOutsideDatedScope: 0,
    excluded: { olderFrequency: 0, notInProgramme: 0 }, excludedByOutlet: new Map(),
  };
}

function unavailable(month: string, mode: VisibilityInputData['mode'], reason: string, windows = 0): VisibilityInputData {
  return { ...emptyData(month, mode, windows), available: false, unavailableReason: reason };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Load the month's visibility result for the whole tenant. `enabled` / `mode` / `config` are the tenant's resolved
 * visibility settings (master switch, capture mode, visibilityConfig). `now` decides open vs closed windows.
 */
export async function loadVisibilityInputs(
  prisma: LoaderPrisma,
  clientId: string,
  month: string,
  opts: { enabled: boolean; mode: VisibilityInputData['mode']; config: VisibilityConfigLike | null | undefined; now: Date },
): Promise<VisibilityInputData> {
  const { enabled, mode, config, now } = opts;
  if (!enabled) return unavailable(month, mode, 'Visibility is switched off for this tenant, so there is no visibility result to read.');

  if (mode === 'AMOUNT_UPLOAD') {
    const records = await prisma.outletVisibilityRecord.findMany({
      where: { clientId, month },
      select: { outletCode: true, status: true },
    });
    const data = emptyData(month, mode, 1);
    for (const r of records) {
      const ok = r.status === 'APPROVED';
      data.byOutlet.set(r.outletCode, {
        approvedWindows: ok ? 1 : 0,
        approved: ok ? 1 : 0,
        windows: 1,
        inScope: 1,
        scope: 'IN_SCOPE',
        waitingWindows: ok ? 0 : 1, // PENDING / UNDER_REVIEW = not decided yet
        openWindows: 0,
        notApprovedWindows: 0,
        excludedApprovals: { olderFrequency: 0, notInProgramme: 0 },
        note: ok
          ? `Visibility ${month} (uploaded status): APPROVED → approved=1`
          : `Visibility ${month} (uploaded status): ${r.status} — not approved yet → approved=0`,
      });
    }
    return data;
  }

  // ── PHOTO_APPROVAL ──────────────────────────────────────────────────────────────────────────────────────
  const outletScope = Array.isArray(config?.outletScope) ? config!.outletScope! : [];
  const freq = config?.frequencyPerMonth ?? 1;
  let windows: Array<{ key: string; closed: boolean }>;
  try {
    windows = monthWindows(month, freq, now);
  } catch (e) {
    return unavailable(month, mode, `Visibility settings are not usable (${(e as Error).message}).`);
  }
  if (outletScope.length === 0) {
    return unavailable(month, mode, 'No outlet types are in the visibility programme yet, so no outlet has a visibility result.', windows.length);
  }
  const scopeCfg = {
    outletScope,
    programs: Array.isArray(config?.programs) ? config!.programs! : [],
    subPrograms: Array.isArray(config?.subPrograms) ? config!.subPrograms! : [],
  };
  const windowKeys = new Set(windows.map((w) => w.key));
  const closedOf = new Map(windows.map((w) => [w.key, w.closed]));

  // The month's captures (ANY window key — an older frequency's keys are reported, not dropped) + each window's
  // dated universe (THE Visibility report rule) + the old-app history classification (same as the report).
  const [captures, universes, goLive, importedKeys] = await Promise.all([
    prisma.visibilityCapture.findMany({
      where: { clientId, windowKey: { startsWith: `${month}-P` } },
      select: {
        windowKey: true,
        status: true,
        outlet: { select: { outletCode: true, programName: true, programCategory: true, outletType: { select: { code: true } } } },
      },
    }),
    Promise.all(
      windows.map(async (w) => {
        const where: Prisma.OutletWhereInput = visibilityWindowUniverseWhere(clientId, scopeCfg, {
          ...windowRangeUtc(w.key, freq),
          closed: w.closed,
        });
        const rows = await prisma.outlet.findMany({ where, select: { outletCode: true } });
        return [w.key, new Set(rows.map((r) => r.outletCode))] as const;
      }),
    ),
    visibilityPortalGoLive(prisma, clientId),
    importedWindowKeys(prisma, clientId, [1, 2, 3, 4].map((n) => `${month}-P${n}`)),
  ]);
  const universeByKey = new Map<string, Set<string>>(universes);
  const classByKey = new Map<string, GoLiveWindowClass>(
    windows.map((w) => [
      w.key,
      classifyWindowAgainstGoLive(windowRangeUtc(w.key, freq), goLive, {
        windowHoldsImported: importedKeys.has(w.key),
        scopeHoldsImported: importedKeys.size > 0,
      }),
    ]),
  );

  const data = emptyData(month, mode, windows.length);
  data.scopeConfig = scopeCfg;
  data.openWindowsInMonth = windows.filter((w) => !w.closed).length;

  // outletCode → windowKey → capture status (counted captures only) + the windows the outlet is in scope for.
  const statusBy = new Map<string, Map<string, string>>();
  const scopeWindowsBy = new Map<string, Set<string>>();
  const addScope = (code: string, wk: string) => {
    const s = scopeWindowsBy.get(code) ?? new Set<string>();
    s.add(wk);
    scopeWindowsBy.set(code, s);
  };
  for (const [wk, codes] of universeByKey) for (const code of codes) addScope(code, wk);
  const excludeFor = (code: string, reason: 'olderFrequency' | 'notInProgramme') => {
    data.excluded[reason] += 1;
    const e = data.excludedByOutlet.get(code) ?? { olderFrequency: 0, notInProgramme: 0 };
    e[reason] += 1;
    data.excludedByOutlet.set(code, e);
  };

  for (const c of captures) {
    const o = c.outlet;
    if (!o?.outletCode) continue;
    const code = o.outletCode;
    if (!windowKeys.has(c.windowKey)) {
      // A window key the current frequency does not have (an older frequency) — day range unknown → not counted.
      if (c.status === 'APPROVED') excludeFor(code, 'olderFrequency');
      continue;
    }
    if (!universeByKey.get(c.windowKey)?.has(code)) {
      if (c.status !== 'APPROVED') continue; // not in this window's scope and not proven → not a visit due
      if (visibilityNotApplicable(o, scopeCfg)) {
        excludeFor(code, 'notInProgramme');
        continue;
      }
      // An approved capture of an in-programme outlet is proof — counted despite its created / KYC dates.
      data.countedOutsideDatedScope += 1;
      addScope(code, c.windowKey);
    }
    const m = statusBy.get(code) ?? new Map<string, string>();
    m.set(c.windowKey, c.status);
    statusBy.set(code, m);
  }

  for (const [code, scopeWindows] of scopeWindowsBy) {
    const statuses = statusBy.get(code) ?? new Map<string, string>();
    let approvedWindows = 0;
    let waitingWindows = 0;
    let notApprovedWindows = 0;
    let openWindows = 0;
    const oldAppNotes: string[] = [];
    for (const wk of [...scopeWindows].sort()) {
      const st = statuses.get(wk);
      if (st === 'APPROVED') approvedWindows += 1;
      else if (st === 'SUBMITTED') waitingWindows += 1;
      else {
        if (st === 'CHANGES_REQUESTED' || st === 'REJECTED') notApprovedWindows += 1;
        if (!closedOf.get(wk)) openWindows += 1; // the rep can still capture / re-take
        else if (!st) {
          const cls = classByKey.get(wk);
          if (cls === 'old') oldAppNotes.push(`${wk.slice(8)}: ${VISIBILITY_WORDS.NOT_TRACKED}`);
          else if (cls === 'part-old') oldAppNotes.push(`${wk.slice(8)}: ${VISIBILITY_WORDS.PART_OLD_APP}`);
        }
      }
    }
    const n = scopeWindows.size;
    const approved: 0 | 1 = approvedWindows >= 1 ? 1 : 0;
    const excl = data.excludedByOutlet.get(code) ?? { olderFrequency: 0, notInProgramme: 0 };
    const extras: string[] = [];
    if (waitingWindows) extras.push(`${waitingWindows} waiting for review`);
    if (openWindows) extras.push(`${plural(openWindows, 'window')} still open`);
    if (notApprovedWindows) extras.push(`${notApprovedWindows} re-take requested / rejected`);
    extras.push(...oldAppNotes);
    if (excl.olderFrequency) extras.push(`${plural(excl.olderFrequency, 'approval')} under an older capture frequency not counted`);
    data.byOutlet.set(code, {
      approvedWindows,
      approved,
      windows: n,
      inScope: 1,
      scope: 'IN_SCOPE',
      waitingWindows,
      openWindows,
      notApprovedWindows,
      excludedApprovals: excl,
      note:
        `Visibility ${month}: ${approvedWindows} of ${plural(n, 'window')} approved` +
        (extras.length ? ` (${extras.join('; ')})` : '') +
        ` → approved=${approved}`,
    });
  }
  return data;
}

/**
 * The facts for ONE outlet: its loaded facts, else real zeros with the reason it has none — NOT in the visibility
 * scope (PHOTO_APPROVAL) or no uploaded status (AMOUNT_UPLOAD). null when the run has no usable visibility data.
 */
export function visibilityFactsFor(
  data: VisibilityInputData,
  outlet: { outletCode: string; programName?: string | null; programCategory?: string | null; outletType?: { code: string } | null },
): OutletVisibilityFacts | null {
  if (!data.available) return null;
  const hit = data.byOutlet.get(outlet.outletCode);
  if (hit) return hit;
  const excl = data.excludedByOutlet.get(outlet.outletCode) ?? { olderFrequency: 0, notInProgramme: 0 };
  const base = {
    approvedWindows: 0, approved: 0 as const, windows: 0, inScope: 0 as const, waitingWindows: 0, openWindows: 0,
    notApprovedWindows: 0, excludedApprovals: excl,
  };
  if (data.mode === 'AMOUNT_UPLOAD') {
    return { ...base, scope: 'NO_RECORD', note: `Visibility ${data.month}: no visibility status uploaded for this outlet → approved=0, inScope=0` };
  }
  const why =
    data.scopeConfig && visibilityNotApplicable(outlet, data.scopeConfig)
      ? `outlet type ${outlet.outletType?.code ?? '(none)'} / programme is not part of the visibility programme`
      : 'the outlet was not live and KYC-approved during this month’s windows';
  const lost: string[] = [];
  if (excl.notInProgramme) lost.push(`${plural(excl.notInProgramme, 'approved capture')} not counted — outlet not in the visibility programme`);
  if (excl.olderFrequency) lost.push(`${plural(excl.olderFrequency, 'approval')} under an older capture frequency not counted`);
  return {
    ...base,
    scope: 'NOT_IN_SCOPE',
    note: `Visibility ${data.month}: not in visibility scope (${why}${lost.length ? `; ${lost.join('; ')}` : ''}) → 0, inScope=0`,
  };
}

/** The EvalContext.visibility slice for one outlet (undefined = absent → each input's nullAs). */
export function visibilityContext(facts: OutletVisibilityFacts | null): EvalContext['visibility'] {
  if (!facts) return undefined;
  return { approvedWindows: facts.approvedWindows, approved: facts.approved, windows: facts.windows, inScope: facts.inScope };
}

/**
 * Run-level summary for the preview. `outletCodes` = the outlets of THIS run whose rule read visibility (a program /
 * KPI filter narrows it) — the outlet counts (incl. the pending count the admin must accept) cover only those.
 * Omitted → every outlet with data. The excluded / counted-outside-scope figures are tenant-month wide.
 */
export function summarizeVisibility(data: VisibilityInputData, outletCodes?: ReadonlySet<string>): VisibilityPreviewSummary {
  let outletsApproved = 0;
  let outletsWaitingReview = 0;
  let outletsOpenWindow = 0;
  let outletsPending = 0;
  let outletsWithData = 0;
  for (const [code, f] of data.byOutlet) {
    if (outletCodes && !outletCodes.has(code)) continue;
    outletsWithData += 1;
    if (f.approved === 1) outletsApproved += 1;
    if (f.waitingWindows > 0) outletsWaitingReview += 1;
    if (f.openWindows > 0) outletsOpenWindow += 1;
    if (f.waitingWindows > 0 || f.openWindows > 0) outletsPending += 1;
  }
  return {
    month: data.month,
    mode: data.mode,
    available: data.available,
    ...(data.unavailableReason ? { unavailableReason: data.unavailableReason } : {}),
    windows: data.windows,
    openWindowsInMonth: data.openWindowsInMonth,
    outletsApproved,
    outletsWithData,
    outletsWaitingReview,
    outletsOpenWindow,
    outletsPending,
    countedOutsideDatedScope: data.countedOutsideDatedScope,
    excluded: { ...data.excluded },
  };
}
