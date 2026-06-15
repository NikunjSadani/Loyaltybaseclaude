/// <reference types="vitest/globals" />
/**
 * TDD — Admin pages final wiring
 *
 * Groups:
 *   A — admin/banners         : no localStorage popup fallback
 *   B — admin/gifts           : no loadGifts/saveGifts; API-backed gift-config route
 *   C — admin/hierarchy       : no getEmployees/saveEmployees; API-backed hierarchy-config route
 *   D — admin/targets         : no localStorage target-config CRUD; API-backed target-config route
 *   E — admin/targets/upload  : no getTenantKpiDefs/saveTenantKpiDefs; API-backed kpi-config route
 *   F — admin/sales           : no getTenantKpiDefs; API-backed kpi-config fetch
 *   G — admin/users/outlets   : no MOCK_OUTLETS const / MOCK_EMPLOYEES import; API-backed outlet & hierarchy fetches; confirm handlers wired to APIs
 *   H — admin/catalog         : API-backed categories & SKUs; CRUD routes exist
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

// ─── A — admin/banners ────────────────────────────────────────────────────────

describe('A — admin/banners page', () => {
  it('A1: does NOT call loadPopups as a data fallback', () => {
    const code = src('app/admin/banners/page.tsx');
    expect(code).not.toMatch(/loadPopups\s*\(\s*\)/);
  });

  it('A2: does NOT call savePopups', () => {
    const code = src('app/admin/banners/page.tsx');
    expect(code).not.toMatch(/savePopups\s*\(/);
  });

  it('A3: still imports fetchBanners and updateBanners', () => {
    const code = src('app/admin/banners/page.tsx');
    expect(code).toMatch(/fetchBanners/);
    expect(code).toMatch(/updateBanners/);
  });

  it('A4: does NOT import loadPopups or savePopups', () => {
    const code = src('app/admin/banners/page.tsx');
    expect(code).not.toMatch(/\bloadPopups\b/);
    expect(code).not.toMatch(/\bsavePopups\b/);
  });
});

// ─── B — admin/gifts ──────────────────────────────────────────────────────────

describe('B — admin/gifts page', () => {
  it('B1: does NOT use loadGifts() as state initialiser', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).not.toMatch(/useState[^)]*loadGifts/);
  });

  it('B2: does NOT call saveGifts() directly', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).not.toMatch(/saveGifts\s*\(/);
  });

  it('B3: fetches from /api/admin/gift-config', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).toMatch(/\/api\/admin\/gift-config/);
  });

  it('B4: does NOT import loadGifts or saveGifts', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).not.toMatch(/\bloadGifts\b/);
    expect(code).not.toMatch(/\bsaveGifts\b/);
  });

  it('B5: gift-config GET route file exists', () => {
    expect(() => src('app/api/admin/gift-config/route.ts')).not.toThrow();
  });

  it('B6: gift-config route handles GET and PUT', () => {
    const code = src('app/api/admin/gift-config/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('B7: gift-config route uses programSetting', () => {
    const code = src('app/api/admin/gift-config/route.ts');
    expect(code).toMatch(/programSetting/);
  });
});

// ─── C — admin/hierarchy ──────────────────────────────────────────────────────

describe('C — admin/hierarchy page', () => {
  it('C1: does NOT use getEmployees() as state initialiser', () => {
    const code = src('app/admin/hierarchy/page.tsx');
    expect(code).not.toMatch(/useState[^)]*getEmployees/);
  });

  it('C2: does NOT call saveEmployees() directly', () => {
    const code = src('app/admin/hierarchy/page.tsx');
    expect(code).not.toMatch(/saveEmployees\s*\(/);
  });

  it('C3: fetches from /api/admin/hierarchy-config', () => {
    const code = src('app/admin/hierarchy/page.tsx');
    expect(code).toMatch(/\/api\/admin\/hierarchy-config/);
  });

  it('C4: does NOT import getEmployees or saveEmployees', () => {
    const code = src('app/admin/hierarchy/page.tsx');
    expect(code).not.toMatch(/\bgetEmployees\b/);
    expect(code).not.toMatch(/\bsaveEmployees\b/);
  });

  it('C5: hierarchy-config GET route file exists', () => {
    expect(() => src('app/api/admin/hierarchy-config/route.ts')).not.toThrow();
  });

  it('C6: hierarchy-config route handles GET and PUT', () => {
    const code = src('app/api/admin/hierarchy-config/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('C7: hierarchy-config route uses programSetting', () => {
    const code = src('app/api/admin/hierarchy-config/route.ts');
    expect(code).toMatch(/programSetting/);
  });
});

// ─── D — admin/targets ────────────────────────────────────────────────────────

describe('D — admin/targets page', () => {
  it('D1: does NOT call getAllTargetConfigs() directly', () => {
    const code = src('app/admin/targets/page.tsx');
    expect(code).not.toMatch(/getAllTargetConfigs\s*\(\s*\)/);
  });

  it('D2: does NOT call upsertTargetConfig() directly', () => {
    const code = src('app/admin/targets/page.tsx');
    expect(code).not.toMatch(/upsertTargetConfig\s*\(/);
  });

  it('D3: does NOT call deleteTargetConfig() directly', () => {
    const code = src('app/admin/targets/page.tsx');
    expect(code).not.toMatch(/deleteTargetConfig\s*\(/);
  });

  it('D4: fetches from /api/admin/target-config', () => {
    const code = src('app/admin/targets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/target-config/);
  });

  it('D5: sends DELETE to /api/admin/target-config/id', () => {
    const code = src('app/admin/targets/page.tsx');
    expect(code).toMatch(/DELETE/);
    expect(code).toMatch(/\/api\/admin\/target-config\//);
  });

  it('D6: target-config route file exists', () => {
    expect(() => src('app/api/admin/target-config/route.ts')).not.toThrow();
  });

  it('D7: target-config route handles GET and PUT', () => {
    const code = src('app/api/admin/target-config/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('D8: target-config route uses programSetting', () => {
    const code = src('app/api/admin/target-config/route.ts');
    expect(code).toMatch(/programSetting/);
  });

  it('D9: target-config [id] DELETE route file exists', () => {
    expect(() => src('app/api/admin/target-config/[id]/route.ts')).not.toThrow();
  });
});

// ─── E — admin/targets/upload ─────────────────────────────────────────────────

describe('E — admin/targets/upload page', () => {
  it('E1: does NOT use getTenantKpiDefs() as state initialiser', () => {
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).not.toMatch(/useState[^)]*getTenantKpiDefs/);
  });

  it('E2: does NOT call saveTenantKpiDefs()', () => {
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).not.toMatch(/saveTenantKpiDefs\s*\(/);
  });

  it('E3: does NOT call getAllTargetConfigs() directly', () => {
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).not.toMatch(/getAllTargetConfigs\s*\(\s*\)/);
  });

  it('E4: does NOT call upsertTargetConfig() directly', () => {
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).not.toMatch(/upsertTargetConfig\s*\(/);
  });

  it('E5: fetches from /api/admin/kpi-config', () => {
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).toMatch(/\/api\/admin\/kpi-config/);
  });

  it('E6: kpi-config route file exists', () => {
    expect(() => src('app/api/admin/kpi-config/route.ts')).not.toThrow();
  });

  it('E7: kpi-config route handles GET and PUT', () => {
    const code = src('app/api/admin/kpi-config/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('E8: kpi-config route uses programSetting', () => {
    const code = src('app/api/admin/kpi-config/route.ts');
    expect(code).toMatch(/programSetting/);
  });
});

// ─── F — admin/sales ─────────────────────────────────────────────────────────

describe('F — admin/sales page', () => {
  it('F1: does NOT import getTenantKpiDefs', () => {
    const code = src('app/admin/sales/page.tsx');
    expect(code).not.toMatch(/getTenantKpiDefs/);
  });

  it('F2: does NOT use lazy useState initializer for KPI defs', () => {
    const code = src('app/admin/sales/page.tsx');
    expect(code).not.toMatch(/useState\s*\(\s*\(\s*\)\s*=>/);
  });

  it('F3: fetches KPI defs from /api/admin/kpi-config', () => {
    const code = src('app/admin/sales/page.tsx');
    expect(code).toMatch(/\/api\/admin\/kpi-config/);
  });
});

// ─── G — admin/users/outlets ─────────────────────────────────────────────────

describe('G — admin/users/outlets page', () => {
  it('G1: does NOT declare a hardcoded MOCK_OUTLETS array', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).not.toMatch(/const MOCK_OUTLETS\s*:/);
  });

  it('G2: does NOT initialise outlets state from MOCK_OUTLETS', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).not.toMatch(/useState.*MOCK_OUTLETS/);
  });

  it('G3: fetches outlet list from /api/admin/outlets', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/outlets(?!\/)/);
  });

  it('G4: /api/admin/outlets GET route file exists', () => {
    expect(() => src('app/api/admin/outlets/route.ts')).not.toThrow();
  });

  it('G5: does NOT import MOCK_EMPLOYEES from employee-hierarchy', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).not.toMatch(/import.*MOCK_EMPLOYEES/);
  });

  it('G6: fetches employees from /api/admin/hierarchy-config', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/hierarchy-config/);
  });

  it('G7: deactivate confirm calls POST /api/admin/outlets/deactivate', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/outlets\/deactivate/);
  });

  it('G8: outlet upsert confirm calls POST /api/admin/outlets/upsert', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/outlets\/upsert/);
  });

  it('G9: re-KYC confirm calls POST /api/admin/outlets/rekyc-flag', () => {
    const code = src('app/admin/users/outlets/page.tsx');
    expect(code).toMatch(/\/api\/admin\/outlets\/rekyc-flag/);
  });
});

// ─── H — admin/catalog ───────────────────────────────────────────────────────

describe('H — admin/catalog page', () => {
  it('H1: fetches categories from /api/admin/categories', () => {
    const code = src('app/admin/catalog/page.tsx');
    expect(code).toMatch(/\/api\/admin\/categories/);
  });

  it('H2: fetches SKUs from /api/admin/skus', () => {
    const code = src('app/admin/catalog/page.tsx');
    expect(code).toMatch(/\/api\/admin\/skus/);
  });

  it('H3: uses the Bearer token auth pattern from localStorage', () => {
    const code = src('app/admin/catalog/page.tsx');
    expect(code).toMatch(/localStorage\.getItem\('token'\)/);
    expect(code).toMatch(/Bearer/);
  });

  it('H4: categories collection route handles GET and POST', () => {
    const code = src('app/api/admin/categories/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
    expect(code).toMatch(/export\s+async\s+function\s+POST/);
  });

  it('H5: categories [id] route handles PATCH and DELETE', () => {
    const code = src('app/api/admin/categories/[id]/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+PATCH/);
    expect(code).toMatch(/export\s+async\s+function\s+DELETE/);
  });

  it('H6: skus [id] route handles PATCH and DELETE', () => {
    const code = src('app/api/admin/skus/[id]/route.ts');
    expect(code).toMatch(/export\s+async\s+function\s+PATCH/);
    expect(code).toMatch(/export\s+async\s+function\s+DELETE/);
  });

  it('H7: catalog nav link is registered in the admin layout', () => {
    const code = src('app/admin/layout.tsx');
    expect(code).toMatch(/\/admin\/catalog/);
  });

  it('H8: categories routes gate on catalog permissions', () => {
    const code = src('app/api/admin/categories/route.ts');
    expect(code).toMatch(/catalog:read/);
    expect(code).toMatch(/catalog:write/);
  });
});
