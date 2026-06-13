/// <reference types="vitest/globals" />
/**
 * KYCID — Admin KYC detail page API wiring
 *
 * KYCID1: shows loading spinner on mount
 * KYCID2: renders outlet name from API response
 * KYCID3: shows error message when fetch fails
 * KYCID4: shows "not found" message when API returns 404
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

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

// Mock react `use` hook for params — the page calls `use(params)`
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) {
        // It's a Promise — return the resolved value synchronously for tests
        // The page calls use(params) where params = Promise<{ id: string }>
        return { id: 'KYC001' };
      }
      return actual.use(val as React.Context<unknown>);
    }),
  };
});

import KYCDetailPage from '../page';

const MOCK_SUBMISSION = {
  id: 'KYC001',
  status: 'PENDING_GIFSY',
  submittedAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  rejectionReason: null,
  reviewerNotes: null,
  user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321', role: 'SALES_SO' },
  partner: {
    id: 'p1', businessName: 'Sharma General Store',
    gstNumber: '27AABCS1429B1Z5', panNumber: 'AABCS1429B',
    address: 'Shop No. 12', city: 'Mumbai', state: 'Maharashtra', pincode: '400053',
    bankName: 'HDFC Bank', bankAccountNumber: '50100XXXXXX12', ifscCode: 'HDFC0004832',
  },
  documents: [
    { id: 'd1', documentType: 'PAN_CARD', fileUrl: 'https://placehold.co/600x400', status: 'SUBMITTED' },
  ],
  statusHistory: [
    { id: 'h1', toStatus: 'SUBMITTED', createdAt: '2026-05-01T09:14:00.000Z', notes: 'Initial', changedByUserId: 'u1' },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('KYCID — Admin KYC detail API wiring', () => {
  it('KYCID1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('KYCID2: renders outlet name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: { submission: MOCK_SUBMISSION } }),
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    // outletName appears in both <h1> and firmName row — use findAllByText
    const matches = await screen.findAllByText('Sharma General Store');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('KYCID3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('KYCID4: shows "not found" when API returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ success: false, error: 'KYC submission not found' }),
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'NOTFOUND' })} />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });
});
