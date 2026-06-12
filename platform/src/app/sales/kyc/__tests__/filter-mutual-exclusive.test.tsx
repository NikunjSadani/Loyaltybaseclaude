/// <reference types="vitest/globals" />
/**
 * TDD — KYC list filter: "Approval Pending" and "Under Review" are mutually exclusive
 *
 * AE1: Filter label is "Approval Pending" (not "Approval Required")
 * AE2: "Under Review" for SO role does NOT include PENDING_SO_APPROVAL entries
 *       (those belong exclusively to "Approval Pending")
 * AE3: "Under Review" for SO role DOES include PENDING_ASM_APPROVAL and PENDING_GIFSY entries
 * AE4: "Approval Pending" for SO role shows only PENDING_SO_APPROVAL entries
 * AE5: An entry cannot appear in both "Under Review" and "Approval Pending" simultaneously
 */

import React, { Suspense } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// SO role: approvalStatus = PENDING_SO_APPROVAL
vi.mock('@/lib/sales-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sales-role')>();
  return {
    ...actual,
    getRole:     () => 'SO',
    hasTeamView: (role: string) => actual.hasTeamView(role as import('@/lib/sales-role').SalesRole),
  };
});
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
  await waitFor(
    () => expect(screen.getAllByTestId('kyc-entry-outlet-code').length).toBeGreaterThan(0),
    { timeout: 2000 },
  );
}

function selectFilter(value: string) {
  const select = screen.getByTestId('kyc-status-filter');
  fireEvent.change(select, { target: { value } });
}

describe('AE — KYC filter: Approval Pending / Under Review mutual exclusion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AE1: filter dropdown label is "Approval Pending" (not "Approval Required")', async () => {
    await renderAndLoad();
    const select = screen.getByTestId('kyc-status-filter');
    const optionTexts = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(optionTexts).toContain('Approval Pending');
    expect(optionTexts).not.toContain('Approval Required');
  });

  it('AE2: "Under Review" does NOT show PENDING_SO_APPROVAL entries for SO role', async () => {
    await renderAndLoad();
    selectFilter('UNDER_REVIEW');
    // k2 = Sharma Kirana = PENDING_SO_APPROVAL — SO must approve this, so it must NOT appear here
    expect(screen.queryByText('Sharma Kirana')).not.toBeInTheDocument();
  });

  it('AE3: "Under Review" shows PENDING_ASM_APPROVAL and PENDING_GIFSY entries for SO role', async () => {
    await renderAndLoad();
    selectFilter('UNDER_REVIEW');
    // k5 = Mehta Provisions = PENDING_GIFSY
    expect(screen.getByText('Mehta Provisions')).toBeInTheDocument();
    // k6 = Desai Grocers = PENDING_ASM_APPROVAL (SO does not approve this)
    expect(screen.getByText('Desai Grocers')).toBeInTheDocument();
  });

  it('AE4: "Approval Pending" shows PENDING_SO_APPROVAL entries for SO role', async () => {
    await renderAndLoad();
    selectFilter('APPROVAL_REQUIRED');
    // k2 = Sharma Kirana = PENDING_SO_APPROVAL — SO approves this
    expect(screen.getByText('Sharma Kirana')).toBeInTheDocument();
    // k5 = Mehta Provisions = PENDING_GIFSY — should NOT appear
    expect(screen.queryByText('Mehta Provisions')).not.toBeInTheDocument();
  });

  it('AE5: entry in "Approval Pending" does not appear in "Under Review"', async () => {
    await renderAndLoad();

    // Collect entries visible under "Approval Pending"
    selectFilter('APPROVAL_REQUIRED');
    const approvalEntries = screen
      .getAllByTestId('kyc-entry-outlet-code')
      .map(el => el.textContent ?? '');

    // Collect entries visible under "Under Review"
    selectFilter('UNDER_REVIEW');
    const reviewEntries = screen
      .getAllByTestId('kyc-entry-outlet-code')
      .map(el => el.textContent ?? '');

    // No overlap
    const overlap = approvalEntries.filter(code => reviewEntries.includes(code));
    expect(overlap).toHaveLength(0);
  });
});
