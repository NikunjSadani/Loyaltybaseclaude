'use client';

import { useEffect, useMemo, useState } from 'react';

/** One enabled outlet type for the signed-in tenant (GET /api/settings/outlet-types). */
export interface OutletTypeOption {
  /** STABLE logic key (SSS / WHOLESALER / …) — used for filtering/logic, never localized. */
  code: string;
  /** `displayName ?? name` — ready label for a consumer with no hardcoded fallback. */
  label: string;
  /** The global OutletType.name. */
  name: string;
  /** Per-tenant override; `null` when the tenant set none (e.g. Deoleo). */
  displayName: string | null;
}

export interface OutletTypeLabels {
  /**
   * code → per-tenant DISPLAY override, for codes the tenant actually renamed. EMPTY until the
   * fetch resolves, on failure, and for a tenant with no overrides (e.g. Deoleo). A surface MUST
   * therefore keep its OWN current hardcoded label as the fallback: `overrides.get(code) ?? current`
   * — which is exactly `label(code, current)` below. This is what keeps Deoleo byte-identical and
   * flicker-free (no flash of a wrong label before the fetch lands).
   */
  overrides: ReadonlyMap<string, string>;
  /** The tenant's enabled outlet types, as returned by the endpoint (empty until resolved). */
  types: OutletTypeOption[];
  /**
   * Resolve one code's label: the tenant override if present, else the caller's CURRENT hardcoded
   * label. Pass each surface's EXISTING literal as `fallback` so nothing changes for a tenant with
   * no override.
   */
  label: (code: string, fallback: string) => string;
  /** True only while the first fetch is in flight (never blocks render — fallbacks are live). */
  loading: boolean;
}

const EMPTY_OVERRIDES: ReadonlyMap<string, string> = new Map();

/**
 * Config-driven outlet-type DISPLAY labels for the signed-in tenant. Fetches
 * GET /api/settings/outlet-types (JWT-scoped) and exposes the per-tenant `displayName` overrides so
 * any picker/filter/label surface can render a tenant's custom label (e.g. Bajaj SSS→"RLP",
 * WHOLESALER→"BSC") WITHOUT a `slug === 'bajaj'` branch.
 *
 * BYTE-IDENTICAL GUARANTEE: the override map is empty until the fetch resolves, on any failure, and
 * for every tenant that set no override. So `label(code, <current literal>)` returns the current
 * literal in all of those cases — Deoleo and every other tenant render exactly as before, with no
 * label flash during load.
 */
export function useOutletTypeLabels(): OutletTypeLabels {
  const [types, setTypes] = useState<OutletTypeOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/settings/outlet-types', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        // Envelope: { success: true, data: OutletTypeOption[] } (global TransformInterceptor).
        const data = j?.success && Array.isArray(j.data) ? (j.data as OutletTypeOption[]) : null;
        if (alive && data) setTypes(data);
      })
      .catch(() => {
        /* keep empty overrides ⇒ every surface falls back to its hardcoded label */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const overrides = useMemo<ReadonlyMap<string, string>>(() => {
    if (types.length === 0) return EMPTY_OVERRIDES;
    const m = new Map<string, string>();
    for (const t of types) {
      const dn = t.displayName?.trim();
      if (dn) m.set(t.code, dn);
    }
    return m;
  }, [types]);

  const label = useMemo(
    () => (code: string, fallback: string) => overrides.get(code) ?? fallback,
    [overrides],
  );

  return { overrides, types, label, loading };
}
