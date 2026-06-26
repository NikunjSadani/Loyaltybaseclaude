/**
 * Regression (KYC dead-link guard): an outlet card must NEVER link to a bare
 * `/sales/kyc/` (empty kycId) → "KYC not found". When the outlet has no submission
 * yet (NOT_STARTED / master-uploaded, kycId === ''), the card links to the START
 * wizard pre-selected on that outlet: `/sales/kyc/new?outletId=<id>`. When a real
 * kycId is present, it deep-links to the detail `/sales/kyc/<kycId>`.
 *
 * Run: npx vitest run src/app/sales/outlets/__tests__/kyc-link-guard.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'SO' }));
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => ({ paceAmberThreshold: 10 }) }));
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: [] as string[],
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

// One outlet WITH a submission (kycId set), one WITHOUT (kycId empty → start wizard).
const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o-approved', kycId: 'kyc-123', outletCode: 'OUT-001', name: 'Verma Traders',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS', kycStatus: 'APPROVED',
      },
      {
        id: 'o-fresh', kycId: '', outletCode: 'OUT-002', name: 'Patel Kirana',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS', kycStatus: 'NOT_STARTED',
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
  // Force the CARDS view (each card is a real <a href>): the page picks 'cards'
  // when innerWidth < 768. Default jsdom width (1024) would render the table.
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    // outlet-targets → at least one KPI column so the page renders the roster (an
    // empty kpiColumns short-circuits to a "No targets set" empty state, hiding cards).
    return Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        data: {
          kpiColumns: [{ code: 'PRIMARY', name: 'Primary', unit: 'cs', isPrimary: true }],
          rows: [],
        },
      }),
    });
  });
});

describe('Sales outlets — KYC link guard (no dead /sales/kyc/)', () => {
  it('links a card WITH a kycId to the detail page', async () => {
    render(<OutletsPage />);
    const card = (await screen.findByText('Verma Traders')).closest('a');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('href', '/sales/kyc/kyc-123');
  });

  it('links a card WITHOUT a kycId to the START wizard (outletId param), never a bare /sales/kyc/', async () => {
    render(<OutletsPage />);
    const card = (await screen.findByText('Patel Kirana')).closest('a');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('href', '/sales/kyc/new?outletId=o-fresh');
    // Belt-and-braces: the dead route must not appear anywhere.
    await waitFor(() => {
      const deadLink = document.querySelector('a[href="/sales/kyc/"]');
      expect(deadLink).toBeNull();
    });
  });
});
