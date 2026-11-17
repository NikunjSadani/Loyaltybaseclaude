/// <reference types="vitest/globals" />
/**
 * FTQ — GIFSY review queue: fast-tracked resubmissions carry a "Resubmission · managers skipped"
 * badge (and a note on the selected entry) so the reviewer knows no manager re-checked them.
 * Entries with fastTrack null / missing render exactly as before.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { formatFastTrackDate } from '@/lib/kyc-fast-track';

vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ has: () => true, loading: false }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import KycApprovalsPage from '../page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const LOAD = { timeout: 15_000 };
const rejectedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();

function entry(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    submissionId: id, clientId: 'bajaj', outletCode: `OC-${id}`, outletName: name, ownerName: 'Owner',
    mobile: '9000000000', partnerClass: 'RLP', gstNumber: '', panNumber: '', address: 'A', city: 'C',
    state: 'S', pincode: '400001', paymentMode: 'upi', upiId: 'x@okaxis', fields: {},
    ...extra,
  };
}

function stubQueue(entries: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/kyc/review-queue')) return json({ success: true, data: { entries } });
    return json({ success: true, data: [] });
  }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('FTQ — GIFSY queue fast-track badge', { timeout: 30_000 }, () => {
  it('FTQ1: only the fast-tracked entry carries the badge; the selected entry shows the note + link', async () => {
    stubQueue([
      entry('s1', 'Fast Track Stores', { fastTrack: { previousSubmissionId: 'prev-1', previousRejectedAt: rejectedAt } }),
      entry('s2', 'Normal Stores', { fastTrack: null }),
      entry('s3', 'Legacy Stores'), // older API: no field
    ]);
    render(<KycApprovalsPage />);

    const fastBtn = (await screen.findAllByText('Fast Track Stores', undefined, LOAD))
      .map((el) => el.closest('button')).find(Boolean) as HTMLElement;
    expect(await within(fastBtn).findByTestId('fast-track-badge')).toHaveTextContent('Resubmission · managers skipped');

    const normalBtn = (await screen.findByText('Normal Stores')).closest('button') as HTMLElement;
    expect(within(normalBtn).queryByTestId('fast-track-badge')).toBeNull();
    const legacyBtn = (await screen.findByText('Legacy Stores')).closest('button') as HTMLElement;
    expect(within(legacyBtn).queryByTestId('fast-track-badge')).toBeNull();
    expect(screen.getAllByTestId('fast-track-badge')).toHaveLength(1);

    // First entry is auto-selected → the detail note explains the skip.
    const note = await screen.findByTestId('fast-track-detail-note');
    expect(note).toHaveTextContent('Resubmitted after GIFSY rejection — sent straight to GIFSY (manager approval skipped)');
    expect(note).toHaveTextContent(`Previous KYC rejected on ${formatFastTrackDate(rejectedAt)}`);
    expect(within(note).getByRole('link', { name: 'View previous submission' })).toHaveAttribute('href', '/admin/kyc/prev-1');
  });

  it('FTQ2: no fast-tracked entries → no badge and no note', async () => {
    stubQueue([entry('s2', 'Normal Stores', { fastTrack: null }), entry('s3', 'Legacy Stores')]);
    render(<KycApprovalsPage />);
    await screen.findAllByText('Normal Stores', undefined, LOAD);
    expect(screen.queryByTestId('fast-track-badge')).toBeNull();
    expect(screen.queryByTestId('fast-track-detail-note')).toBeNull();
  });
});
