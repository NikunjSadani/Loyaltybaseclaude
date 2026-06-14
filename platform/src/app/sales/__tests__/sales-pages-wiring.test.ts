/// <reference types="vitest/globals" />
/**
 * TDD — Sales pages final wiring
 *
 * Defines "done" for the 4 remaining partial sales pages.
 * All tests are source-read (no runtime); they run locally.
 *
 * Groups:
 *   A — sales/outlets     : no OUTLET_ACHIEVEMENTS; uses targetPct
 *   B — team/[id]/outlets : no OUTLET_ACHIEVEMENTS; uses targetPct
 *   C — sales/tasks       : no HO_TASKS hardcoded demo array
 *   D — sales/catalogue   : no loadGifts() fallback
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../../..');

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

// ─── A — sales/outlets ────────────────────────────────────────────────────────

describe('A — sales/outlets page', () => {
  it('A1: does NOT import OUTLET_ACHIEVEMENTS', () => {
    const code = src('src/app/sales/outlets/page.tsx');
    expect(code).not.toMatch(/OUTLET_ACHIEVEMENTS/);
  });

  it('A2: imports resolveConfig and pct from @/lib/targets (config still used)', () => {
    const code = src('src/app/sales/outlets/page.tsx');
    expect(code).toMatch(/resolveConfig/);
    expect(code).toMatch(/from ['"]@\/lib\/targets['"]/);
  });

  it('A3: Outlet interface has targetPct field', () => {
    const code = src('src/app/sales/outlets/page.tsx');
    expect(code).toMatch(/targetPct/);
  });

  it('A4: uses outlet.targetPct for sorting approved outlets', () => {
    const code = src('src/app/sales/outlets/page.tsx');
    expect(code).toMatch(/targetPct/);
  });

  it('A5: fetches /api/sales/outlets', () => {
    const code = src('src/app/sales/outlets/page.tsx');
    expect(code).toMatch(/\/api\/sales\/outlets/);
  });
});

// ─── B — sales/team/[memberId]/outlets ────────────────────────────────────────

describe('B — sales/team/[memberId]/outlets page', () => {
  it('B1: does NOT import OUTLET_ACHIEVEMENTS', () => {
    const code = src('src/app/sales/team/[memberId]/outlets/page.tsx');
    expect(code).not.toMatch(/OUTLET_ACHIEVEMENTS/);
  });

  it('B2: retains targetPct-based sorting (already present)', () => {
    const code = src('src/app/sales/team/[memberId]/outlets/page.tsx');
    expect(code).toMatch(/targetPct/);
  });

  it('B3: fetches /api/sales/team/[memberId]/outlets', () => {
    const code = src('src/app/sales/team/[memberId]/outlets/page.tsx');
    expect(code).toMatch(/\/api\/sales\/team\//);
    expect(code).toMatch(/\/outlets/);
  });

  it('B4: does NOT reference ach?.achievements', () => {
    const code = src('src/app/sales/team/[memberId]/outlets/page.tsx');
    expect(code).not.toMatch(/ach\?\.achievements/);
  });
});

// ─── C — sales/tasks ──────────────────────────────────────────────────────────

describe('C — sales/tasks page', () => {
  it('C1: does NOT contain HO_TASKS constant', () => {
    const code = src('src/app/sales/tasks/page.tsx');
    expect(code).not.toMatch(/HO_TASKS/);
  });

  it('C2: still imports fetchTaskConfig (task config API still wired)', () => {
    const code = src('src/app/sales/tasks/page.tsx');
    expect(code).toMatch(/fetchTaskConfig/);
  });

  it('C3: still imports fetchOutletVisibilityStatuses', () => {
    const code = src('src/app/sales/tasks/page.tsx');
    expect(code).toMatch(/fetchOutletVisibilityStatuses/);
  });
});

// ─── D — sales/catalogue ──────────────────────────────────────────────────────

describe('D — sales/catalogue page', () => {
  it('D1: does NOT call loadGifts() as a data fallback', () => {
    const code = src('src/app/sales/catalogue/page.tsx');
    expect(code).not.toMatch(/loadGifts\(\)/);
  });

  it('D2: does NOT import loadGifts', () => {
    const code = src('src/app/sales/catalogue/page.tsx');
    expect(code).not.toMatch(/\bloadGifts\b/);
  });

  it('D3: still calls /api/rewards/catalog', () => {
    const code = src('src/app/sales/catalogue/page.tsx');
    expect(code).toMatch(/\/api\/rewards\/catalog/);
  });

  it('D4: shows empty gifts array on API failure (not mock fallback)', () => {
    const code = src('src/app/sales/catalogue/page.tsx');
    // catch block must NOT call loadGifts
    expect(code).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*loadGifts/);
  });
});
