/**
 * Regression (KYC "Rejected / Re-upload" consolidation):
 *   1. A submission whose status is RE_UPLOAD_REQUIRED (the value the BACKEND actually
 *      writes when a Gifsy reviewer requests a document re-upload) must render in the
 *      rep's KYC list WITHOUT crashing — previously the FE enum lacked the value so the
 *      badge lookup `kycBadge[entry.status]` was undefined and the row blew up.
 *   2. The single "Rejected" filter must cover BOTH plain REJECTED and RE_UPLOAD_REQUIRED
 *      (the separate "Re-upload" tab was removed), and a deep-link `?status=REJECTED`
 *      (or `?status=RE_UPLOAD_REQUIRED`) must resolve to that consolidated view.
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/reupload-consolidation.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let searchStr = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(searchStr) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import KYCListPage from '../page';

function sub(id: string, status: string, outletCode: string, name: string) {
  return {
    id, status, createdAt: '2026-06-24T10:00:00.000Z', updatedAt: '2026-06-24T10:00:00.000Z',
    userId: 'u1', user: { id: 'u1', name: 'Rep Anil', phone: '9000000003' },
    partner: {
      id: `p-${id}`, businessName: name, ownerName: 'Owner', phone: '7766554433',
      outlets: [{ name, outletCode, phone: '7766554433' }],
    },
  };
}

// One re-upload outlet + one hard-rejected outlet — distinct outlet codes so dedupe keeps both.
const SUBMISSIONS = {
  success: true,
  data: { submissions: [
    sub('s-reup', 'RE_UPLOAD_REQUIRED', 'OUT-REUP-001', 'Reupload Mart'),
    sub('s-rej',  'REJECTED',           'OUT-REJ-001',  'Rejected Mart'),
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/sales/team')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { members: [] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve(SUBMISSIONS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — Rejected / Re-upload consolidation', () => {
  it('renders a RE_UPLOAD_REQUIRED row without crashing, badged simply as "Rejected"', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Reupload Mart')).toBeInTheDocument());
    // Owner decision: keep it simple for the rep — a re-upload row badges as "Rejected"
    // (not "Re-upload"). Proves the enum/badge-map fix (previously undefined → crash) AND
    // the simplified label. Filter out any <option> so we assert on the row badges.
    const rejectedBadges = screen.queryAllByText('Rejected').filter((n) => n.tagName !== 'OPTION');
    expect(rejectedBadges.length).toBeGreaterThan(0);
    // And no rep-facing "Re-upload" wording survives anywhere on the list.
    expect(screen.queryByText(/Re-upload/i)).toBeNull();
  });

  it('the "Re-upload" filter tab was removed (no standalone Re-upload option)', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Reupload Mart')).toBeInTheDocument());
    // The old separate filter <option> labelled "Re-upload" must be gone; only "Rejected".
    const reuploadOptions = screen.queryAllByText('Re-upload').filter((n) => n.tagName === 'OPTION');
    expect(reuploadOptions).toHaveLength(0);
  });

  it('deep-link ?status=REJECTED shows BOTH the rejected and the re-upload outlet', async () => {
    searchStr = 'status=REJECTED';
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Rejected Mart')).toBeInTheDocument());
    // Consolidation: the re-upload outlet must ALSO appear under the Rejected filter.
    expect(screen.getByText('Reupload Mart')).toBeInTheDocument();
  });

  it('deep-link ?status=RE_UPLOAD_REQUIRED normalizes into the consolidated Rejected view', async () => {
    searchStr = 'status=RE_UPLOAD_REQUIRED';
    render(<KYCListPage />);
    // Must resolve to a selectable view (the Rejected tab) that shows both outlets,
    // NOT a dead filter key that hides the rejected sibling.
    await waitFor(() => expect(screen.getByText('Reupload Mart')).toBeInTheDocument());
    expect(screen.getByText('Rejected Mart')).toBeInTheDocument();
  });
});
