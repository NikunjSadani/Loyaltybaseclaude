/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts Phase 2: Admin Pages (source-read tests)
 *
 * Groups:
 *   A — Payout page (Gifsy payout download + UTR upload)
 *   B — Upload page updates (createPayoutEntriesFromBatch called)
 *   C — Nav / layout (payout child entry)
 *   D — Reversal page (basic structure)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

function appFile(rel: string): string {
  return readFileSync(resolve(ROOT, 'src/app', rel), 'utf-8');
}

function libFile(rel: string): string {
  return readFileSync(resolve(ROOT, 'src/lib', rel), 'utf-8');
}

function appExists(rel: string): boolean {
  return existsSync(resolve(ROOT, 'src/app', rel));
}

// ─── A — Payout page ──────────────────────────────────────────────────────────

describe('A — Payout page', () => {
  it('A1: payout page file exists', () => {
    expect(appExists('admin/credits-payouts/payout/page.tsx')).toBe(true);
  });

  it('A2: payout page is GIFSY_ADMIN gated', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('A3: payout page imports createPayoutBatch', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    expect(code).toMatch(/createPayoutBatch/);
  });

  it('A4: payout page imports PAYOUT_FILE_HEADERS or generatePayoutFileBuffer', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    expect(code).toMatch(/PAYOUT_FILE_HEADERS|generatePayoutFileBuffer/);
  });

  it('A5: payout page imports parseUtrUpload or applyUtrResult', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    expect(code).toMatch(/parseUtrUpload|applyUtrResult/);
  });

  it('A6: payout page has a download button area', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    // Should have some download or "Generate Payout" UI
    expect(code).toMatch(/[Dd]ownload|[Gg]enerate|payout file/i);
  });

  it('A7: payout page has STANDARD and SEPARATE group type options', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    expect(code).toMatch(/STANDARD/);
    expect(code).toMatch(/SEPARATE/);
  });

  it('A8: payout page shows batch status (OPEN/PAID/etc)', () => {
    const code = appFile('admin/credits-payouts/payout/page.tsx');
    // Should reference payout batch status
    expect(code).toMatch(/getAllPayoutBatches|getOpenPayoutBatchesForPeriod|status/);
  });
});

// ─── B — Upload page updates ──────────────────────────────────────────────────

describe('B — Upload page: createPayoutEntriesFromBatch', () => {
  it('B1: upload page imports createPayoutEntriesFromBatch', () => {
    const code = appFile('admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/createPayoutEntriesFromBatch/);
  });

  it('B2: upload page calls createPayoutEntriesFromBatch after confirm', () => {
    const code = appFile('admin/credits-payouts/upload/page.tsx');
    // Should call it in handleConfirm or similar handler
    expect(code).toMatch(/createPayoutEntriesFromBatch\s*\(/);
  });

  it('B3: upload page imports notifyGifsyNewBatch or calls notification', () => {
    const code = appFile('admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/notifyGifsyNewBatch|notifyBatchOutlets/);
  });
});

// ─── C — Nav / layout ─────────────────────────────────────────────────────────

describe('C — Admin layout nav', () => {
  it('C1: layout has Payout nav child under Credits & Payouts', () => {
    const code = appFile('../app/admin/layout.tsx');
    // Check that the payout path is in the nav
    expect(code).toMatch(/credits-payouts\/payout/);
  });

  it('C2: payout nav item is gifsyOnly', () => {
    const code = appFile('../app/admin/layout.tsx');
    // The payout nav entry should be GIFSY_ADMIN only
    // Either via gifsyOnly flag or GIFSY_ADMIN check near the path
    expect(code).toMatch(/gifsyOnly.*true|GIFSY_ADMIN/);
  });
});

// ─── D — Reversal page ────────────────────────────────────────────────────────

describe('D — Reversal page (or integrated view)', () => {
  it('D1: reversal functionality exists in a page file', () => {
    // Reversal can be in its own page or integrated in status/payout page
    const inPayout = appExists('admin/credits-payouts/payout/page.tsx')
      ? appFile('admin/credits-payouts/payout/page.tsx').includes('reversal') ||
        appFile('admin/credits-payouts/payout/page.tsx').includes('Reversal')
      : false;
    const inStatus = appExists('admin/credits-payouts/status/page.tsx')
      ? appFile('admin/credits-payouts/status/page.tsx').includes('reversal') ||
        appFile('admin/credits-payouts/status/page.tsx').includes('Reversal')
      : false;
    const reversalPageExists = appExists('admin/credits-payouts/reversal/page.tsx');

    expect(inPayout || inStatus || reversalPageExists).toBe(true);
  });

  it('D2: initiateReversal imported somewhere in admin pages', () => {
    // Check that reversal lib is wired into at least one admin page
    const files = [
      'admin/credits-payouts/status/page.tsx',
      'admin/credits-payouts/payout/page.tsx',
    ];
    const importFound = files.some((f) => {
      if (!appExists(f)) return false;
      return appFile(f).includes('initiateReversal') || appFile(f).includes('credits-payouts-reversal');
    });
    const reversalPageWithImport = appExists('admin/credits-payouts/reversal/page.tsx')
      ? appFile('admin/credits-payouts/reversal/page.tsx').includes('initiateReversal')
      : false;
    expect(importFound || reversalPageWithImport).toBe(true);
  });
});
