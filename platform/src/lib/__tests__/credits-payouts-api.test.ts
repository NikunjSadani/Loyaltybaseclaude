/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts DB Migration
 *
 * Source-read tests that define what "done" looks like for the migration
 * from localStorage-backed libs to Prisma-backed API routes.
 *
 * Groups:
 *   A — API route files exist at expected paths
 *   B — Pages use fetch / API, NOT localStorage lib imports
 *   C — localStorage libs are DELETED
 *   D — Pure compute libs still exist with correct signatures
 *   E — GIFSY_ADMIN vs CLIENT_ADMIN gating in API routes
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

// ─── A — API route files exist ────────────────────────────────────────────────

describe('A — API routes exist', () => {
  it('A1: fields list+create route exists', () => {
    expect(exists('src/app/api/admin/credits/fields/route.ts')).toBe(true);
  });

  it('A2: fields toggle route exists', () => {
    expect(exists('src/app/api/admin/credits/fields/[id]/route.ts')).toBe(true);
  });

  it('A3: eligible-outlets route exists', () => {
    expect(exists('src/app/api/admin/credits/eligible-outlets/route.ts')).toBe(true);
  });

  it('A4: batches list+create route exists', () => {
    expect(exists('src/app/api/admin/credits/batches/route.ts')).toBe(true);
  });

  it('A5: batch confirm route exists', () => {
    expect(exists('src/app/api/admin/credits/batches/[id]/confirm/route.ts')).toBe(true);
  });

  it('A6: payout-downloads list+create route exists', () => {
    expect(exists('src/app/api/admin/credits/payout-downloads/route.ts')).toBe(true);
  });

  it('A7: payout-downloads UTR upload route exists', () => {
    expect(exists('src/app/api/admin/credits/payout-downloads/[id]/utr/route.ts')).toBe(true);
  });

  it('A8: batch reversals list+create route exists', () => {
    expect(exists('src/app/api/admin/credits/batches/[id]/reversals/route.ts')).toBe(true);
  });

  it('A9: reversal approve/reject route exists', () => {
    expect(exists('src/app/api/admin/credits/reversals/[id]/route.ts')).toBe(true);
  });
});

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

// ─── E — Role gating in API routes ───────────────────────────────────────────

describe('E — Role gating in API routes', () => {
  it('E1: payout-downloads route requires GIFSY_ADMIN', () => {
    const code = src('src/app/api/admin/credits/payout-downloads/route.ts');
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('E2: payout-downloads UTR route requires GIFSY_ADMIN', () => {
    const code = src('src/app/api/admin/credits/payout-downloads/[id]/utr/route.ts');
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('E3: reversals approve/reject route requires GIFSY_ADMIN', () => {
    const code = src('src/app/api/admin/credits/reversals/[id]/route.ts');
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('E4: fields route accepts CLIENT_ADMIN', () => {
    const code = src('src/app/api/admin/credits/fields/route.ts');
    expect(code).toMatch(/CLIENT_ADMIN/);
  });

  it('E5: batches confirm route accepts CLIENT_ADMIN', () => {
    const code = src('src/app/api/admin/credits/batches/[id]/confirm/route.ts');
    expect(code).toMatch(/CLIENT_ADMIN/);
  });
});
