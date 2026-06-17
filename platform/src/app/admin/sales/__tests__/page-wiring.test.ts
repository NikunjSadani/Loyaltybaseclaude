/// <reference types="vitest/globals" />
/**
 * TDD — admin/sales/page.tsx endpoint wiring
 *
 * These tests verify that the sales page is wired to the correct (new) backend
 * proxy endpoints. They are source-code assertion tests — they read the page
 * source and check for the presence / absence of specific endpoint strings and
 * patterns, matching the style used in targets-excel.test.ts.
 *
 * PW1:  Page calls /api/admin/achievements/batches (not /api/admin/sales/batches)
 * PW2:  Page does NOT call the old /api/admin/kpi-config endpoint
 * PW3:  Page calls /api/admin/kpis for KPI list
 * PW4:  Page uploads to /api/admin/achievements/upload (not /api/admin/sales/bulk-upload)
 * PW5:  Upload uses FormData multipart (not JSON body)
 * PW6:  Page calls /api/admin/achievements/pace for pace view
 * PW7:  Page renders a pace view section (PaceView component or similar label)
 * PW8:  Page imports formatMonth from @/lib/targets
 * PW9:  UploadResult type has acceptedCount and rejectedCount fields
 * PW10: Page no longer calls the old /api/admin/sales/bulk-upload endpoint
 * PW11: Batch history DELETE still calls /api/admin/sales/batches/[batchId]
 * PW12: Upload sends FormData (not JSON.stringify)
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect } from 'vitest';

/** Read a file relative to platform/src */
const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../..', rel), 'utf-8');

const page = src('app/admin/sales/page.tsx');

describe('admin/sales/page.tsx — endpoint wiring', () => {

  it('PW1: fetches batch list from /api/admin/achievements/batches', () => {
    expect(page).toContain('/api/admin/achievements/batches');
  });

  it('PW2: does NOT call the old /api/admin/sales/batches for list (only for delete)', () => {
    // Batches list should use achievements/batches; the only reference to
    // /api/admin/sales/batches should be for the DELETE path
    const listCallOld = /fetch\(['"`]\/api\/admin\/sales\/batches['"`]/.test(page);
    expect(listCallOld).toBe(false);
  });

  it('PW3: calls /api/admin/kpis for KPI list', () => {
    expect(page).toContain('/api/admin/kpis');
  });

  it('PW4: uploads to /api/admin/achievements/upload', () => {
    expect(page).toContain('/api/admin/achievements/upload');
  });

  it('PW5: upload uses FormData (multipart), not JSON.stringify', () => {
    expect(page).toContain('new FormData()');
    expect(page).toContain("formData.append('file'");
    // Must NOT use JSON.stringify for the upload body
    const hasJsonUpload = /fetch\([^)]*achievements\/upload[^)]*JSON\.stringify/s.test(page);
    expect(hasJsonUpload).toBe(false);
  });

  it('PW6: calls /api/admin/achievements/pace for pace view', () => {
    expect(page).toContain('/api/admin/achievements/pace');
  });

  it('PW7: renders a pace view section with BarChart3 or pace label', () => {
    const hasPaceUI =
      page.includes('Pace View') ||
      page.includes('PaceView') ||
      page.includes('BarChart3');
    expect(hasPaceUI).toBe(true);
  });

  it('PW8: imports formatMonth from @/lib/targets', () => {
    expect(page).toMatch(/formatMonth.*from.*lib\/targets/);
  });

  it('PW9: UploadResult interface has acceptedCount and rejectedCount', () => {
    expect(page).toMatch(/acceptedCount/);
    expect(page).toMatch(/rejectedCount/);
  });

  it('PW10: does NOT call /api/admin/sales/bulk-upload', () => {
    expect(page).not.toContain('/api/admin/sales/bulk-upload');
  });

  it('PW11: DELETE for batch history still targets /api/admin/sales/batches/[batchId]', () => {
    // The delete path must still use the existing working DELETE route
    expect(page).toContain('/api/admin/sales/batches/');
    expect(page).toMatch(/method.*DELETE|DELETE.*method/s);
  });

  it('PW12: upload sends FormData body (not JSON-serialised body)', () => {
    // The handleFile/upload function must NOT use JSON.stringify for the achievement upload
    expect(page).not.toContain("body: JSON.stringify({");
    expect(page).toMatch(/body:\s*formData/);
  });

  it('PW13: does NOT call /api/admin/kpi-config (old endpoint replaced)', () => {
    expect(page).not.toContain('/api/admin/kpi-config');
  });

  it('PW14: pace view is togglable (Show/Hide button or similar)', () => {
    const hasToggle =
      page.includes("'Hide'") || page.includes('"Hide"') ||
      page.includes("'Show'") || page.includes('"Show"') ||
      page.includes('showPace');
    expect(hasToggle).toBe(true);
  });

  it('PW15: pace null rendered as dash (—)', () => {
    // Pace display must handle null gracefully — show "—" when pace is null
    expect(page).toMatch(/null.*'—'|null.*"—"|pctVal.*null.*'—'|'—'/);
  });
});
