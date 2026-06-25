/// <reference types="vitest/globals" />
/**
 * LG — Sales outlet ledger (Wallet) must not crash during the loading window.
 *
 * Regression for the owner-reported "This page couldn't load" on tapping Wallet.
 * The page dereferenced `outlet!.name` in the title BEFORE the inline loading
 * spinner, so while `outlet` was still null (the whole loading window, and SSR
 * where the effect never runs) it threw — 500-ing the route. The fix returns a
 * spinner until the outlet has loaded.
 *   LG1: a pending fetch renders WITHOUT throwing (title absent, no crash)
 *   LG2: once the ledger resolves, the outlet title renders
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

async function renderLedger(id: string) {
  const params = Promise.resolve({ id });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <OutletLedgerPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('LG — sales outlet ledger loading guard', () => {
  it('LG1: a pending fetch renders a spinner without crashing (no "outlet!" deref while null)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never resolves → stays loading
    // The bug threw here during render; a throw would reject this render.
    await renderLedger('k1');
    // Title block (which dereferences the outlet) is NOT rendered during loading.
    expect(screen.queryByText('Points Ledger')).not.toBeInTheDocument();
  });

  it('LG2: renders the outlet title once the ledger resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        data: {
          meta: { name: 'Verma Traders', outletCode: 'OUT-2026-00111', mobile: '9876543210', balance: 0, lifetime: 0, redeemed: 0 },
          transactions: [],
        },
      }),
    }));
    await renderLedger('k1');
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    expect(screen.getByText('Points Ledger')).toBeInTheDocument();
  });
});
