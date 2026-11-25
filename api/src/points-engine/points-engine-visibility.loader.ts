/**
 * points-engine-visibility.loader.ts — the outlet's VISIBILITY (POSM) result for a compute month, as Points
 * Compute Engine inputs (`source: "visibility:approved | approvedWindows | windows"`). Owner decision 2026-11-25
 * (shared engine, owner-approved) — POINTS-COMPUTE-ENGINE-DESIGN.md §3a.
 *
 * Loaded by PointsComputeService ONLY when a resolved rule declares a visibility input (so a tenant whose rules do
 * not use visibility — Deoleo today — runs exactly the queries it ran before). Tenant-scoped (clientId on every
 * query) and N+1-free: PHOTO_APPROVAL = 2 parallel queries (the month's counted captures + the in-scope outlets);
 * AMOUNT_UPLOAD = 1 query (the month's uploaded status records). Keyed by outletCode.
 *
 * ── "Approved" — the visibility module's own rule, not a new one ────────────────────────────────────────────
 * PHOTO_APPROVAL: a window counts as approved exactly when the Visibility report counts that outlet-window as
 * "Approved" (visibility-report.service buildSlots → plainStatusOf): the capture's FINAL status is APPROVED and the
 * outlet is in THAT window's visibility universe (visibilityWindowUniverseWhere — a closed window uses the outlets
 * that were live + KYC-approved during it; an open one uses today's in-scope outlets).
 *   - Per-photo review: the capture status is server-derived (all required photos APPROVED → APPROVED; any rejected
 *     → CHANGES_REQUESTED; else SUBMITTED), so a half-reviewed capture is NOT approved.
 *   - Imported old-app captures are stored APPROVED (the old app kept only approved visits) → they COUNT.
 *   - SUBMITTED (waiting for review), CHANGES_REQUESTED, REJECTED — open or closed window — do NOT count. Waiting /
 *     not-approved windows are named in the trace so a pending review is never a silent 0.
 *   - Only the windows of the month at the tenant's CURRENT frequency are read (the report ignores a window key
 *     from an older frequency too — `otherWindow`).
 * AMOUNT_UPLOAD: the month's uploaded OutletVisibilityRecord (one per outlet × month); status APPROVED → 1 approved
 * window of 1. PENDING / UNDER_REVIEW → 0. No record → 0 ("no status uploaded").
 *
 * The data is read AS OF the compute: an approval that lands later changes the next compute's result (and the
 * POINTS sourceKey, so the commit TOCTOU guard catches it).
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { EvalContext } from './points-engine.types';
import { monthWindows } from '../visibility/visibility-metrics';
import { windowRangeUtc } from '../visibility/visibility-report-scope';
import { visibilityNotApplicable, visibilityWindowUniverseWhere } from '../visibility/visibility-scope.helper';

export type VisibilityScopeState = 'IN_SCOPE' | 'NOT_IN_SCOPE' | 'NO_RECORD';

/** One outlet's visibility facts for the month (+ the plain line the preview trace shows). */
export interface OutletVisibilityFacts {
  approvedWindows: number;
  approved: 0 | 1;
  windows: number;
  scope: VisibilityScopeState;
  /** PHOTO_APPROVAL only: windows whose capture is still waiting for review. */
  waitingWindows: number;
  /** PHOTO_APPROVAL only: windows with a re-take request / rejection (not approved). */
  notApprovedWindows: number;
  /** Plain one-liner for the explanation / trace ("Visibility 2026-11: 1 of 2 windows approved → approved=1"). */
  note: string;
}

/** The run-level result (also surfaced on the preview so an unusable setup is loud, never silent). */
export interface VisibilityInputData {
  month: string;
  mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  /** false → no usable visibility data for this tenant: every visibility input is ABSENT (its nullAs applies). */
  available: boolean;
  /** Why it is unavailable (plain words) — appended to the SKIP reason of every affected row. */
  unavailableReason?: string;
  /** Windows in the month (1–4; 1 for AMOUNT_UPLOAD). */
  windows: number;
  /** Facts per outletCode for outlets with data; use {@link visibilityFactsFor} for any outlet. */
  byOutlet: Map<string, OutletVisibilityFacts>;
  /** Visibility config slice used to explain an out-of-scope outlet (PHOTO_APPROVAL). */
  scopeConfig?: { outletScope: string[]; programs: string[]; subPrograms: string[] };
}

/** Summary on ComputePreview.visibility (only when a rule used visibility). */
export interface VisibilityPreviewSummary {
  month: string;
  mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  available: boolean;
  unavailableReason?: string;
  windows: number;
  /** Outlets with ≥ 1 approved window this month. */
  outletsApproved: number;
  /** Outlets in the visibility scope (PHOTO_APPROVAL) / with an uploaded status (AMOUNT_UPLOAD). */
  outletsWithData: number;
}

interface VisibilityConfigLike {
  outletScope?: string[] | null;
  frequencyPerMonth?: number | null;
  programs?: string[] | null;
  subPrograms?: string[] | null;
}

type LoaderPrisma = Pick<PrismaService, 'visibilityCapture' | 'outlet' | 'outletVisibilityRecord'>;

function unavailable(month: string, mode: VisibilityInputData['mode'], reason: string, windows = 0): VisibilityInputData {
  return { month, mode, available: false, unavailableReason: reason, windows, byOutlet: new Map() };
}

/**
 * Load the month's visibility result for the whole tenant. `enabled` / `mode` / `config` are the tenant's
 * resolved visibility settings (master switch, capture mode, visibilityConfig). `now` decides open vs closed
 * windows (the same clock rule as the report).
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
    const byOutlet = new Map<string, OutletVisibilityFacts>();
    for (const r of records) {
      const ok = r.status === 'APPROVED';
      byOutlet.set(r.outletCode, {
        approvedWindows: ok ? 1 : 0,
        approved: ok ? 1 : 0,
        windows: 1,
        scope: 'IN_SCOPE',
        waitingWindows: 0,
        notApprovedWindows: 0,
        note: ok
          ? `Visibility ${month} (uploaded status): APPROVED → approved=1`
          : `Visibility ${month} (uploaded status): ${r.status} — not approved → approved=0`,
      });
    }
    return { month, mode, available: true, windows: 1, byOutlet };
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
  // THE per-window universe the Visibility report uses — so "approved" here = "Approved" on the report.
  const universes: Array<{ key: string; where: Prisma.OutletWhereInput }> = windows.map((w) => ({
    key: w.key,
    where: visibilityWindowUniverseWhere(clientId, scopeCfg, { ...windowRangeUtc(w.key, freq), closed: w.closed }),
  }));

  const [captures, inScope] = await Promise.all([
    prisma.visibilityCapture.findMany({
      where: { clientId, OR: universes.map((u) => ({ windowKey: u.key, outlet: u.where })) },
      select: { windowKey: true, status: true, outlet: { select: { outletCode: true } } },
    }),
    prisma.outlet.findMany({
      where: { OR: universes.map((u) => u.where) },
      select: { outletCode: true },
    }),
  ]);

  const approvedBy = new Map<string, Set<string>>();
  const waitingBy = new Map<string, Set<string>>();
  const notApprovedBy = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, code: string, wk: string) => {
    const s = m.get(code) ?? new Set<string>();
    s.add(wk);
    m.set(code, s);
  };
  for (const c of captures) {
    const code = c.outlet?.outletCode;
    if (!code) continue;
    if (c.status === 'APPROVED') add(approvedBy, code, c.windowKey);
    else if (c.status === 'SUBMITTED') add(waitingBy, code, c.windowKey);
    else add(notApprovedBy, code, c.windowKey); // CHANGES_REQUESTED / REJECTED (open or closed window)
  }

  const n = windows.length;
  const byOutlet = new Map<string, OutletVisibilityFacts>();
  for (const o of inScope) {
    const approvedWindows = approvedBy.get(o.outletCode)?.size ?? 0;
    const waitingWindows = waitingBy.get(o.outletCode)?.size ?? 0;
    const notApprovedWindows = notApprovedBy.get(o.outletCode)?.size ?? 0;
    const approved: 0 | 1 = approvedWindows >= 1 ? 1 : 0;
    const extras: string[] = [];
    if (waitingWindows) extras.push(`${waitingWindows} waiting for review`);
    if (notApprovedWindows) extras.push(`${notApprovedWindows} re-take requested / rejected`);
    byOutlet.set(o.outletCode, {
      approvedWindows,
      approved,
      windows: n,
      scope: 'IN_SCOPE',
      waitingWindows,
      notApprovedWindows,
      note:
        `Visibility ${month}: ${approvedWindows} of ${n} window${n === 1 ? '' : 's'} approved` +
        (extras.length ? ` (${extras.join(', ')})` : '') +
        ` → approved=${approved}`,
    });
  }
  return { month, mode, available: true, windows: n, byOutlet, scopeConfig: scopeCfg };
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
  if (data.mode === 'AMOUNT_UPLOAD') {
    return {
      approvedWindows: 0, approved: 0, windows: data.windows, scope: 'NO_RECORD', waitingWindows: 0, notApprovedWindows: 0,
      note: `Visibility ${data.month}: no visibility status uploaded for this outlet → approved=0`,
    };
  }
  const why =
    data.scopeConfig && visibilityNotApplicable(outlet, data.scopeConfig)
      ? `outlet type ${outlet.outletType?.code ?? '(none)'} / programme is not part of the visibility programme`
      : 'the outlet was not live and KYC-approved during this month’s windows';
  return {
    approvedWindows: 0, approved: 0, windows: data.windows, scope: 'NOT_IN_SCOPE', waitingWindows: 0, notApprovedWindows: 0,
    note: `Visibility ${data.month}: not in visibility scope (${why}) → 0`,
  };
}

/** The EvalContext.visibility slice for one outlet (undefined = absent → each input's nullAs). */
export function visibilityContext(facts: OutletVisibilityFacts | null): EvalContext['visibility'] {
  if (!facts) return undefined;
  return { approvedWindows: facts.approvedWindows, approved: facts.approved, windows: facts.windows };
}

/** Run-level summary for the preview. */
export function summarizeVisibility(data: VisibilityInputData): VisibilityPreviewSummary {
  let outletsApproved = 0;
  for (const f of data.byOutlet.values()) if (f.approved === 1) outletsApproved += 1;
  return {
    month: data.month,
    mode: data.mode,
    available: data.available,
    ...(data.unavailableReason ? { unavailableReason: data.unavailableReason } : {}),
    windows: data.windows,
    outletsApproved,
    outletsWithData: data.byOutlet.size,
  };
}
