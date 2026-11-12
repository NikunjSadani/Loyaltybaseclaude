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
