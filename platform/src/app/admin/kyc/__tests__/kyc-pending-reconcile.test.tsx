/// <reference types="vitest/globals" />
/**
 * KYC — Admin KYC list: Pending card ⟷ filter reconciliation + SLA-card removal.
 *
 * Regressions covered:
 *  - FIX B: the Pending stat CARD counted PENDING + UNDER_REVIEW ("awaiting review")
 *    but the LIST filter matched only exact PENDING, so the card showed N while the
 *    Pending view showed N-1 (e.g. 6 vs 5). Card and filter must reconcile to the
 *    same inclusive number. The page also now fetches limit=500 so nothing truncates.
 *  - FIX E: the "SLA Breached" stat card was removed (per-row SLA UI stays).
 *
 * PR1: fetch requests a high limit (no silent 20-row truncation)
 * PR2: Pending card counts PENDING + UNDER_REVIEW
 * PR3: clicking Pending shows exactly the same rows as the card count
 * PR4: "SLA Breached" card is gone
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import KYCPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// 1 exact-PENDING + 1 UNDER_REVIEW (both "awaiting review") + 1 APPROVED.
const MOCK_SUBMISSIONS = [
  {
    id: 'KYC001',
    status: 'PENDING_SO_APPROVAL', // → PENDING
    submittedAt: '2026-05-01T00:00:00.000Z',
    user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321' },
    partner: { id: 'p1', businessName: 'Sharma General Store' },
    documents: [],
  },
  {
    id: 'KYC002',
    status: 'UNDER_REVIEW', // → UNDER_REVIEW (counted by Pending card)
    submittedAt: '2026-05-02T00:00:00.000Z',
    user: { id: 'u2', name: 'Sanjay Kumar', phone: '9811034021' },
    partner: { id: 'p2', businessName: 'Ramesh Traders' },
    documents: [],
  },
  {
    id: 'KYC003',
    status: 'APPROVED',
    submittedAt: '2026-04-28T00:00:00.000Z',
    user: { id: 'u3', name: 'Asha Rao', phone: '9800000000' },
    partner: { id: 'p3', businessName: 'Asha Mart' },
    documents: [],
  },
];

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: {
          submissions: MOCK_SUBMISSIONS,
          pagination: { page: 1, limit: 500, total: 3, pages: 1 },
          statusCounts: {},
        },
      }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('KYC — Pending card ⟷ filter reconciliation', () => {
  it('PR1: fetches with a high limit so nothing is truncated', async () => {
    const fetchMock = mockFetchOk();
    render(<KYCPage />);
    await screen.findByText('Sharma General Store');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/kyc');
    expect(url).toMatch(/limit=\d{3,}/); // e.g. limit=500
  });

  it('PR2: Pending card counts PENDING + UNDER_REVIEW (= 2)', async () => {
    mockFetchOk();
    render(<KYCPage />);
    const pendingCard = await screen.findByRole('button', { name: /Pending/i });
    // The big number lives in the same card button as the "Pending" label.
    expect(within(pendingCard).getByText('2')).toBeInTheDocument();
  });

  it('PR3: clicking Pending shows the same rows as the card count', async () => {
    mockFetchOk();
    render(<KYCPage />);
    const pendingCard = await screen.findByRole('button', { name: /Pending/i });
    fireEvent.click(pendingCard);
    // Both awaiting-review outlets visible; the approved one hidden.
    expect(screen.getByText('Sharma General Store')).toBeInTheDocument();
    expect(screen.getByText('Ramesh Traders')).toBeInTheDocument();
    expect(screen.queryByText('Asha Mart')).not.toBeInTheDocument();
    // Footer count agrees with the card (2 shown).
    expect(screen.getByText(/showing 2 of 3/i)).toBeInTheDocument();
  });

  it('PR4: the "SLA Breached" card is removed', async () => {
    mockFetchOk();
    render(<KYCPage />);
    await screen.findByText('Sharma General Store');
    expect(screen.queryByText(/SLA Breached/i)).not.toBeInTheDocument();
  });
});
