/* ─── Tenant KPI Definition Config ───────────────────────────────────────────
 *
 * Multi-tenant: each client can have its own KPI set.
 * DEOLEO_DEFAULT_KPIS is the seed for the Deoleo tenant.
 * Stored in localStorage under KPIS_STORAGE_KEY; in production this
 * comes from the tenant's settings in the database.
 *
 * KPI extensibility:
 *  • Add a new KPI → push a new TenantKpiDef entry (admin UI or direct config)
 *  • Remove a KPI → set enabled: false
 *  • Rename a KPI → update label
 *  • Add a name-override column → set hasNameOverride: true + nameOverrideLabel
 *  No code changes needed — template generator and parser are config-driven.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface TenantKpiDef {
  id:                string;   // stable internal code e.g. 'FOCUS_PACK_1'
  label:             string;   // column header in template e.g. 'Focus Pack - 1'
  unit:              string;   // 'cases', 'units', etc.
  isPrimary:         boolean;  // headline KPI shown on dashboards
  hasNameOverride:   boolean;  // when true, a name-override column is added to template
  nameOverrideLabel: string;   // header for the name-override column e.g. 'Focus Pack 1 Name'
  order:             number;   // 1-based display / column order
  enabled:           boolean;  // disabled KPIs are hidden from template and UI
}

// ── Deoleo defaults ───────────────────────────────────────────────────────────

export const DEOLEO_DEFAULT_KPIS: TenantKpiDef[] = [
  {
    id:                'MONTH_TGT',
    label:             'Month Target',
    unit:              'cases',
    isPrimary:         true,
    hasNameOverride:   false,
    nameOverrideLabel: '',
    order:             1,
    enabled:           true,
  },
  {
    id:                'FOCUS_PACK_1',
    label:             'Focus Pack - 1',
    unit:              'cases',
    isPrimary:         false,
    hasNameOverride:   true,
    nameOverrideLabel: 'Focus Pack 1 Name',
    order:             2,
    enabled:           true,
  },
  {
    id:                'FOCUS_PACK_2',
    label:             'Focus Pack - 2',
    unit:              'cases',
    isPrimary:         false,
    hasNameOverride:   true,
    nameOverrideLabel: 'Focus Pack 2 Name',
    order:             3,
    enabled:           true,
  },
  {
    id:                'FOCUS_CATEGORY',
    label:             'Focus Category',
    unit:              'cases',
    isPrimary:         false,
    hasNameOverride:   true,
    nameOverrideLabel: 'Focus Category Name',
    order:             4,
    enabled:           true,
  },
  {
    id:                'CONSISTENCY',
    label:             'Consistency Target',
    unit:              'cases',
    isPrimary:         false,
    hasNameOverride:   false,
    nameOverrideLabel: '',
    order:             5,
    enabled:           true,
  },
];

// ── Storage ───────────────────────────────────────────────────────────────────

export const KPIS_STORAGE_KEY = 'gifsy_tenant_kpi_defs_v1';

export function getTenantKpiDefs(): TenantKpiDef[] {
  if (typeof window === 'undefined') return DEOLEO_DEFAULT_KPIS;
  try {
    const raw = localStorage.getItem(KPIS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TenantKpiDef[];
  } catch { /* ignore */ }
  return DEOLEO_DEFAULT_KPIS;
}

export function saveTenantKpiDefs(defs: TenantKpiDef[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(defs));
  } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns only enabled KPIs, sorted by order. */
export function getEnabledKpiDefs(defs: TenantKpiDef[]): TenantKpiDef[] {
  return [...defs].filter(d => d.enabled).sort((a, b) => a.order - b.order);
}

/** Generate a new unique KPI id from a proposed label. */
export function makeKpiId(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}
