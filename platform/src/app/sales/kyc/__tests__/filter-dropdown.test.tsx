/// <reference types="vitest/globals" />
/**
 * TDD — KYC list status filter: dropdown instead of pill chips
 *
 * T5: The status filter is rendered as a <select> dropdown (not pill buttons)
 * T6: The dropdown has a "Pending KYC" option
 * T7: Selecting "Pending KYC" hides non-pending entries (e.g. Approved ones)
 */

import React, { Suspense } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter:       () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import KYCListPage from '../page';

async function renderAndLoad() {
  render(<KYCListPage />);
  // Wait for mock data (500 ms setTimeout)
  await waitFor(
    () => expect(screen.getAllByTestId('kyc-entry-outlet-code').length).toBeGreaterThan(0),
    { timeout: 2000 },
  );
}

describe('T — KYC list filter: dropdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T5: the status filter is a <select> dropdown (combobox role)', async () => {
    await renderAndLoad();
    // There should be a select element for status filtering
    const select = screen.getByTestId('kyc-status-filter');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  it('T6: the dropdown contains a "Pending KYC" option', async () => {
    await renderAndLoad();
    const select = screen.getByTestId('kyc-status-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent?.toLowerCase());
    expect(options.some(t => t?.includes('pending kyc'))).toBe(true);
  });

  it('T7: selecting "Pending KYC" filter hides currently-visible Approved entries', async () => {
    await renderAndLoad();
    // Confirm Kumar General Store (k1, APPROVED) is currently visible
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();

    // Change filter to Pending KYC
    const select = screen.getByTestId('kyc-status-filter');
    fireEvent.change(select, { target: { value: 'PENDING' } });

    // APPROVED entry should now be gone (it doesn't match PENDING)
    expect(screen.queryByText('Kumar General Store')).not.toBeInTheDocument();
  });
});
