/// <reference types="vitest/globals" />
/**
 * FT — Admin KYC detail: GIFSY-reject fast-track banner (Bajaj flag gifsyRejectFastTrack).
 *
 * FT1: fastTrack set → banner with the headline, "Previous KYC rejected on <date>" and a link to the
 *      previous submission's admin page; the DRAFT→PENDING_GIFSY history row reads as a system note.
 * FT2: fastTrack null → no banner (Deoleo / normal submission byte-identical).
 * FT3: fastTrack missing (older API) → no banner.
 * FT4: unparseable rejection date → still flags the skip, without an "Invalid Date".
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { formatFastTrackDate } from '@/lib/kyc-fast-track';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) return { id: 'KYC002' };
      return actual.use(val as React.Context<unknown>);
    }),
  };
});

import KYCDetailPage from '../page';

const HEADLINE = 'Resubmitted after GIFSY rejection — sent straight to GIFSY (manager approval skipped)';
const HISTORY_NOTE = 'Resubmitted after GIFSY rejection — sent straight to GIFSY (manager approval skipped)';
const LOAD = { timeout: 10_000 };

// Relative to now — never a hardcoded date.
const rejectedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
const createdAt = new Date(Date.now() - 2 * 86_400_000).toISOString();

function submission(extra: Record<string, unknown>) {
  return {
    id: 'KYC002', status: 'PENDING_GIFSY',
    submittedAt: createdAt, createdAt,
    user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321', role: 'SALES_SO' },
    partner: {
      id: 'p1', businessName: 'Sharma General Store', ownerName: 'Anil Sharma', partnerCode: 'CP777',
      outlets: [{ outletCode: 'O999', name: 'Sharma General Store', city: 'Mumbai', state: 'Maharashtra', pincode: '400053' }],
    },
    documents: [],
    statusHistory: [
      { id: 'h1', toStatus: 'PENDING_GIFSY', createdAt, notes: HISTORY_NOTE },
    ],
    ...extra,
  };
}

function stubFetch(s: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: () => Promise.resolve({ success: true, data: { submission: s } }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('FT — Admin KYC fast-track banner', { timeout: 30_000 }, () => {
  it('FT1: fastTrack set → headline, previous rejection date and a link to the previous submission', async () => {
    stubFetch(submission({ fastTrack: { previousSubmissionId: 'KYC-PREV-1', previousRejectedAt: rejectedAt } }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);

    const banner = await screen.findByTestId('fast-track-banner', undefined, LOAD);
    expect(banner).toHaveAttribute('role', 'note');
    expect(await within(banner).findByText(HEADLINE)).toBeInTheDocument();
    const expectedDate = formatFastTrackDate(rejectedAt);
    expect(expectedDate).toBeTruthy();
    expect(within(banner).getByTestId('fast-track-previous')).toHaveTextContent(`Previous KYC rejected on ${expectedDate}`);
    expect(within(banner).getByRole('link', { name: 'View previous submission' }))
      .toHaveAttribute('href', '/admin/kyc/KYC-PREV-1');
  });

  it('FT1b: the DRAFT→PENDING_GIFSY history row shows the skip note with a System actor (no blank)', async () => {
    stubFetch(submission({ fastTrack: { previousSubmissionId: 'KYC-PREV-1', previousRejectedAt: rejectedAt } }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    await screen.findByTestId('fast-track-banner', undefined, LOAD);
    // Headline in the banner + the same text as the history remark.
    const matches = await screen.findAllByText(HISTORY_NOTE);
    expect(matches.length).toBe(2);
    expect(await screen.findByText(/· System$/)).toBeInTheDocument();
    expect(screen.queryByText(/Approved by/i)).toBeNull();
  });

  it('FT2: fastTrack null → no banner', async () => {
    stubFetch(submission({ fastTrack: null, statusHistory: [] }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    expect(await screen.findByText('Status History', undefined, LOAD)).toBeInTheDocument();
    expect(screen.queryByTestId('fast-track-banner')).toBeNull();
    expect(screen.queryByText(/manager approval skipped/i)).toBeNull();
  });

  it('FT3: fastTrack missing (older API) → no banner', async () => {
    stubFetch(submission({ statusHistory: [] }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    expect(await screen.findByText('Status History', undefined, LOAD)).toBeInTheDocument();
    expect(screen.queryByTestId('fast-track-banner')).toBeNull();
  });

  it('FT4: unparseable rejection date → still flags the skip, never "Invalid Date"', async () => {
    stubFetch(submission({ fastTrack: { previousSubmissionId: 'KYC-PREV-1', previousRejectedAt: 'not-a-date' } }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    const banner = await screen.findByTestId('fast-track-banner', undefined, LOAD);
    expect(within(banner).getByTestId('fast-track-previous')).toHaveTextContent('Previous KYC was rejected by GIFSY');
    expect(banner).not.toHaveTextContent(/invalid date/i);
  });
});
