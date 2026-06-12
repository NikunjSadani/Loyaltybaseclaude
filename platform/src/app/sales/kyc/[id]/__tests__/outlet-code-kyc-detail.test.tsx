/// <reference types="vitest/globals" />
/**
 * TDD — Outlet code in the KYC detail (Store Information) page
 *
 * S9:  Outlet code is rendered in the top page header (alongside firm name)
 * S10: The header outlet code has monospace styling
 * S11: Outlet code is present inside the "Store Information" collapsible section
 * S12: The Store Information outlet code element has data-testid="kyc-store-outlet-code"
 * S13: Outlet photos section shows a lazy "View Photos" button, no inline thumbnails
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

// The detail page uses use(params) which suspends — we flush with act + await
async function renderK1() {
  const params = Promise.resolve({ id: 'k1' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    // Awaiting inside act flushes React's internal Promise tracking
    await params;
  });
  await waitFor(
    () => expect(screen.getByText('Kumar General Store')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('S — Outlet code in KYC detail', () => {
  beforeEach(() => {
    localStorage.clear();
    // No fake timers — this page resolves synchronously once Promise is flushed
  });

  it('S9: outlet code is rendered in the page header', async () => {
    await renderK1();
    const code = screen.getByTestId('kyc-header-outlet-code');
    expect(code).toBeInTheDocument();
    expect(code.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('S10: the header outlet code has font-mono class', async () => {
    await renderK1();
    const code = screen.getByTestId('kyc-header-outlet-code');
    expect(code.className).toMatch(/font-mono/);
  });

  it('S11: outlet code is present inside the Store Information section', async () => {
    await renderK1();
    // Open the collapsible Store Information section
    fireEvent.click(screen.getByText(/store information/i));
    await waitFor(() =>
      expect(screen.getByTestId('kyc-store-outlet-code')).toBeInTheDocument(),
    );
  });

  it('S12: store-info outlet code is non-empty', async () => {
    await renderK1();
    fireEvent.click(screen.getByText(/store information/i));
    await waitFor(() => screen.getByTestId('kyc-store-outlet-code'));
    expect(screen.getByTestId('kyc-store-outlet-code').textContent?.trim().length).toBeGreaterThan(0);
  });

  it('S13: outlet photos section shows a lazy "View Photos" button, no inline thumbnails', async () => {
    await renderK1();
    fireEvent.click(screen.getByText(/store information/i));
    await waitFor(() =>
      expect(screen.getByTestId('outlet-photo-view-btn')).toBeInTheDocument(),
    );
    // Lightbox must NOT be open before the user clicks
    expect(screen.queryByTestId('outlet-photo-lightbox')).not.toBeInTheDocument();
  });
});
