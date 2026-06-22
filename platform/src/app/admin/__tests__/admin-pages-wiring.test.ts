/// <reference types="vitest/globals" />
/**
 * TDD — Admin pages final wiring
 *
 * Groups:
 *   A — admin/banners         : no localStorage popup fallback
 *   B — admin/gifts           : no loadGifts/saveGifts/gift-config; real RewardCatalog CRUD + fulfilment
 *   C — admin/hierarchy       : no getEmployees/saveEmployees; API-backed hierarchy-config route
 *   D — admin/targets         : no localStorage target-config CRUD; API-backed target-config route
 *   E — admin/targets/upload  : no getTenantKpiDefs/saveTenantKpiDefs; API-backed kpi-config route
 *   F — admin/sales           : no getTenantKpiDefs; API-backed kpi-config fetch
 *   G — admin/users/outlets   : no MOCK_OUTLETS const / MOCK_EMPLOYEES import; API-backed outlet & hierarchy fetches; confirm handlers wired to APIs
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

  it('B3: fetches the real reward catalogue from /api/admin/rewards/catalog', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).toMatch(/\/api\/admin\/rewards\/catalog/);
  });

  it('B4: does NOT import loadGifts, saveGifts, GIFT_CATALOGUE, or @/lib/gifts', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).not.toMatch(/\bloadGifts\b/);
    expect(code).not.toMatch(/\bsaveGifts\b/);
    expect(code).not.toMatch(/\bGIFT_CATALOGUE\b/);
    expect(code).not.toMatch(/@\/lib\/gifts/);
  });

  it('B5: no longer talks to the gift-config blob route', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).not.toMatch(/\/api\/admin\/gift-config/);
  });

  it('B6: manages reward categories via /api/admin/rewards/categories', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).toMatch(/\/api\/admin\/rewards\/categories/);
  });

  it('B7: wires the redemption-order fulfilment surface (orders + transition + bulk sheet)', () => {
    const code = src('app/admin/gifts/page.tsx');
    expect(code).toMatch(/\/api\/rewards\/orders/);
    expect(code).toMatch(/\/transition/);
    expect(code).toMatch(/\/api\/admin\/rewards\/fulfilment\/template/);
    expect(code).toMatch(/\/api\/admin\/rewards\/fulfilment\/upload/);
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

  // C5–C7 (platform app/api/admin/hierarchy-config route) retired with D2 (#31).
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

  it('D4: sets the primary KPI via POST /api/admin/kpis/:id/set-primary (single-select)', () => {
    // The old /api/admin/target-config route is retired (#31); primary KPI is now
    // a single-select that MOVES via the atomic set-primary endpoint.
    const code = src('app/admin/targets/page.tsx');
    expect(code).not.toMatch(/\/api\/admin\/target-config/);
    expect(code).toMatch(/\/api\/admin\/kpis\/\$\{[^}]+\}\/set-primary/);
  });

  it('D5: deletes a KPI def via /api/admin/kpis/:id', () => {
    // P4 rewired admin/targets from the old target-config wizard to KPI mgmt.
    const code = src('app/admin/targets/page.tsx');
    expect(code).toMatch(/\.del[<(]/);
    expect(code).toMatch(/\/api\/admin\/kpis\//);
  });

  // D6–D9 (platform app/api/admin/target-config route) retired with D2 (#31).
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

  it('E5: no longer references the retired /api/admin/kpi-config route', () => {
    // The /api/admin/kpi-config route is retired (#31); the upload page parses
    // server-side and no longer references the old blob route.
    const code = src('app/admin/targets/upload/page.tsx');
    expect(code).not.toMatch(/\/api\/admin\/kpi-config/);
  });

  // E6–E8 (platform app/api/admin/kpi-config route) retired with D2 (#31).
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

  it('F3: fetches KPI defs from /api/admin/kpis', () => {
    // P4 rewired admin/sales KPI defs to the relational KpiDef endpoint.
    const code = src('app/admin/sales/page.tsx');
    expect(code).toMatch(/\/api\/admin\/kpis/);
  });
});

// ─── H — admin/settings visibility-capture-mode toggle ───────────────────────

describe('H — admin/settings page (visibility capture mode)', () => {
  it('H1: imports fetchVisibilityCaptureMode and saveVisibilityCaptureMode from the lib', () => {
    const code = src('app/admin/settings/page.tsx');
    expect(code).toMatch(/fetchVisibilityCaptureMode/);
    expect(code).toMatch(/saveVisibilityCaptureMode/);
    expect(code).toMatch(/@\/lib\/visibility-capture-mode/);
  });

  it('H2: imports useAdminSession for role gating', () => {
    const code = src('app/admin/settings/page.tsx');
    expect(code).toMatch(/useAdminSession/);
    expect(code).toMatch(/@\/lib\/admin-session/);
  });

  it('H3: guards the toggle with isGifsyAdmin (GIFSY_ADMIN-only)', () => {
    const code = src('app/admin/settings/page.tsx');
    // Must gate on GIFSY_ADMIN role check
    expect(code).toMatch(/isGifsyAdmin/);
    // And the role comparison is present
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('H4: calls PUT /api/admin/settings/visibility-capture-mode in the lib', () => {
    const code = src('lib/visibility-capture-mode.ts');
    expect(code).toMatch(/\/api\/admin\/settings\/visibility-capture-mode/);
    expect(code).toMatch(/method.*PUT|PUT.*method/s);
  });

  it('H5: reads mode from GET /api/admin/settings/config (features.visibilityCaptureMode)', () => {
    const code = src('lib/visibility-capture-mode.ts');
    expect(code).toMatch(/\/api\/admin\/settings\/config/);
    expect(code).toMatch(/visibilityCaptureMode/);
  });

  it('H6: PHOTO_APPROVAL and AMOUNT_UPLOAD are both present as segmented control options', () => {
    const code = src('app/admin/settings/page.tsx');
    expect(code).toMatch(/PHOTO_APPROVAL/);
    expect(code).toMatch(/AMOUNT_UPLOAD/);
    // Friendly labels
    expect(code).toMatch(/Photo Approval/);
    expect(code).toMatch(/Amount Upload/);
  });

  it('H7: optimistic update — reverts captureMode on save failure', () => {
    const code = src('app/admin/settings/page.tsx');
    // The revert logic sets mode back to the previous value on error
    expect(code).toMatch(/Revert optimistic/);
  });

  it('H8: lib falls back to PHOTO_APPROVAL when API response lacks the field', () => {
    const code = src('lib/visibility-capture-mode.ts');
    // Default fallback expressed in code
    expect(code).toMatch(/'PHOTO_APPROVAL'/);
    // catch block returns default
    expect(code).toMatch(/catch[\s\S]*PHOTO_APPROVAL/);
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

  // G4 (platform app/api/admin/outlets route) retired with D2 (#31).

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
