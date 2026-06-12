/* ─── Types ──────────────────────────────────────────────────────────────────── */

export type ParamType  = 'sales_value' | 'focus_product' | 'focus_category' | 'lines' | 'visit_freq';
export type GeoLevel   = 'national' | 'state' | 'district' | 'beat';
export type PeriodType = 'monthly' | 'quarterly';

export interface TargetParam {
  id: string;
  type: ParamType;
  label: string;          // e.g. "Bertolli 500ml", "Focus Category", "Sales Value"
  unit: string;           // e.g. "₹L", "cases", "SKUs", "visits"
  target: number;
  isPrimary?: boolean;    // the one KPI the admin designates as the headline metric
}

export interface GeoTargetConfig {
  id: string;
  level: GeoLevel;
  geoName: string;        // "Maharashtra", "Mumbai West", "Andheri Beat"
  period: string;         // "YYYY-MM"
  periodType: PeriodType;
  params: TargetParam[];
  updatedAt: string;
}

export interface OutletAchievement {
  outletId: string;
  period: string;
  achievements: Record<string, number>; // paramId → achieved value
}

/* ─── Labels ─────────────────────────────────────────────────────────────────── */

export const PARAM_TYPE_LABELS: Record<ParamType, string> = {
  sales_value:    'Sales Value',
  focus_product:  'Focus Product',
  focus_category: 'Focus Category',
  lines:          'Number of Lines',
  visit_freq:     'Visit Frequency',
};

export const GEO_LEVEL_LABELS: Record<GeoLevel, string> = {
  national: 'National',
  state:    'State',
  district: 'District / Zone',
  beat:     'Beat / Area',
};

/* ─── Seed configs ───────────────────────────────────────────────────────────── */

export const DEFAULT_PARAMS: TargetParam[] = [
  { id: 'p_sv',  type: 'sales_value',    label: 'Monthly Volume',  unit: 'cases', target: 500, isPrimary: true },
  { id: 'p_fp1', type: 'focus_product',  label: 'Focus Product 1', unit: 'cases', target: 50 },
  { id: 'p_fp2', type: 'focus_product',  label: 'Focus Product 2', unit: 'cases', target: 30 },
  { id: 'p_fc',  type: 'focus_category', label: 'Focus Category',  unit: 'cases', target: 100 },
  { id: 'p_ln',  type: 'lines',          label: 'No. of Lines',    unit: 'SKUs',  target: 5 },
];

const SEED_CONFIGS: GeoTargetConfig[] = [
  {
    id: 'cfg1', level: 'state', geoName: 'Maharashtra',
    period: '2026-05', periodType: 'monthly', updatedAt: '2026-05-01T09:00:00',
    params: [
      { id: 'p_sv',  type: 'sales_value',    label: 'Monthly Volume',  unit: 'cases', target: 500, isPrimary: true },
      { id: 'p_fp1', type: 'focus_product',  label: 'Focus Product 1', unit: 'cases', target: 50 },
      { id: 'p_fp2', type: 'focus_product',  label: 'Focus Product 2', unit: 'cases', target: 30 },
      { id: 'p_fc',  type: 'focus_category', label: 'Focus Category',  unit: 'cases', target: 100 },
      { id: 'p_ln',  type: 'lines',          label: 'No. of Lines',    unit: 'SKUs',  target: 5 },
    ],
  },
  {
    id: 'cfg2', level: 'district', geoName: 'Mumbai West',
    period: '2026-05', periodType: 'monthly', updatedAt: '2026-05-02T10:00:00',
    params: [
      { id: 'p_sv',  type: 'sales_value',    label: 'Monthly Volume',  unit: 'cases', target: 600, isPrimary: true },
      { id: 'p_fp1', type: 'focus_product',  label: 'Focus Product 1', unit: 'cases', target: 60 },
      { id: 'p_fp2', type: 'focus_product',  label: 'Focus Product 2', unit: 'cases', target: 40 },
      { id: 'p_fc',  type: 'focus_category', label: 'Focus Category',  unit: 'cases', target: 120 },
      { id: 'p_ln',  type: 'lines',          label: 'No. of Lines',    unit: 'SKUs',  target: 6 },
    ],
  },
  {
    id: 'cfg3', level: 'beat', geoName: 'Andheri Beat',
    period: '2026-05', periodType: 'monthly', updatedAt: '2026-05-03T11:00:00',
    params: [
      { id: 'p_sv',  type: 'sales_value',    label: 'Monthly Volume',  unit: 'cases', target: 800, isPrimary: true },
      { id: 'p_fp1', type: 'focus_product',  label: 'Focus Product 1', unit: 'cases', target: 70 },
      { id: 'p_fp2', type: 'focus_product',  label: 'Focus Product 2', unit: 'cases', target: 45 },
      { id: 'p_fc',  type: 'focus_category', label: 'Focus Category',  unit: 'cases', target: 140 },
      { id: 'p_ln',  type: 'lines',          label: 'No. of Lines',    unit: 'SKUs',  target: 7 },
    ],
  },
];

/* ─── Demo geo constants — single source of truth for all pages ─────────────── */
// Used by: partner dashboard heroes, partner targets page, sales outlets page
export const DEMO_BEAT     = 'Andheri Beat';
export const DEMO_DISTRICT = 'Mumbai West';
export const DEMO_STATE    = 'Maharashtra';
export const DEMO_PERIOD   = '2026-05';

/* ─── Per-outlet achievement mock data ───────────────────────────────────────── */
// Keyed by outletId. All pct values reference cfg3 (Andheri Beat, target 800 cases).
// This is the SINGLE source of truth for achievement % across:
//   • Partner dashboard hero cards
//   • Partner targets page
//   • Sales team outlets table & dashboard

export const OUTLET_ACHIEVEMENTS: Record<string, OutletAchievement> = {
  o1: {  // Wholesaler — 76% (610/800 cases)
    outletId: 'o1', period: DEMO_PERIOD,
    achievements: { p_sv: 610, p_fp1: 52, p_fp2: 38, p_fc: 108, p_ln: 6 },
  },
  o2: {  // Retailer — 77% (616/800 cases)
    outletId: 'o2', period: DEMO_PERIOD,
    achievements: { p_sv: 616, p_fp1: 48, p_fp2: 32, p_fc: 107, p_ln: 5 },
  },
  o3: {  // Sub-Stockist — 100% MET (800/800 cases)
    outletId: 'o3', period: DEMO_PERIOD,
    achievements: { p_sv: 800, p_fp1: 70, p_fp2: 45, p_fc: 140, p_ln: 7 },
  },
  o4: {  // MT — 95% (760/800 cases)
    outletId: 'o4', period: DEMO_PERIOD,
    achievements: { p_sv: 760, p_fp1: 68, p_fp2: 44, p_fc: 135, p_ln: 7 },
  },
  o5: {  // Sub-Stockist — 55% (440/800 cases)
    outletId: 'o5', period: DEMO_PERIOD,
    achievements: { p_sv: 440, p_fp1: 33, p_fp2: 22, p_fc: 68,  p_ln: 4 },
  },
  o6: {  // Retailer — 38% (304/800 cases)
    outletId: 'o6', period: DEMO_PERIOD,
    achievements: { p_sv: 304, p_fp1: 22, p_fp2: 14, p_fc: 48,  p_ln: 3 },
  },
  o7: {  // Wholesaler — 82% (656/800 cases)
    outletId: 'o7', period: DEMO_PERIOD,
    achievements: { p_sv: 656, p_fp1: 58, p_fp2: 42, p_fc: 118, p_ln: 6 },
  },
  o8: {  // Retailer — 61% (488/800 cases)
    outletId: 'o8', period: DEMO_PERIOD,
    achievements: { p_sv: 488, p_fp1: 38, p_fp2: 26, p_fc: 82,  p_ln: 5 },
  },
  // xsr3 outlets (Versova Beat — high performer ~91%)
  o9: {  // Retailer — 115% (920/800)
    outletId: 'o9', period: DEMO_PERIOD,
    achievements: { p_sv: 920, p_fp1: 82, p_fp2: 56, p_fc: 168, p_ln: 8 },
  },
  o10: { // Wholesaler — 108% (860/800)
    outletId: 'o10', period: DEMO_PERIOD,
    achievements: { p_sv: 860, p_fp1: 76, p_fp2: 50, p_fc: 157, p_ln: 7 },
  },
  // xsr4 outlets (DN Nagar Beat — low performer ~44%)
  o11: { // Retailer — 34% (270/800)
    outletId: 'o11', period: DEMO_PERIOD,
    achievements: { p_sv: 270, p_fp1: 19, p_fp2: 11, p_fc: 38,  p_ln: 2 },
  },
  o12: { // Wholesaler — 49% (390/800)
    outletId: 'o12', period: DEMO_PERIOD,
    achievements: { p_sv: 390, p_fp1: 29, p_fp2: 17, p_fc: 53,  p_ln: 3 },
  },
  o13: { // Sub-Stockist — 43% (345/800)
    outletId: 'o13', period: DEMO_PERIOD,
    achievements: { p_sv: 345, p_fp1: 26, p_fp2: 14, p_fc: 48,  p_ln: 2 },
  },
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

export function pct(achieved: number, target: number): number {
  if (target === 0) return 0;
  return Math.min(Math.round((achieved / target) * 100), 999);
}

// Green = target hit or exceeded (≥100%). Below target uses amber/orange/red.
export function pctColor(p: number): string {
  if (p >= 100) return 'text-emerald-600';
  if (p >= 80)  return 'text-amber-600';
  if (p >= 60)  return 'text-orange-500';
  return 'text-red-500';
}

export function pctBg(p: number): string {
  if (p >= 100) return 'bg-emerald-100 text-emerald-700';
  if (p >= 80)  return 'bg-amber-50 text-amber-600';
  if (p >= 60)  return 'bg-orange-50 text-orange-600';
  return 'bg-red-50 text-red-500';
}

export function pctBarColor(p: number): string {
  if (p >= 100) return 'bg-emerald-500';
  if (p >= 80)  return 'bg-amber-400';
  if (p >= 60)  return 'bg-orange-400';
  return 'bg-red-400';
}

/**
 * Returns the param marked `isPrimary: true`.
 * Falls back to the first param when none is explicitly marked (backwards-compatible).
 * Works generically for both TargetParam (old system) and KpiParam (new system).
 */
export function getPrimaryParam<T extends { isPrimary?: boolean }>(params: T[]): T | null {
  return params.find((p) => p.isPrimary) ?? params[0] ?? null;
}

/* ─── localStorage helpers ───────────────────────────────────────────────────── */

const CFG_KEY = 'loyaltybase_target_configs_v3';   // v3 — volume (cases) not INR

export function getAllConfigs(): GeoTargetConfig[] {
  if (typeof window === 'undefined') return SEED_CONFIGS;
  const raw = localStorage.getItem(CFG_KEY);
  if (!raw) { localStorage.setItem(CFG_KEY, JSON.stringify(SEED_CONFIGS)); return SEED_CONFIGS; }
  try { return JSON.parse(raw) as GeoTargetConfig[]; } catch { return SEED_CONFIGS; }
}

export function saveAllConfigs(configs: GeoTargetConfig[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CFG_KEY, JSON.stringify(configs));
}

export function upsertConfig(cfg: GeoTargetConfig): void {
  const all = getAllConfigs();
  const idx = all.findIndex((c) => c.id === cfg.id);
  if (idx >= 0) all[idx] = cfg; else all.unshift(cfg);
  saveAllConfigs(all);
}

export function deleteConfig(id: string): void {
  saveAllConfigs(getAllConfigs().filter((c) => c.id !== id));
}

/** Find the most specific config that applies to a given geo hierarchy */
export function resolveConfig(
  beat: string, district: string, state: string, period: string,
): GeoTargetConfig | null {
  const all = getAllConfigs().filter((c) => c.period === period);
  return (
    all.find((c) => c.level === 'beat'     && c.geoName === beat)     ??
    all.find((c) => c.level === 'district' && c.geoName === district) ??
    all.find((c) => c.level === 'state'    && c.geoName === state)    ??
    all.find((c) => c.level === 'national')                           ??
    null
  );
}

/**
 * Maps every member ID to the geo inputs needed for resolveConfig().
 * Beat-level members resolve to their beat config (most specific).
 * District/state-level members fall back to their district or state config.
 * Zone/national managers resolve to the national config.
 */
export const MEMBER_TERRITORY: Record<string, { beat: string; district: string; state: string }> = {
  xsr1: { beat: 'Andheri Beat', district: 'Mumbai West', state: 'Maharashtra' },
  xsr2: { beat: 'Juhu Beat',    district: 'Mumbai West', state: 'Maharashtra' },
  xsr3: { beat: 'Versova Beat', district: 'Mumbai West', state: 'Maharashtra' },
  xsr4: { beat: 'DN Nagar Beat',district: 'Mumbai West', state: 'Maharashtra' },
  so1:  { beat: '',             district: 'Mumbai West', state: 'Maharashtra' },
  so2:  { beat: '',             district: 'Mumbai East', state: 'Maharashtra' },
  so3:  { beat: '',             district: 'Thane City',  state: 'Maharashtra' },
  so4:  { beat: '',             district: 'Navi Mumbai', state: 'Maharashtra' },
  asm1: { beat: '',             district: '',            state: 'Maharashtra' },
  asm2: { beat: '',             district: '',            state: 'Maharashtra' },
  asm3: { beat: '',             district: '',            state: 'Maharashtra' },
  asm4: { beat: '',             district: '',            state: 'Maharashtra' },
  rsm1: { beat: '',             district: '',            state: 'Maharashtra' },
  rsm2: { beat: '',             district: '',            state: 'Karnataka'   },
  rsm3: { beat: '',             district: '',            state: 'Gujarat'     },
  rsm4: { beat: '',             district: '',            state: 'Rajasthan'   },
  zm1:  { beat: '',             district: '',            state: ''            },
  zm2:  { beat: '',             district: '',            state: ''            },
  zm3:  { beat: '',             district: '',            state: ''            },
  zm4:  { beat: '',             district: '',            state: ''            },
};

/**
 * XSR member ID → their outlet IDs.
 * Only XSRs have direct outlet assignments; managers roll up through
 * their reports[] tree.
 */
export const XSR_OUTLETS: Record<string, string[]> = {
  xsr1: ['o1', 'o2', 'o3', 'o4'],
  xsr2: ['o5', 'o6', 'o7'],
  xsr3: ['o8', 'o9', 'o10'],
  xsr4: ['o11', 'o12', 'o13'],
};

/**
 * Aggregate outlet achievements across multiple outlets for a given set of
 * target params.
 *
 * Each outlet contributes param.target to the denominator (every outlet in
 * the same geo is held to the same per-outlet target from the resolved
 * GeoTargetConfig). Achieved values are summed from OUTLET_ACHIEVEMENTS.
 *
 * Returns a map of paramId → { achieved, target, pct }.
 */
export function computeParamAchievements(
  outletIds: string[],
  params: TargetParam[],
): Record<string, { achieved: number; target: number; pct: number }> {
  const result: Record<string, { achieved: number; target: number; pct: number }> = {};
  for (const param of params) {
    let achieved    = 0;
    let totalTarget = 0;
    for (const id of outletIds) {
      const oa = OUTLET_ACHIEVEMENTS[id];
      achieved    += oa?.achievements[param.id] ?? 0;
      totalTarget += param.target;
    }
    result[param.id] = { achieved, target: totalTarget, pct: pct(achieved, totalTarget) };
  }
  return result;
}

export const PERIODS = [
  { value: '2026-05', label: "May '26" },
  { value: '2026-04', label: "Apr '26" },
  { value: '2026-03', label: "Mar '26" },
  { value: '2026-02', label: "Feb '26" },
  { value: '2026-01', label: "Jan '26" },
  { value: '2025-12', label: "Dec '25" },
  { value: '2026-Q2', label: "Q2 FY26" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// NEW TARGET CONFIG SYSTEM (v4) — Admin Targets Redesign
// OutletType → GeoLevel → Months → KPIs → Excel Upload
// Hierarchy: CITY > ASM > STATE > INDIA  (full override, no merge)
// ═══════════════════════════════════════════════════════════════════════════════

export type NewOutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT';
export type NewGeoLevel   = 'INDIA' | 'STATE' | 'ASM' | 'CITY';
export type KpiType       =
  | 'monthly_volume' | 'quarterly_volume'
  | 'focus_sku' | 'focus_category'
  | 'lines' | 'visit_freq' | 'custom';

export const OUTLET_TYPE_LABELS: Record<NewOutletType, string> = {
  SSS:          'SSS',
  WHOLESALER:   'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
  SSS_TOT:      'SSS TOT',
};

export const OUTLET_TYPE_DESC: Record<NewOutletType, string> = {
  SSS:          'Small Self-Service stores',
  WHOLESALER:   'Wholesale distribution points',
  SUB_STOCKIST: 'Secondary stocking points',
  SSS_TOT:      'Organised SSS TOT chains',
};

export const NEW_GEO_LEVEL_LABELS: Record<NewGeoLevel, string> = {
  INDIA: 'Pan India',
  STATE: 'State',
  ASM:   'ASM Zone',
  CITY:  'City',
};

export const KPI_TYPE_LABELS: Record<KpiType, string> = {
  monthly_volume:   'Monthly Volume',
  quarterly_volume: 'Quarterly Volume',
  focus_sku:        'Focus SKU',
  focus_category:   'Focus Category',
  lines:            'Number of Lines',
  visit_freq:       'Visit Frequency',
  custom:           'Custom',
};

export const KPI_TYPE_UNITS: Record<KpiType, string> = {
  monthly_volume:   'cases',
  quarterly_volume: 'cases',
  focus_sku:        'cases',
  focus_category:   'cases',
  lines:            'SKUs',
  visit_freq:       'visits',
  custom:           'units',
};

export const NEW_GEO_OPTIONS: Record<NewGeoLevel, string[]> = {
  INDIA: ['Pan India'],
  STATE: ['Maharashtra', 'Karnataka', 'Gujarat', 'Tamil Nadu', 'Delhi', 'Rajasthan', 'Kerala', 'Telangana'],
  ASM:   ['Mumbai Zone', 'Pune Zone', 'Bangalore Zone', 'Chennai Zone', 'Hyderabad Zone', 'Ahmedabad Zone', 'Delhi Zone'],
  CITY:  ['Mumbai', 'Pune', 'Nagpur', 'Bangalore', 'Chennai', 'Hyderabad', 'Ahmedabad', 'Surat', 'Jaipur', 'Delhi', 'Andheri', 'Thane', 'Navi Mumbai'],
};

export interface KpiParam {
  id: string;
  displayName: string;   // actual SKU / category name shown to partner
  type: KpiType;
  unit: string;
  isPrimary?: boolean;   // the headline KPI shown prominently on dashboards
}

export interface RejectionEntry {
  outletId: string;
  outletName?: string;
  reason: string;
}

export interface TargetConfig {
  id: string;
  outletType: NewOutletType;
  geoLevel: NewGeoLevel;
  geoName: string;           // "Pan India" when geoLevel === 'INDIA'
  months: string[];          // ["2026-07", "2026-08"]
  kpis: KpiParam[];
  status: 'DRAFT' | 'ACTIVE';
  targetValues: Record<string, Record<string, Record<string, number>>>; // month → outletId → kpiId → value
  /** Per-outlet KPI display-name overrides from Excel upload: month → outletId → kpiId → display name */
  kpiNameOverrides?: Record<string, Record<string, Record<string, string>>>;
  rejectionReport?: RejectionEntry[];
  createdAt: string;
  updatedAt: string;
}

export type MockOutlet = {
  id: string; name: string; city: string; state: string; asm: string;
};

export const MOCK_OUTLETS: Record<NewOutletType, MockOutlet[]> = {
  SSS: [
    { id: 'RT-001', name: 'Sharma General Store',    city: 'Mumbai',    state: 'Maharashtra', asm: 'Mumbai Zone'    },
    { id: 'RT-002', name: 'Patel Kirana',             city: 'Mumbai',    state: 'Maharashtra', asm: 'Mumbai Zone'    },
    { id: 'RT-003', name: 'Raj Traders',              city: 'Pune',      state: 'Maharashtra', asm: 'Pune Zone'      },
    { id: 'RT-004', name: 'Kumar Provisions',         city: 'Bangalore', state: 'Karnataka',   asm: 'Bangalore Zone' },
    { id: 'RT-005', name: 'Sri Venkatesh Stores',     city: 'Chennai',   state: 'Tamil Nadu',  asm: 'Chennai Zone'   },
    { id: 'RT-006', name: 'Mehta General',            city: 'Ahmedabad', state: 'Gujarat',     asm: 'Ahmedabad Zone' },
    { id: 'RT-007', name: 'Singh Provisions',         city: 'Delhi',     state: 'Delhi',       asm: 'Delhi Zone'     },
  ],
  WHOLESALER: [
    { id: 'WS-001', name: 'Anand Wholesale Hub',      city: 'Mumbai',    state: 'Maharashtra', asm: 'Mumbai Zone'    },
    { id: 'WS-002', name: 'Bharat Distributors',      city: 'Pune',      state: 'Maharashtra', asm: 'Pune Zone'      },
    { id: 'WS-003', name: 'South India Wholesale',    city: 'Bangalore', state: 'Karnataka',   asm: 'Bangalore Zone' },
    { id: 'WS-004', name: 'Gujarat Traders',          city: 'Ahmedabad', state: 'Gujarat',     asm: 'Ahmedabad Zone' },
  ],
  SUB_STOCKIST: [
    { id: 'SS-001', name: 'Mumbai Sub-Depot',         city: 'Mumbai',    state: 'Maharashtra', asm: 'Mumbai Zone'    },
    { id: 'SS-002', name: 'Deccan Sub-Stock',         city: 'Pune',      state: 'Maharashtra', asm: 'Pune Zone'      },
    { id: 'SS-003', name: 'Karnataka Depot',          city: 'Bangalore', state: 'Karnataka',   asm: 'Bangalore Zone' },
  ],
  SSS_TOT: [
    { id: 'SSS-001', name: "D-Mart Andheri",           city: 'Mumbai',    state: 'Maharashtra', asm: 'Mumbai Zone'    },
    { id: 'SSS-002', name: 'Big Bazaar Pune',          city: 'Pune',      state: 'Maharashtra', asm: 'Pune Zone'      },
    { id: 'SSS-003', name: 'Reliance Fresh Bangalore', city: 'Bangalore', state: 'Karnataka',   asm: 'Bangalore Zone' },
    { id: 'SSS-004', name: "Spencer's Chennai",        city: 'Chennai',   state: 'Tamil Nadu',  asm: 'Chennai Zone'   },
  ],
};

/** Outlets covered by a config's geo scope */
export function getOutletsForConfig(
  config: Pick<TargetConfig, 'outletType' | 'geoLevel' | 'geoName'>,
): MockOutlet[] {
  const all = MOCK_OUTLETS[config.outletType];
  if (config.geoLevel === 'INDIA') return all;
  if (config.geoLevel === 'STATE') return all.filter(o => o.state === config.geoName);
  if (config.geoLevel === 'ASM')   return all.filter(o => o.asm   === config.geoName);
  if (config.geoLevel === 'CITY')  return all.filter(o => o.city  === config.geoName);
  return all;
}

/** Check for schedule conflicts before saving a config */
export function detectConflict(
  draft: Pick<TargetConfig, 'outletType' | 'geoLevel' | 'geoName' | 'months'>,
  existing: TargetConfig[],
  excludeId?: string,
): { conflicting: TargetConfig; overlappingMonths: string[] } | null {
  for (const cfg of existing) {
    if (cfg.id === excludeId) continue;
    if (cfg.outletType !== draft.outletType) continue;
    if (cfg.geoLevel   !== draft.geoLevel)   continue;
    if (cfg.geoName    !== draft.geoName)    continue;
    const overlap = draft.months.filter(m => cfg.months.includes(m));
    if (overlap.length > 0) return { conflicting: cfg, overlappingMonths: overlap };
  }
  return null;
}

/** Current year-month string, e.g. "2026-06" */
export const CURRENT_MONTH: string = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();

export function isMonthLocked(month: string): boolean {
  // Only past months are locked. The current month remains editable so
  // admins can adjust in-flight targets (e.g. mid-month scheme changes).
  return month < CURRENT_MONTH;
}

export function formatMonth(ym: string): string {
  const [year, m] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(m, 10) - 1]} '${year.slice(2)}`;
}

/** Returns 14 months: past 2 (locked) + current (locked) + next 11 (selectable) */
export function getMonthOptions(): Array<{ value: string; label: string; locked: boolean }> {
  const base = new Date();
  base.setDate(1);
  const result: Array<{ value: string; label: string; locked: boolean }> = [];
  for (let i = -2; i <= 11; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    result.push({ value, label: formatMonth(value), locked: isMonthLocked(value) });
  }
  return result;
}

/**
 * Returns `n` months starting from the current month (no past months).
 * Useful when generating templates far ahead (e.g. 24-month planning window).
 */
export function buildMonthRange(n: number): Array<{ value: string; label: string }> {
  const base = new Date();
  base.setDate(1);
  const result: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    result.push({ value, label: formatMonth(value) });
  }
  return result;
}

/* ─── localStorage CRUD ──────────────────────────────────────────────────────── */

const TARGET_CFG_KEY = 'loyaltybase_target_configs_v5'; // v5 — per-month target values

export function getAllTargetConfigs(): TargetConfig[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(TARGET_CFG_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as TargetConfig[]; } catch { return []; }
}

export function saveAllTargetConfigs(configs: TargetConfig[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TARGET_CFG_KEY, JSON.stringify(configs));
}

export function upsertTargetConfig(cfg: TargetConfig): void {
  const all = getAllTargetConfigs();
  const idx = all.findIndex(c => c.id === cfg.id);
  if (idx >= 0) all[idx] = cfg; else all.unshift(cfg);
  saveAllTargetConfigs(all);
}

export function deleteTargetConfig(id: string): void {
  saveAllTargetConfigs(getAllTargetConfigs().filter(c => c.id !== id));
}

/**
 * Resolve the most specific ACTIVE config for an outlet + month.
 * Hierarchy: CITY > ASM > STATE > INDIA (full override).
 */
export function resolveNewConfig(
  outlet: MockOutlet,
  outletType: NewOutletType,
  month: string,
  configs?: TargetConfig[],
): TargetConfig | null {
  const all = (configs ?? getAllTargetConfigs())
    .filter(c => c.outletType === outletType && c.months.includes(month) && c.status === 'ACTIVE');
  return (
    all.find(c => c.geoLevel === 'CITY'  && c.geoName === outlet.city)  ??
    all.find(c => c.geoLevel === 'ASM'   && c.geoName === outlet.asm)   ??
    all.find(c => c.geoLevel === 'STATE' && c.geoName === outlet.state) ??
    all.find(c => c.geoLevel === 'INDIA')                               ??
    null
  );
}

// ─── Resolved targets: flat row per outlet with source explanation ────────────

export type ResolvedTargetRow = {
  outletId:     string;
  outletName:   string;
  outletType:   NewOutletType;
  city:         string;
  state:        string;
  asmZone:      string;
  month:        string;
  /** KPI displayName → numeric target value ('' when no config covers this outlet) */
  kpiValues:    Record<string, number | ''>;
  /** Human-readable label: "Pan India" | "State: X" | "ASM Zone: X" | "City: X" | "No target set" */
  targetSource: string;
};

/**
 * Build a flat resolved-targets array for the given month.
 *
 * For every outlet (across all four types) the function resolves the
 * highest-priority ACTIVE config using the City > ASM > State > India
 * hierarchy, then reads the pre-uploaded target values and records
 * which config level produced them.
 *
 * Pure function — takes explicit configs instead of reading localStorage,
 * so it can be tested without a browser environment.
 */
export function getResolvedTargetsData(
  month:   string,
  configs: TargetConfig[],
): ResolvedTargetRow[] {
  const rows: ResolvedTargetRow[] = [];

  for (const outletType of (['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'] as NewOutletType[])) {
    for (const outlet of MOCK_OUTLETS[outletType]) {
      const cfg = resolveNewConfig(outlet, outletType, month, configs);

      let targetSource: string;
      let kpiValues: Record<string, number | ''> = {};

      if (!cfg) {
        targetSource = 'No target set';
      } else {
        // Build targetSource label
        targetSource =
          cfg.geoLevel === 'INDIA' ? 'Pan India' :
          cfg.geoLevel === 'STATE' ? `State: ${cfg.geoName}` :
          cfg.geoLevel === 'ASM'   ? `ASM Zone: ${cfg.geoName}` :
          /* CITY */                 `City: ${cfg.geoName}`;

        // Map KPI id → displayName → value
        const outletTargets = cfg.targetValues[month]?.[outlet.id] ?? {};
        for (const kpi of cfg.kpis) {
          kpiValues[kpi.displayName] = outletTargets[kpi.id] ?? '';
        }
      }

      rows.push({
        outletId:     outlet.id,
        outletName:   outlet.name,
        outletType,
        city:         outlet.city,
        state:        outlet.state,
        asmZone:      outlet.asm,
        month,
        kpiValues,
        targetSource,
      });
    }
  }

  return rows;
}
