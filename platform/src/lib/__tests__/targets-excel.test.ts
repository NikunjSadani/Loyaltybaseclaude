/// <reference types="vitest/globals" />
/**
 * TDD — Targets: Re-upload + Resolved Targets Download
 *
 * RED phase: all tests written before implementation.
 *
 * Changes under test:
 *  1. lib/targets.ts                  — getResolvedTargetsData() + ResolvedTargetRow type
 *  2. app/admin/targets/page.tsx      — Re-upload button on ACTIVE configs
 *                                     — past-month rejection in UploadModal
 *                                     — merge behaviour on re-confirm
 *                                     — xlsxDownloadResolvedTargets() function
 *                                     — "Download Final Targets" button in toolbar
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect } from 'vitest';

/** Read file relative to platform/src */
const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A: lib/targets.ts exports ResolvedTargetRow + getResolvedTargetsData ────

describe('A — lib/targets.ts: new exports', () => {
  const code = src('lib/targets.ts');

  it('A1: ResolvedTargetRow type is defined', () => {
    expect(code).toMatch(/ResolvedTargetRow/);
  });

  it('A2: getResolvedTargetsData function is exported', () => {
    expect(code).toMatch(/export\s+function\s+getResolvedTargetsData/);
  });

  it('A3: getResolvedTargetsData accepts (month, configs) parameters', () => {
    const sig = code.match(/export\s+function\s+getResolvedTargetsData\s*\([^)]+\)/)?.[0] ?? '';
    expect(sig).toMatch(/month/);
    expect(sig).toMatch(/configs/);
  });

  it('A4: ResolvedTargetRow has outletId field', () => {
    const block = code.match(/ResolvedTargetRow\s*=\s*\{[^}]+\}/s)?.[0] ?? code;
    expect(block).toMatch(/outletId/);
  });

  it('A5: ResolvedTargetRow has targetSource field', () => {
    const block = code.match(/ResolvedTargetRow\s*=\s*\{[^}]+\}/s)?.[0] ?? code;
    expect(block).toMatch(/targetSource/);
  });

  it('A6: ResolvedTargetRow has kpiValues field', () => {
    const block = code.match(/ResolvedTargetRow\s*=\s*\{[^}]+\}/s)?.[0] ?? code;
    expect(block).toMatch(/kpiValues/);
  });
});

// ─── B: getResolvedTargetsData runtime behaviour ──────────────────────────────

describe('B — getResolvedTargetsData: runtime correctness', () => {
  // Inline a minimal implementation test using the actual function
  it('B1: returns an array', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const rows = getResolvedTargetsData('2026-07', []);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('B2: with no configs every outlet has targetSource "No target set"', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const rows = getResolvedTargetsData('2026-07', []);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(r => expect(r.targetSource).toBe('No target set'));
  });

  it('B3: INDIA-level config produces targetSource "Pan India"', async () => {
    const { getResolvedTargetsData, CURRENT_MONTH } = await import('../targets');
    // Build a minimal ACTIVE INDIA config that covers a future month
    const futureMonth = '2099-01';
    const cfg = {
      id: 'test-india',
      outletType: 'SSS' as const,
      geoLevel: 'INDIA' as const,
      geoName: 'Pan India',
      months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const,
      targetValues: { [futureMonth]: { 'RT-001': { k1: 100 } } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows = getResolvedTargetsData(futureMonth, [cfg]);
    const rt001 = rows.find(r => r.outletId === 'RT-001');
    expect(rt001).toBeDefined();
    expect(rt001!.targetSource).toBe('Pan India');
  });

  it('B4: STATE-level config produces targetSource "State: {name}"', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-02';
    const cfg = {
      id: 'test-state',
      outletType: 'SSS' as const,
      geoLevel: 'STATE' as const,
      geoName: 'Maharashtra',
      months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const,
      targetValues: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows = getResolvedTargetsData(futureMonth, [cfg]);
    const mhRow = rows.find(r => r.outletType === 'SSS' && r.state === 'Maharashtra');
    expect(mhRow).toBeDefined();
    expect(mhRow!.targetSource).toBe('State: Maharashtra');
  });

  it('B5: ASM-level config produces targetSource "ASM Zone: {name}"', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-03';
    const cfg = {
      id: 'test-asm',
      outletType: 'SSS' as const,
      geoLevel: 'ASM' as const,
      geoName: 'Mumbai Zone',
      months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const,
      targetValues: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows = getResolvedTargetsData(futureMonth, [cfg]);
    const asmRow = rows.find(r => r.outletType === 'SSS' && r.asmZone === 'Mumbai Zone');
    expect(asmRow).toBeDefined();
    expect(asmRow!.targetSource).toBe('ASM Zone: Mumbai Zone');
  });

  it('B6: CITY-level config produces targetSource "City: {name}"', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-04';
    const cfg = {
      id: 'test-city',
      outletType: 'SSS' as const,
      geoLevel: 'CITY' as const,
      geoName: 'Mumbai',
      months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const,
      targetValues: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rows = getResolvedTargetsData(futureMonth, [cfg]);
    const cityRow = rows.find(r => r.outletType === 'SSS' && r.city === 'Mumbai');
    expect(cityRow).toBeDefined();
    expect(cityRow!.targetSource).toBe('City: Mumbai');
  });

  it('B7: city-level overrides state-level for same outlet (hierarchy)', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-05';
    const stateCfg = {
      id: 'state-cfg', outletType: 'SSS' as const, geoLevel: 'STATE' as const,
      geoName: 'Maharashtra', months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const, targetValues: {},
      createdAt: '', updatedAt: '',
    };
    const cityCfg = {
      id: 'city-cfg', outletType: 'SSS' as const, geoLevel: 'CITY' as const,
      geoName: 'Mumbai', months: [futureMonth],
      kpis: [{ id: 'k2', displayName: 'SKU', type: 'focus_sku' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const, targetValues: {},
      createdAt: '', updatedAt: '',
    };
    const rows = getResolvedTargetsData(futureMonth, [stateCfg, cityCfg]);
    // RT-001 is in Mumbai, Maharashtra — city wins
    const rt001 = rows.find(r => r.outletId === 'RT-001');
    expect(rt001!.targetSource).toBe('City: Mumbai');
    // RT-003 is in Pune, Maharashtra — state applies (no city config for Pune)
    const rt003 = rows.find(r => r.outletId === 'RT-003');
    expect(rt003!.targetSource).toBe('State: Maharashtra');
  });

  it('B8: kpiValues uses KPI displayName as key', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-06';
    const cfg = {
      id: 'test-kpi',
      outletType: 'SSS' as const,
      geoLevel: 'INDIA' as const,
      geoName: 'Pan India',
      months: [futureMonth],
      kpis: [{ id: 'kpiA', displayName: 'Monthly Volume', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'ACTIVE' as const,
      targetValues: { [futureMonth]: { 'RT-001': { kpiA: 250 } } },
      createdAt: '', updatedAt: '',
    };
    const rows = getResolvedTargetsData(futureMonth, [cfg]);
    const rt001 = rows.find(r => r.outletId === 'RT-001');
    expect(rt001!.kpiValues['Monthly Volume']).toBe(250);
  });

  it('B9: row includes outletType, city, state, asmZone, month fields', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const rows = getResolvedTargetsData('2099-07', []);
    const row = rows[0];
    expect(row).toHaveProperty('outletType');
    expect(row).toHaveProperty('city');
    expect(row).toHaveProperty('state');
    expect(row).toHaveProperty('asmZone');
    expect(row).toHaveProperty('month');
  });

  it('B10: covers all outlet types (RETAILER, WHOLESALER, SUB_STOCKIST, MT)', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const rows = getResolvedTargetsData('2099-08', []);
    const types = new Set(rows.map(r => r.outletType));
    expect(types.has('SSS')).toBe(true);
    expect(types.has('WHOLESALER')).toBe(true);
    expect(types.has('SUB_STOCKIST')).toBe(true);
    expect(types.has('SSS_TOT')).toBe(true);
  });

  it('B11: DRAFT configs are ignored', async () => {
    const { getResolvedTargetsData } = await import('../targets');
    const futureMonth = '2099-09';
    const draftCfg = {
      id: 'draft',
      outletType: 'SSS' as const,
      geoLevel: 'INDIA' as const,
      geoName: 'Pan India',
      months: [futureMonth],
      kpis: [{ id: 'k1', displayName: 'Vol', type: 'monthly_volume' as const, unit: 'cases', isPrimary: true }],
      status: 'DRAFT' as const,
      targetValues: {},
      createdAt: '', updatedAt: '',
    };
    const rows = getResolvedTargetsData(futureMonth, [draftCfg]);
    rows.filter(r => r.outletType === 'SSS')
      .forEach(r => expect(r.targetSource).toBe('No target set'));
  });
});

// ─── C: Page — Re-upload button on ACTIVE configs ─────────────────────────────

describe('C — admin/targets/page.tsx: re-upload for ACTIVE configs', () => {
  const page = src('app/admin/targets/page.tsx');

  it('C1: Upload button is NOT restricted to DRAFT status only', () => {
    // The old code: cfg.status === 'DRAFT' && (...Upload button)
    // The new code should show it for both DRAFT and ACTIVE
    // Check there is NO hard === 'DRAFT' guard immediately before the Upload button JSX
    // (the button text "Re-upload" or "Update Targets" must appear)
    const hasReupload =
      page.includes('Re-upload') ||
      page.includes('Re-Upload') ||
      page.includes('Update Targets');
    expect(hasReupload).toBe(true);
  });

  it('C2: ConfigCard onUpload prop is still present', () => {
    expect(page).toMatch(/onUpload\s*[=:]/);
  });

  it('C3: Upload button shown for ACTIVE status (not only DRAFT)', () => {
    // There must be a condition that renders upload for both statuses
    // i.e., the button render block should NOT have cfg.status === 'DRAFT' as sole guard
    // A reliable proxy: the page no longer contains the old sole-guard pattern
    const soleGuard = /cfg\.status\s*===\s*['"]DRAFT['"]\s*&&\s*\(\s*<button[^>]*>[\s\S]{0,50}Upload/;
    expect(soleGuard.test(page)).toBe(false);
  });
});

// ─── D: Page — past-month rejection in UploadModal ───────────────────────────

describe('D — UploadModal: past-month rows are rejected', () => {
  const page = src('app/admin/targets/page.tsx');

  it('D1: isMonthLocked is called inside the row-processing loop', () => {
    // The modal must call isMonthLocked on matchedMonth to reject past rows
    expect(page).toMatch(/isMonthLocked\s*\(\s*matchedMonth\s*\)/);
  });

  it('D2: there is a rejection reason mentioning locked / past', () => {
    const hasLockedMsg =
      page.includes('locked') && (page.includes('past') || page.includes('cannot be updated'));
    expect(hasLockedMsg).toBe(true);
  });
});

// ─── E: Page — merge behaviour on re-confirm ─────────────────────────────────

describe('E — UploadModal: re-upload merges, not replaces', () => {
  const page = src('app/admin/targets/page.tsx');

  it('E1: confirm handler spreads existing config.targetValues', () => {
    // The confirm must spread existing values so locked months are preserved
    expect(page).toMatch(/\.\.\.\s*config\.targetValues/);
  });
});

// ─── F: Page — Download Final Targets button & xlsxDownloadResolvedTargets ───

describe('F — admin/targets/page.tsx: resolved targets download', () => {
  const page = src('app/admin/targets/page.tsx');

  it('F1: xlsxDownloadResolvedTargets function exists in page', () => {
    expect(page).toMatch(/xlsxDownloadResolvedTargets/);
  });

  it('F2: xlsxDownloadResolvedTargets calls getResolvedTargetsData', () => {
    expect(page).toMatch(/getResolvedTargetsData/);
  });

  it('F3: "Download Final Targets" (or similar) label appears in page JSX', () => {
    const hasLabel =
      page.includes('Download Final Targets') ||
      page.includes('Final Targets') ||
      page.includes('Resolved Targets');
    expect(hasLabel).toBe(true);
  });

  it('F4: a month picker for the resolved download exists in the page', () => {
    // The resolved download needs a month selector so admin picks which month to export
    // Proxy: page has a state variable for the download month
    const hasMonthState =
      page.includes('downloadMonth') ||
      page.includes('resolvedMonth') ||
      page.includes('finalMonth');
    expect(hasMonthState).toBe(true);
  });

  it('F5: the Excel file name includes "resolved_targets" or "final_targets"', () => {
    const hasFileName =
      page.includes('resolved_targets') ||
      page.includes('final_targets');
    expect(hasFileName).toBe(true);
  });

  it('F6: getResolvedTargetsData is imported from lib/targets', () => {
    expect(page).toMatch(/getResolvedTargetsData.*from.*targets/s);
  });
});
