/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: Page Structure Compliance
 *
 * Groups:
 *   A — Admin hub page (/admin/credits-payouts)
 *   B — Fields config page (/admin/credits-payouts/fields)
 *   C — Upload page (/admin/credits-payouts/upload)
 *   D — Status page (/admin/credits-payouts/status)
 *   E — Admin layout nav
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve }                   from 'path';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../..', rel), 'utf-8');

const exists = (rel: string) =>
  existsSync(resolve(__dirname, '../../..', rel));

// ─── A — Hub page ─────────────────────────────────────────────────────────────

describe('A — Admin hub page: app/admin/credits-payouts/page.tsx', () => {
  it('A1: file exists', () => {
    expect(exists('src/app/admin/credits-payouts/page.tsx')).toBe(true);
  });

  it('A2: exports a default React component', () => {
    const code = src('src/app/admin/credits-payouts/page.tsx');
    expect(code).toMatch(/export\s+default\s+function/);
  });

  it('A3: has "use client" directive', () => {
    const code = src('src/app/admin/credits-payouts/page.tsx');
    expect(code).toMatch(/'use client'/);
  });

  it('A4: links to /admin/credits-payouts/upload', () => {
    const code = src('src/app/admin/credits-payouts/page.tsx');
    expect(code).toMatch(/credits-payouts\/upload/);
  });

  it('A5: links to or references /admin/credits-payouts/status', () => {
    const code = src('src/app/admin/credits-payouts/page.tsx');
    expect(code).toMatch(/credits-payouts\/status/);
  });
});

// ─── B — Fields page ──────────────────────────────────────────────────────────

describe('B — Fields config page: app/admin/credits-payouts/fields/page.tsx', () => {
  it('B1: file exists', () => {
    expect(exists('src/app/admin/credits-payouts/fields/page.tsx')).toBe(true);
  });

  it('B2: exports a default React component', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/export\s+default\s+function/);
  });

  it('B3: has "use client" directive', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/'use client'/);
  });

  it('B4: field config is open to all admins (no gifsyOnly gate)', () => {
    // Field configuration was opened to CLIENT_ADMIN — the old lock screen is gone
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).not.toMatch(/Gifsy Admin Access Only/);
    expect(code).not.toMatch(/if\s*\(!isGifsy\)/);
  });

  it('B5: imports field config functions', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/credits-payouts-fields/);
  });

  it('B6: has UI for creating a new field (input + button)', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/createField|Add Field|New Field/i);
  });

  it('B7: has UI for deactivating a field', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/deactivateField|Deactivate/i);
  });
});

// ─── C — Upload page ──────────────────────────────────────────────────────────

describe('C — Upload page: app/admin/credits-payouts/upload/page.tsx', () => {
  it('C1: file exists', () => {
    expect(exists('src/app/admin/credits-payouts/upload/page.tsx')).toBe(true);
  });

  it('C2: exports a default React component', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/export\s+default\s+function/);
  });

  it('C3: has "use client" directive', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/'use client'/);
  });

  it('C4: imports generateCreditTemplate (for template download)', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/generateCreditTemplate|credits-payouts-template/);
  });

  it('C5: imports parseCreditUpload (for parsing)', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/parseCreditUpload|credits-payouts-parser/);
  });

  it('C6: has a step for downloading the template', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/[Dd]ownload.*[Tt]emplate|[Tt]emplate.*[Dd]ownload/);
  });

  it('C7: has a confirm / save step', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/handleConfirm|handleSave|Confirm|Save/i);
  });

  it('C8: shows parse result statistics', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/summary|totalPoints|totalPayout|ok|error/i);
  });
});

// ─── D — Status page ──────────────────────────────────────────────────────────

describe('D — Status page: app/admin/credits-payouts/status/page.tsx', () => {
  it('D1: file exists', () => {
    expect(exists('src/app/admin/credits-payouts/status/page.tsx')).toBe(true);
  });

  it('D2: exports a default React component', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).toMatch(/export\s+default\s+function/);
  });

  it('D3: has "use client" directive', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).toMatch(/'use client'/);
  });

  it('D4: imports from credits-payouts-store', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).toMatch(/credits-payouts-store/);
  });

  it('D5: shows PENDING / CONFIRMED / payout status', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).toMatch(/PENDING|CONFIRMED|status/i);
  });
});

// ─── E — Admin layout nav ─────────────────────────────────────────────────────

describe('E — Admin layout: Credits & Payouts nav item', () => {
  it('E1: layout.tsx references /admin/credits-payouts', () => {
    const code = src('src/app/admin/layout.tsx');
    expect(code).toMatch(/credits-payouts/);
  });

  it('E2: nav item label is "Credits & Payouts"', () => {
    const code = src('src/app/admin/layout.tsx');
    expect(code).toMatch(/Credits.*Payouts|Credits & Payouts/);
  });
});
