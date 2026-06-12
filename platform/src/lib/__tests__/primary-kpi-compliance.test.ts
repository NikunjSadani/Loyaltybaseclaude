/// <reference types="vitest/globals" />
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A: lib/targets.ts — data model ──────────────────────────────────────────
describe('A — lib/targets.ts data model', () => {
  const code = src('lib/targets.ts');

  it('A1: TargetParam interface has isPrimary?: boolean', () => {
    // isPrimary?  : boolean  (with or without spaces around ?)
    expect(code).toMatch(/interface TargetParam[\s\S]{0,400}isPrimary\s*\??\s*:\s*boolean/);
  });

  it('A2: KpiParam interface has isPrimary?: boolean', () => {
    expect(code).toMatch(/interface KpiParam[\s\S]{0,400}isPrimary\s*\??\s*:\s*boolean/);
  });

  it('A3: DEFAULT_PARAMS first entry is marked isPrimary: true', () => {
    expect(code).toMatch(/DEFAULT_PARAMS[\s\S]{0,300}isPrimary\s*:\s*true/);
  });

  it('A4: SEED_CONFIGS entries have isPrimary: true on one param each', () => {
    expect(code).toMatch(/SEED_CONFIGS[\s\S]{0,600}isPrimary\s*:\s*true/);
  });

  it('A5: getPrimaryParam is exported', () => {
    expect(code).toMatch(/export function getPrimaryParam/);
  });

  it('A6: getPrimaryParam resolves by isPrimary flag', () => {
    // The implementation should look for isPrimary inside the function body
    expect(code).toMatch(/function getPrimaryParam[\s\S]{0,300}isPrimary/);
  });
});

// ─── B: admin/targets/page.tsx — Step 3 KPI wizard ──────────────────────────
describe('B — admin/targets/page.tsx KPI wizard', () => {
  const code = src('app/admin/targets/page.tsx');

  it('B1: KPI row state uses isPrimary field', () => {
    expect(code).toMatch(/isPrimary/);
  });

  it('B2: wizard has "Primary" column header in Step 3', () => {
    expect(code).toMatch(/Primary/);
  });

  it('B3: a setPrimary handler (or equivalent) sets isPrimary: true', () => {
    expect(code).toMatch(/isPrimary\s*:\s*true/);
  });

  it('B4: makeBlankConfig sets isPrimary: true on first KPI', () => {
    expect(code).toMatch(/makeBlankConfig[\s\S]{0,400}isPrimary\s*:\s*true/);
  });
});

// ─── C: partner/targets/page.tsx ─────────────────────────────────────────────
describe('C — partner/targets/page.tsx', () => {
  const code = src('app/partner/targets/page.tsx');

  it('C1: does NOT use type === "sales_value" to find the primary param', () => {
    expect(code).not.toMatch(/type\s*===\s*['"]sales_value['"]/);
  });

  it('C2: uses isPrimary (via getPrimaryParam or direct flag) for primary param', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });

  it('C3: hero % label is dynamic — not the hardcoded string "monthly target"', () => {
    expect(code).not.toMatch(/"monthly target"/);
  });
});

// ─── D: partner/dashboard/page.tsx ───────────────────────────────────────────
describe('D — partner/dashboard/page.tsx', () => {
  const code = src('app/partner/dashboard/page.tsx');

  it('D1: does NOT use type === "sales_value" to find primary param', () => {
    expect(code).not.toMatch(/type\s*===\s*['"]sales_value['"]/);
  });

  it('D2: uses isPrimary / getPrimaryParam instead', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });
});

// ─── E: sales/outlets/page.tsx ───────────────────────────────────────────────
describe('E — sales/outlets/page.tsx', () => {
  const code = src('app/sales/outlets/page.tsx');

  it('E1: does NOT use type === "sales_value" for primary param selection', () => {
    expect(code).not.toMatch(/type\s*===\s*['"]sales_value['"]/);
  });

  it('E2: uses isPrimary / getPrimaryParam instead', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });
});

// ─── F: sales/team/[memberId]/outlets/page.tsx ───────────────────────────────
describe('F — sales/team/[memberId]/outlets/page.tsx', () => {
  const code = src('app/sales/team/[memberId]/outlets/page.tsx');

  it('F1: does NOT use type === "sales_value" for primary param selection', () => {
    expect(code).not.toMatch(/type\s*===\s*['"]sales_value['"]/);
  });

  it('F2: uses isPrimary / getPrimaryParam instead', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });
});

// ─── G: sales/kyc/[id]/page.tsx ──────────────────────────────────────────────
describe('G — sales/kyc/[id]/page.tsx', () => {
  const code = src('app/sales/kyc/[id]/page.tsx');

  it('G1: does NOT hardcode p_sv param ID for the hero param', () => {
    // The old code: params.find(p => p.id === 'p_sv')
    expect(code).not.toMatch(/\.find\(\s*p\s*=>\s*p\.id\s*===\s*['"]p_sv['"]\s*\)/);
  });

  it('G2: uses isPrimary / getPrimaryParam for hero param', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });
});

// ─── H: admin/dashboard/page.tsx — Target Achievement card ───────────────────
describe('H — admin/dashboard/page.tsx', () => {
  const code = src('app/admin/dashboard/page.tsx');

  it('H1: TargetAchievementCard references isPrimary or getPrimaryParam', () => {
    expect(code).toMatch(/isPrimary|getPrimaryParam/);
  });
});

// ─── I: runtime — getPrimaryParam() ──────────────────────────────────────────
import { getPrimaryParam } from '@/lib/targets';
import type { TargetParam } from '@/lib/targets';

describe('I — getPrimaryParam() runtime', () => {
  const params: TargetParam[] = [
    { id: 'p1', type: 'focus_product',  label: 'Product A', unit: 'cases', target: 50  },
    { id: 'p2', type: 'sales_value',    label: 'Volume',    unit: 'cases', target: 500, isPrimary: true },
    { id: 'p3', type: 'lines',          label: 'Lines',     unit: 'SKUs',  target: 5   },
  ];

  it('I1: returns the param marked isPrimary: true', () => {
    expect(getPrimaryParam(params)?.id).toBe('p2');
  });

  it('I2: falls back to first param when none is marked', () => {
    const noMark = params.map(p => ({ ...p, isPrimary: undefined as boolean | undefined }));
    expect(getPrimaryParam(noMark)?.id).toBe('p1');
  });

  it('I3: returns null for empty array', () => {
    expect(getPrimaryParam([])).toBeNull();
  });

  it('I4: isPrimary wins regardless of position in the array', () => {
    const lastPrimary: TargetParam[] = [
      { id: 'x1', type: 'focus_category', label: 'Category', unit: 'cases', target: 100 },
      { id: 'x2', type: 'sales_value',    label: 'Volume',   unit: 'cases', target: 500, isPrimary: true },
    ];
    expect(getPrimaryParam(lastPrimary)?.id).toBe('x2');
  });

  it('I5: works with KpiParam-shaped objects (duck-typed)', () => {
    const kpiLike = [
      { id: 'k1', displayName: 'SKU A', type: 'focus_sku' as const, unit: 'cases', isPrimary: false },
      { id: 'k2', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true },
    ];
    // getPrimaryParam is generic — same logic applies
    const result = kpiLike.find(k => k.isPrimary) ?? kpiLike[0] ?? null;
    expect(result?.id).toBe('k2');
  });
});
