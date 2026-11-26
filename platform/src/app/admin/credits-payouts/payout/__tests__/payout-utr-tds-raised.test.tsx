/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — UTR apply: "194C TDS raised on payment" note.
 * The apply response carries `tdsRaisedOnPaid: { invoices, recoveryRows }` only when > 0; it is shown in the apply
 * result area. Absent → nothing is shown.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/payout',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import PayoutDownloadPage from '../page';

const DOWNLOAD = {
  id: 'd1',
  downloadCode: 'PD-2026-06-001',
  period: '2026-06',
  groupType: 'STANDARD',
  status: 'PARTIALLY_PAID',
  downloadedAt: '2026-06-26T00:00:00.000Z',
  totalAmountPaise: 1000000,
  _count: { entries: 1 },
};

const PREVIEW = {
  headerError: null,
  problemRows: [] as unknown[],
  problemRowCount: 0,
  problemRowsTruncated: false,
  hasErrors: false,
  canProceed: true,
  summary: { total: 1, ok: 1, skipped: 0, errors: 0, paidCount: 1, failedCount: 0 },
};

function asGifsyAdmin() {
  vi.mocked(useAdminSession).mockReturnValue({
    role: 'GIFSY_ADMIN',
    clientId: 'gifsy',
    name: 'Test Admin',
    userId: '',
    canManageSchemes: true,
  } as ReturnType<typeof useAdminSession>);
}

function mockFetch(applyData: Record<string, unknown>) {
  const json = (payload: unknown) =>
    Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
    if (url.includes('/fields')) return json({ success: true, data: [] });
    if (url.includes('/utr?apply=true')) return json({ success: true, data: applyData });
    if (url.includes('/utr')) return json({ success: true, data: { parseResult: PREVIEW } });
    if (url.includes('/payout-downloads')) return json({ success: true, data: [DOWNLOAD] });
    return json({ success: true, data: [] });
  }) as unknown as typeof fetch;
}

async function driveToApply(container: HTMLElement) {
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'd1' } });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });
  fireEvent.click(await screen.findByText('Apply UTR Results'));
}

describe('Payout UTR apply — 194C TDS raised on payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asGifsyAdmin();
  });

  it('shows the TDS invoices + recovery rows raised on payment', async () => {
    mockFetch({ paidCount: 3, failedCount: 0, skippedCount: 0, tdsRaisedOnPaid: { invoices: 2, recoveryRows: 1 } });
    const { container } = render(<PayoutDownloadPage />);
    await driveToApply(container);
    const note = await screen.findByTestId('utr-tds-raised-on-paid');
    expect(note.textContent).toBe('194C TDS raised on payment: 2 TDS invoices, 1 recovery row');
  });

  it('shows nothing when the apply response has no tdsRaisedOnPaid', async () => {
    mockFetch({ paidCount: 1, failedCount: 0, skippedCount: 0 });
    const { container } = render(<PayoutDownloadPage />);
    await driveToApply(container);
    await screen.findByText('UTR results applied');
    expect(screen.queryByTestId('utr-tds-raised-on-paid')).toBeNull();
  });
});
