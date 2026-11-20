/**
 * Visibility scope = visibilityConfig.outletScope (outlet TYPES; empty = NONE, D12) AND the optional
 * APPLIES-TO program / sub-program narrowing (`programs` / `subPrograms`; empty = all) —
 * platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md §0, D9/D12.
 *
 * This is NOT a new matcher: the type facet keeps each caller's existing (exact `in`/`includes`)
 * check untouched, and the program facets are delegated to the shared AppliesTo helper
 * (`appliesToOutlet` in memory, `appliesToOutletWhere` in Prisma). When `programs` and
 * `subPrograms` are both empty (every tenant until an admin sets them — incl. Deoleo) the helpers
 * below are no-ops, so every caller's query / predicate is byte-identical to the pre-scope code.
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AppliesTo, AppliesToOutletFacets, appliesToOutlet, isUnscoped, normalizeAppliesTo } from '../common/applies-to/applies-to';
import { appliesToOutletWhere } from '../common/applies-to/applies-to.prisma';

/** The config slice these helpers read (programs/subPrograms tolerated absent on legacy rows). */
export interface VisibilityProgramScopeLike {
  programs?: ReadonlyArray<string> | null;
  subPrograms?: ReadonlyArray<string> | null;
}

/** The program/sub-program narrowing as an AppliesTo (outletTypes always empty — outletScope owns types). */
export function visibilityProgramScope(cfg: VisibilityProgramScopeLike | null | undefined): AppliesTo {
  return normalizeAppliesTo({ programs: cfg?.programs ?? [], subPrograms: cfg?.subPrograms ?? [] });
}

/** True when the config narrows by program and/or sub-program. */
export function hasVisibilityProgramScope(cfg: VisibilityProgramScopeLike | null | undefined): boolean {
  return !isUnscoped(visibilityProgramScope(cfg));
}

/** In-memory program/sub-program check (true when unscoped). The type facet is the caller's job. */
export function visibilityProgramMatches(
  cfg: VisibilityProgramScopeLike | null | undefined,
  outlet: Pick<AppliesToOutletFacets, 'program' | 'subProgram'>,
): boolean {
  const scope = visibilityProgramScope(cfg);
  if (isUnscoped(scope)) return true;
  return appliesToOutlet(scope, { program: outlet.program, subProgram: outlet.subProgram });
}

/**
 * Merge the program/sub-program narrowing into an existing Outlet where. Unscoped → returns `base`
 * UNCHANGED (same object, byte-identical query); scoped → `{ AND: [base, programWhere] }` (never a
 * spread — `base` may carry its own OR/AND).
 */
export function withVisibilityProgramWhere(
  base: Prisma.OutletWhereInput,
  cfg: VisibilityProgramScopeLike | null | undefined,
): Prisma.OutletWhereInput {
  const scope = visibilityProgramScope(cfg);
  if (isUnscoped(scope)) return base;
  return { AND: [base, appliesToOutletWhere(scope)] };
}

/**
 * THE single "in scope for visibility" outlet rule (VISIBILITY-POSM-DESIGN.md §Metrics, decided 2026-11-20).
 * An outlet is in scope when a rep can actually be asked to capture it:
 *   - not soft-deleted and not deactivated;
 *   - `isActive: true` — the outlet is KYC-approved. A pending outlet is created `isActive:false` and only
 *     flips on approval; the rep's capture list never shows it, so counting it would report a visit nobody
 *     could make as "Missed". (NOT_INTERESTED and PARKED outlets are always `isActive:false` too.)
 *   - kycIntent not NOT_INTERESTED / PARKED (belt-and-braces; `notIn` drops NULLs → the {null} branch);
 *   - outletType.code ∈ visibilityConfig.outletScope (empty = none) AND the optional programs/subPrograms.
 * Used by the rep capture list, the weekly reminder, the admin "outlets in scope" list, the visibility
 * report, the admin/operations dashboards and the daily digest — so every number counts the same outlets.
 * (Contrast the KYC program-health "addressable" universe, which deliberately has NO isActive filter — that
 * metric is about getting outlets through KYC; this one is about outlets already through it.)
 */
export function visibilityUniverseWhere(
  clientId: string,
  cfg: VisibilityProgramScopeLike & { outletScope: ReadonlyArray<string> },
): Prisma.OutletWhereInput {
  return withVisibilityProgramWhere(visibilityUniverseBase(clientId, cfg.outletScope), cfg);
}

/**
 * The FLAT part of {@link visibilityUniverseWhere} (no program narrowing) — for callers that add their own keys
 * (an id list, a NOT clause) before wrapping with `withVisibilityProgramWhere`. It owns the top-level `OR`
 * (kycIntent), so a caller that needs another OR must put it under `AND`.
 */
export function visibilityUniverseBase(clientId: string, outletScope: ReadonlyArray<string>): Prisma.OutletWhereInput {
  return {
    clientId,
    deletedAt: null,
    deactivatedAt: null,
    isActive: true,
    OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
    outletType: { code: { in: [...outletScope] } },
  };
}

/** The outlet fields {@link visibilityOutOfScopeReason} reads (select these to explain a refusal). */
export const OUT_OF_SCOPE_REASON_SELECT = {
  deletedAt: true,
  deactivatedAt: true,
  isActive: true,
  kycIntent: true,
  programName: true,
  programCategory: true,
  outletType: { select: { code: true } },
} as const;

/**
 * WHY an outlet is not in visibility scope, in plain words — for the 400 a rep gets and the reason shown instead of
 * the "Capture Visibility" button. This only EXPLAINS a decision: whether an outlet is in scope is always decided by
 * the database query on {@link visibilityUniverseWhere}. Checks run in the rule's order; null = no rule fails here.
 */
export function visibilityOutOfScopeReason(
  outlet: {
    deletedAt?: Date | null;
    deactivatedAt?: Date | null;
    isActive?: boolean | null;
    kycIntent?: string | null;
    programName?: string | null;
    programCategory?: string | null;
    outletType?: { code: string } | null;
  },
  cfg: VisibilityProgramScopeLike & { outletScope: ReadonlyArray<string> },
): string | null {
  if (outlet.deletedAt) return 'This outlet has been removed, so visibility cannot be captured for it.';
  if (outlet.deactivatedAt) return 'This outlet is deactivated, so visibility cannot be captured for it.';
  if (outlet.kycIntent === 'NOT_INTERESTED' || outlet.kycIntent === 'PARKED') {
    return `This outlet is marked ${outlet.kycIntent === 'PARKED' ? 'Parked' : 'Not interested'}, so visibility cannot be captured for it.`;
  }
  if (!outlet.isActive) return 'This outlet is not KYC-approved yet — visibility can be captured once its KYC is approved.';
  if (!outlet.outletType?.code || !cfg.outletScope.includes(outlet.outletType.code)) {
    return `Outlet type ${outlet.outletType?.code ?? '(none)'} is not part of the visibility programme.`;
  }
  if (!visibilityProgramMatches(cfg, { program: outlet.programName ?? null, subProgram: outlet.programCategory ?? null })) {
    return "This outlet's programme / sub-programme is not part of the visibility programme.";
  }
  return null;
}

// ── Write path: validate + canonicalise + carry over (plan §4, D8) ─────────────────────────────

/** The facet ↔ settings-list ↔ Outlet column mapping for the two program facets. */
const PROGRAM_FACETS = [
  { key: 'programs', settingsKey: 'outletPrograms', column: 'programName', label: 'program' },
  { key: 'subPrograms', settingsKey: 'outletCategories', column: 'programCategory', label: 'sub-program' },
] as const;

export interface VisibilityProgramLists {
  programs: string[];
  subPrograms: string[];
}

/**
 * Resolve the `programs` / `subPrograms` lists for a visibilityConfig WRITE:
 *   - a key ABSENT (undefined / null) in `requested` → CARRY OVER the stored list unchanged (stale-tab
 *     safety: an editor that predates these fields must never wipe them) — not re-validated;
 *   - a key present → must be a string array; trimmed + ci-deduped; a value ALREADY STORED (ci) is
 *     NOT re-validated (an unchanged resend of a now-stale value never 400s); every NEW value must be in
 *     (tenant settings list ∪ distinct live outlet values), case-insensitively → else 400 listing the
 *     allowed values. An empty array clears the facet (= all).
 *   - SPELLING (D8, deterministic — audit #7): EVERY submitted value (new OR already stored) is stored in
 *     its CANONICAL spelling — the settings-list spelling, else the most common live outlet spelling.
 *     Only a stored value that is no longer valid anywhere (stale) has no canonical spelling; it keeps the
 *     SUBMITTED spelling, so a case-only edit (gold → Gold) is never a silent no-op. Matching is
 *     case-insensitive, so spelling never changes which outlets are in scope. The response returns the
 *     stored config, so the editor shows the canonical spelling that was actually saved.
 * The live-values query runs only when a requested value is not already in the settings list.
 */
export async function resolveVisibilityProgramLists(
  prisma: PrismaService,
  clientId: string,
  settingsLists: { outletPrograms?: ReadonlyArray<string> | null; outletCategories?: ReadonlyArray<string> | null },
  requested: { programs?: unknown; subPrograms?: unknown },
  stored: VisibilityProgramScopeLike | null | undefined,
): Promise<VisibilityProgramLists> {
  const out: VisibilityProgramLists = { programs: [], subPrograms: [] };
  for (const f of PROGRAM_FACETS) {
    const raw = requested[f.key];
    if (raw === undefined || raw === null) {
      out[f.key] = visibilityProgramScope(stored)[f.key];
      continue;
    }
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw new BadRequestException(`visibilityConfig.${f.key} must be an array of strings.`);
    }
    const wanted = normalizeAppliesTo({ [f.key]: raw })[f.key];
    if (wanted.length === 0) continue;

    // Values ALREADY STORED (ci) are kept in their stored spelling and NOT re-validated — the editor
    // always resends the full lists, so a value that became stale after it was saved (program renamed
    // in settings, last outlet moved away) must never make an unrelated save 400 (mirrors the KPI
    // upsert's "unchanged resend is not re-validated"). Only NEWLY added values are validated.
    const storedByKey = new Map(visibilityProgramScope(stored)[f.key].map((s) => [s.toUpperCase(), s]));
    // ci key → canonical spelling of currently VALID values: settings list first (wins), then live
    // values by frequency. Queried only when a NEW value is not already in the settings list.
    const valid = new Map<string, string>();
    for (const v of settingsLists[f.settingsKey] ?? []) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t && !valid.has(t.toUpperCase())) valid.set(t.toUpperCase(), t);
    }
    const isNew = (v: string) => !storedByKey.has(v.toUpperCase());
    // Live values are needed whenever a submitted value (new OR stored) is not in the settings list —
    // to validate a new value, and to canonicalise a stored one to its live spelling.
    if (wanted.some((v) => !valid.has(v.toUpperCase()))) {
      const live = (await prisma.outlet.groupBy({
        by: [f.column],
        where: { clientId, deletedAt: null, [f.column]: { not: null } },
        _count: { _all: true },
      })) as unknown as Array<Record<string, unknown> & { _count: { _all: number } }>;
      const ranked = [...live].sort((a, b) => b._count._all - a._count._all);
      for (const row of ranked) {
        const v = row[f.column];
        const t = typeof v === 'string' ? v.trim() : '';
        if (t && !valid.has(t.toUpperCase())) valid.set(t.toUpperCase(), t);
      }
    }
    const unknown = wanted.filter((v) => isNew(v) && !valid.has(v.toUpperCase()));
    if (unknown.length > 0) {
      const allowed = [...valid.values()].sort((a, b) => a.localeCompare(b));
      throw new BadRequestException(
        `Unknown ${f.label}${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
          `Allowed: ${allowed.length ? allowed.join(', ') : '(none configured)'}.`,
      );
    }
    // Canonical spelling wins for every value; a stale stored value (no canonical) keeps the submitted spelling.
    out[f.key] = wanted.map((v) => valid.get(v.toUpperCase()) ?? v);
  }
  return out;
}
