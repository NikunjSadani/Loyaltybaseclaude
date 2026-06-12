/// <reference types="vitest/globals" />
/**
 * TDD — Outlet code in the KYC submissions list page
 *
 * S6: Each KYC entry row shows the outlet code alongside the firm name
 * S7: The outlet code uses a monospace / code-like style (font-mono)
 * S8: Searching by outlet code filters the list
 */

import React, { Suspense } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter:      () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import KYCListPage from '../page';

async function renderAndLoad() {
  render(<KYCListPage />);
  // KYC list has a 500 ms setTimeout before setting mock data
  await waitFor(
    () => expect(screen.getAllByTestId('kyc-entry-outlet-code').length).toBeGreaterThan(0),
    { timeout: 2000 },
  );
}

describe('S — Outlet code in KYC list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('S6: each KYC entry row shows an outlet code (data-testid="kyc-entry-outlet-code")', async () => {
    await renderAndLoad();
    const codes = screen.getAllByTestId('kyc-entry-outlet-code');
    // All 8 mock entries should have outlet codes shown
    expect(codes.length).toBeGreaterThanOrEqual(8);
  });

  it('S7: the outlet code element has font-mono class for monospace rendering', async () => {
    await renderAndLoad();
    const firstCode = screen.getAllByTestId('kyc-entry-outlet-code')[0];
    expect(firstCode.className).toMatch(/font-mono/);
  });

  it('S8: searching by outlet code filters the list', async () => {
    await renderAndLoad();
    // Pick the first outlet code value rendered
    const firstCode = screen.getAllByTestId('kyc-entry-outlet-code')[0];
    const codeText  = firstCode.textContent ?? '';
    expect(codeText.length).toBeGreaterThan(0);

    // Type the code into the search input
    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: codeText } });

    // At least one row should still be visible; unrelated rows should be gone
    const remaining = screen.getAllByTestId('kyc-entry-outlet-code');
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    expect(remaining.length).toBeLessThan(8);
  });
});
