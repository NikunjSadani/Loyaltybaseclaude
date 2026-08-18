/// <reference types="vitest/globals" />
/**
 * Outlet Wallet page — frozen backend contract wiring.
 *
 * Mirrors the source-assertion style of admin/__tests__/admin-pages-wiring.test.ts:
 * cheap, render-free guards that the GIFSY-only points-wallet page stays wired to the
 * three frozen endpoints, encodes the outletCode in the path, reuses the partner
 * presentational components, and stays guarded to GIFSY_ADMIN.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../../..'); // → platform/src

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

const PAGE   = 'app/admin/outlet-wallet/page.tsx';
const LAYOUT = 'app/admin/outlet-wallet/layout.tsx';

describe('Outlet Wallet — page wiring', () => {
  it('loads the outlet id list from GET /api/admin/outlets/ids', () => {
    expect(src(PAGE)).toMatch(/\/api\/admin\/outlets\/ids/);
  });

  it('fetches the wallet summary with an encoded outletCode', () => {
    const code = src(PAGE);
    expect(code).toMatch(/\/api\/wallet\/admin\/outlet\/\$\{encodeURIComponent\([^)]+\)\}\/summary/);
  });

  it('fetches the passbook with an encoded outletCode + page/limit params', () => {
    const code = src(PAGE);
    expect(code).toMatch(/\/api\/wallet\/admin\/outlet\/\$\{encodeURIComponent\([^)]+\)\}\/transactions/);
    expect(code).toMatch(/limit/);
    expect(code).toMatch(/page/);
  });

  it('posts a manual adjust to POST /api/wallet/adjust with the frozen body fields', () => {
    const code = src(PAGE);
    expect(code).toMatch(/\/api\/wallet\/adjust/);
    expect(code).toMatch(/method:\s*'POST'/);
    // Frozen body: partnerId (from summary, never asked), amount, type, reason, approvedBy
    expect(code).toMatch(/partnerId:\s*summary\.partnerId/);
    expect(code).toMatch(/amount:/);
    expect(code).toMatch(/type:\s*adjType/);
    expect(code).toMatch(/reason:/);
    expect(code).toMatch(/approvedBy:/);
  });

  it('reuses the partner passbook row (TransactionItem)', () => {
    const code = src(PAGE);
    expect(code).toMatch(/@\/components\/wallet\/transaction-item/);
  });

  it('does NOT reuse BalanceCard (its headline mislabels the current earned bucket as "Lifetime Earned")', () => {
    // The admin view leads with a correctly-labelled "Available to redeem" headline instead.
    const code = src(PAGE);
    expect(code).not.toMatch(/@\/components\/wallet\/balance-card/);
    expect(code).toMatch(/Available to redeem/);
  });

  it('uses the SearchableSelect outlet picker', () => {
    expect(src(PAGE)).toMatch(/@\/components\/ui\/searchable-select/);
  });

  it('disables the adjust button when the outlet has no wallet', () => {
    const code = src(PAGE);
    // hasWallet gates the Adjust button's disabled state
    expect(code).toMatch(/disabled=\{!hasWallet\}/);
    expect(code).toMatch(/no wallet yet/i);
  });

  it('confirms before submitting (a confirm step, not a pending queue)', () => {
    const code = src(PAGE);
    expect(code).toMatch(/adjConfirming/);
    expect(code).toMatch(/Confirm & submit/);
  });

  it('renders the adjust modal as an accessible dialog', () => {
    const code = src(PAGE);
    expect(code).toMatch(/role="dialog"/);
    expect(code).toMatch(/aria-modal="true"/);
  });

  it('treats points as whole integers — no ×100 / ÷100 on points values', () => {
    const code = src(PAGE);
    expect(code).not.toMatch(/redeemablePoints\s*\/\s*100/);
    expect(code).not.toMatch(/points\s*\*\s*100/);
  });
});

describe('Outlet Wallet — route guard', () => {
  it('guards the page to GIFSY_ADMIN via RequireAuth', () => {
    const code = src(LAYOUT);
    expect(code).toMatch(/RequireAuth/);
    expect(code).toMatch(/allowedRoles=\{\['GIFSY_ADMIN'\]\}/);
  });
});
