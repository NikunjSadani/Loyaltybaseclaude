/// <reference types="vitest/globals" />
/**
 * KYC — Admin KYC list "Export" button (Option B: relabel + empty-state)
 *
 * The export downloads the GIFSY-stage review worksheet (only PENDING_GIFSY submissions),
 * NOT the on-screen list. To stop operators getting a confusing headers-only file, the button
 * is relabelled by mode and DISABLED with a clear reason when the target set is empty.
 *
 * EXP1: 0 PENDING_GIFSY submissions → "Export Gifsy Review Sheet" is disabled + shows
 *       "No submissions are awaiting Gifsy review".
 * EXP2: ≥1 PENDING_GIFSY submission → the button is enabled (no empty hint).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
// Export button is gated on isGifsyAdmin (adminSession.role === 'GIFSY_ADMIN').
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'GIFSY_ADMIN' }) }));

import KYCPage from '../page';

function stubKyc(submissions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { submissions, pagination: { page: 1, limit: 500, total: submissions.length, pages: 1 }, statusCounts: {} },
    }),
  }));
}

const fieldStageSub = {
  id: 'KYC-F1', status: 'PENDING_SO_APPROVAL',
  submittedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321' },
  partner: { id: 'p1', businessName: 'Sharma General Store' },
  documents: [],
};
const gifsyStageSub = {
  id: 'KYC-G1', status: 'PENDING_GIFSY',
  submittedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
  gifsyEnteredAt: '2026-05-02T00:00:00.000Z',
  user: { id: 'u2', name: 'Sanjay Kumar', phone: '9811034021' },
  partner: { id: 'p2', businessName: 'Ramesh Traders' },
  documents: [],
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('KYC — Export button (Gifsy review sheet)', () => {
  it('EXP1: with 0 PENDING_GIFSY submissions the export is disabled + explains why', async () => {
    stubKyc([fieldStageSub]); // field-stage only → nothing awaiting Gifsy
    render(<KYCPage />);
    const btn = await screen.findByRole('button', { name: /Export Gifsy Review Sheet/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText('No submissions are awaiting Gifsy review')).toBeInTheDocument();
  });

  it('EXP2: with a PENDING_GIFSY submission the export is enabled (no empty hint)', async () => {
    stubKyc([fieldStageSub, gifsyStageSub]);
    render(<KYCPage />);
    const btn = await screen.findByRole('button', { name: /Export Gifsy Review Sheet/i });
    expect(btn).toBeEnabled();
    expect(screen.queryByText('No submissions are awaiting Gifsy review')).toBeNull();
  });
});
