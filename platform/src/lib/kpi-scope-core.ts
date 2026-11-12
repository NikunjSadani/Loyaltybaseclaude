/**
 * APPLIES-TO targeting (APPLIES-TO-TARGETING-PLAN §6) — PURE FE helpers for KPI scope (no React, no network), safe to
 * import from any module. Builds on the WP-0 mirror `@/lib/applies-to`. Hooks live in `@/lib/kpi-scope`.
 */
import { normalizeAppliesTo, type AppliesTo, type AppliesToInput } from '@/lib/applies-to';

/** The KpiDef fields that carry scope (arrays new; single `outletType` DEPRECATED, one release). */
export interface KpiScopeFieldsLike {
  outletType?: string | null;
  outletTypes?: string[] | null;
  programs?: string[] | null;
  subPrograms?: string[] | null;
}

/** A KPI's applies-to scope; a legacy single `outletType` (no `outletTypes`) reads as a one-type scope. */
export function kpiScopeOf(kpi: KpiScopeFieldsLike | undefined | null): AppliesTo {
  const s = normalizeAppliesTo(kpi);
  const legacy = (kpi?.outletType ?? '').trim().toUpperCase();
  if (s.outletTypes.length === 0 && legacy) s.outletTypes = [legacy];
  return s;
}

/** List-row chip text, e.g. "RLP · Unnati · Lite" (facets joined by " · ", values within a facet by ", "), or "All outlets". */
export function scopeChipText(s: AppliesTo, typeLabel: (code: string) => string = (c) => c): string {
  const facets = [s.outletTypes.map(typeLabel), s.programs, s.subPrograms].filter((f) => f.length > 0);
  return facets.length ? facets.map((f) => f.join(', ')).join(' · ') : 'All outlets';
}

/** Long form for a tooltip / accessible description. */
export function scopeDescription(s: AppliesTo, typeLabel: (code: string) => string = (c) => c): string {
  const parts: string[] = [];
  if (s.outletTypes.length) parts.push(`Outlet types: ${s.outletTypes.map(typeLabel).join(', ')}`);
  if (s.programs.length) parts.push(`Programs: ${s.programs.join(', ')}`);
  if (s.subPrograms.length) parts.push(`Sub-Programs: ${s.subPrograms.join(', ')}`);
  return parts.length ? parts.join('; ') : 'Applies to every outlet';
}

export type ScopeFacet = 'outletTypes' | 'programs' | 'subPrograms';
export const FACET_NOUN: Record<ScopeFacet, string> = {
  outletTypes: 'outlet type', programs: 'program', subPrograms: 'sub-program',
};

export interface FacetMismatch {
  facet: ScopeFacet;
  /** The chosen values that fall outside the KPI's scope on this facet. */
  outside: string[];
  /** Every chosen value is outside → no overlap at all on this facet. */
  disjoint: boolean;
  /** The KPI's own values on this facet. */
  kpiValues: string[];
}

/**
 * Where another object's audience (a points rule's program / sub-program, an offer's programs / outlet types) reaches
 * outside a KPI's scope. A facet is compared only when BOTH sides are restricted (empty = all, so it always overlaps).
 * Trimmed + case-insensitive (D8).
 */
export function scopeMismatches(kpi: AppliesTo, chosen: Partial<Record<ScopeFacet, ReadonlyArray<string | null | undefined>>>): FacetMismatch[] {
  const out: FacetMismatch[] = [];
  for (const facet of ['outletTypes', 'programs', 'subPrograms'] as ScopeFacet[]) {
    const kpiValues = kpi[facet];
    const picked = (chosen[facet] ?? []).map((v) => (v ?? '').trim()).filter(Boolean);
    if (kpiValues.length === 0 || picked.length === 0) continue;
    const inKpi = (v: string) => kpiValues.some((k) => k.trim().toUpperCase() === v.toUpperCase());
    const outside = picked.filter((v) => !inKpi(v));
    if (outside.length) out.push({ facet, outside, disjoint: outside.length === picked.length, kpiValues });
  }
  return out;
}

/** Canonical, order-insensitive key — "did the scope change?" and "is this count response still current?". */
export function scopeKey(s: AppliesToInput): string {
  const n = normalizeAppliesTo(s);
  const norm = (xs: string[]) => xs.map((x) => x.toUpperCase()).sort();
  return JSON.stringify([norm(n.outletTypes), norm(n.programs), norm(n.subPrograms)]);
}

/**
 * Query string for scope-count (empty facets omitted = "all"). Each value is its OWN repeated param
 * (`programs=A&programs=B`) — never comma-joined, so a value containing a comma survives intact.
 */
export function scopeCountQuery(s: AppliesTo): string {
  const n = normalizeAppliesTo(s);
  const parts: string[] = [];
  for (const v of n.outletTypes) parts.push(`outletTypes=${encodeURIComponent(v)}`);
  for (const v of n.programs) parts.push(`programs=${encodeURIComponent(v)}`);
  for (const v of n.subPrograms) parts.push(`subPrograms=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
