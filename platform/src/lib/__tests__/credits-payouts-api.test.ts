/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts FE wiring
 *
 * Source-read tests for the credits-payouts FE migration off localStorage libs.
 * The route-existence + role-gating groups (old A/E) were retired with D2 (#31) —
 * those `app/api/admin/credits/*` routes are gone; the logic now lives in
 * `api/src/credits`+`payouts`, role-gated there. The surviving groups assert the
 * FE pages use the (proxied) fetch API and the client-side compute libs are intact.
 *
 *   B — Pages use fetch / API, NOT localStorage lib imports
 *   C — localStorage libs are DELETED
 *   D — Pure compute libs still exist with correct signatures
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

function exists(rel: string): boolean {
  return existsSync(resolve(ROOT, rel));
}

// ─── B — Pages use fetch API, not localStorage libs ───────────────────────────

describe('B — Pages import from fetch API, not localStorage libs', () => {
  it('B1: fields page does NOT import from credits-payouts-fields lib', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-fields['"]/);
  });

  it('B2: fields page fetches /api/admin/credits/fields', () => {
    const code = src('src/app/admin/credits-payouts/fields/page.tsx');
    expect(code).toMatch(/\/api\/admin\/credits\/fields/);
  });

  it('B3: upload page does NOT import from credits-payouts-store', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-store['"]/);
  });

  it('B4: upload page does NOT import from credits-payouts-payout-store', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-payout-store['"]/);
  });

  it('B5: upload page does NOT import from credits-payouts-fields lib', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-fields['"]/);
  });

  it('B6: upload page KEEPS credits-payouts-parser import (client-side parse)', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/credits-payouts-parser/);
  });

  it('B7: upload page KEEPS credits-payouts-template import (client-side template)', () => {
    const code = src('src/app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/credits-payouts-template/);
  });

  it('B8: status page does NOT import from credits-payouts-store', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-store['"]/);
  });

  it('B9: status page does NOT import from credits-payouts-reversal', () => {
    const code = src('src/app/admin/credits-payouts/status/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-reversal['"]/);
  });

  it('B10: payout page does NOT import from credits-payouts-fields', () => {
    const code = src('src/app/admin/credits-payouts/payout/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-fields['"]/);
  });

  it('B11: payout page does NOT import from credits-payouts-payout-store', () => {
    const code = src('src/app/admin/credits-payouts/payout/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-payout-store['"]/);
  });

  it('B12: payout page does NOT import from credits-payouts-reversal', () => {
    const code = src('src/app/admin/credits-payouts/payout/page.tsx');
    expect(code).not.toMatch(/from ['"]@\/lib\/credits-payouts-reversal['"]/);
  });
});

// ─── C — localStorage libs are DELETED ────────────────────────────────────────

describe('C — localStorage libs are deleted', () => {
  it('C1: credits-payouts-fields.ts does NOT exist', () => {
    expect(exists('src/lib/credits-payouts-fields.ts')).toBe(false);
  });

  it('C2: credits-payouts-store.ts does NOT exist', () => {
    expect(exists('src/lib/credits-payouts-store.ts')).toBe(false);
  });

  it('C3: credits-payouts-payout-store.ts does NOT exist', () => {
    expect(exists('src/lib/credits-payouts-payout-store.ts')).toBe(false);
  });

  it('C4: credits-payouts-reversal.ts does NOT exist', () => {
    expect(exists('src/lib/credits-payouts-reversal.ts')).toBe(false);
  });
});

// ─── D — Pure compute libs still exist ───────────────────────────────────────

describe('D — Pure compute libs are intact', () => {
  it('D1: credits-payouts-parser.ts still exists', () => {
    expect(exists('src/lib/credits-payouts-parser.ts')).toBe(true);
  });

  it('D2: credits-payouts-template.ts still exists', () => {
    expect(exists('src/lib/credits-payouts-template.ts')).toBe(true);
  });

  it('D3: template does NOT import MOCK_OUTLETS', () => {
    const code = src('src/lib/credits-payouts-template.ts');
    expect(code).not.toMatch(/MOCK_OUTLETS/);
  });

  it('D4: template does NOT export getEligibleOutlets', () => {
    const code = src('src/lib/credits-payouts-template.ts');
    expect(code).not.toMatch(/export\s+function\s+getEligibleOutlets/);
  });

  it('D5: credits-payouts-payout-download.ts still exists', () => {
    expect(exists('src/lib/credits-payouts-payout-download.ts')).toBe(true);
  });

  it('D6: payout-download does NOT import from credits-payouts-payout-store', () => {
    const code = src('src/lib/credits-payouts-payout-download.ts');
    expect(code).not.toMatch(/credits-payouts-payout-store/);
  });

  it('D7: payout-download still exports generatePayoutFileBuffer', () => {
    const code = src('src/lib/credits-payouts-payout-download.ts');
    expect(code).toMatch(/export\s+function\s+generatePayoutFileBuffer/);
  });

  it('D8: credits-payouts-utr.ts still exists', () => {
    expect(exists('src/lib/credits-payouts-utr.ts')).toBe(true);
  });

  it('D9: utr.ts does NOT import from credits-payouts-payout-store', () => {
    const code = src('src/lib/credits-payouts-utr.ts');
    expect(code).not.toMatch(/credits-payouts-payout-store/);
  });

  it('D10: utr.ts parseUtrUpload accepts batchRows + knownUtrs (injectable)', () => {
    const code = src('src/lib/credits-payouts-utr.ts');
    expect(code).toMatch(/batchRows/);
    expect(code).toMatch(/knownUtrs/);
  });
});
