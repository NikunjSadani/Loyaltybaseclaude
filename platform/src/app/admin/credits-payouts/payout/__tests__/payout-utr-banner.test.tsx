/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — UTR-apply RESULT BANNER.
 *
 * Money path. Regression guard for the "silent success" bug: when a UTR upload
 * applies with one or more FAILED rows, the result banner must NOT look like a
 * green success — it renders amber ("Applied with issues"). Green is reserved
 * for an all-paid apply (0 failed).
 *
 * Covered:
 *  - apply result with failedCount > 0  → amber "Applied with issues" (no emerald)
 *  - apply result with 0 failed         → emerald "UTR results applied"
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// A preview parse result the UI accepts (canProceed → Apply button shows).
const PREVIEW = {
  headerError: null,
  rows: [],
  hasErrors: false,
  canProceed: true,
  summary: { total: 1, ok: 1, skipped: 0, errors: 0, paidCount: 0, failedCount: 1 },
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

/** Install a fetch router. `applyData` is the body of the apply=true response. */
function mockFetch(applyData: { paidCount: number; failedCount: number; skippedCount: number }) {
  const json = (payload: unknown) =>
    Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });

  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/reversals')) {
      return json({ success: true, data: { reversals: [], pagination: null } });
    }
    if (url.includes('/fields')) {
      return json({ success: true, data: [] });
    }
    if (url.includes('/utr?apply=true')) {
      return json({ success: true, data: applyData });
    }
    if (url.includes('/utr')) {
      return json({ success: true, data: { parseResult: PREVIEW } });
    }
    if (url.includes('/payout-downloads')) {
      return json({ success: true, data: [DOWNLOAD] });
    }
    return json({ success: true, data: [] });
  }) as unknown as typeof fetch;
}

async function driveToApply(container: HTMLElement) {
  // 1) pick the download batch (the only <select> on the page by default)
  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: 'd1' } });

  // 2) upload a file → triggers the preview fetch
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1])], 'utr.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(fileInput, { target: { files: [file] } });

  // 3) Apply once the preview resolves
  const applyBtn = await screen.findByText('Apply UTR Results');
  fireEvent.click(applyBtn);
}

describe('Payout UTR-apply result banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asGifsyAdmin();
  });

  it('shows an AMBER "Applied with issues" banner (never emerald) when a row failed', async () => {
    mockFetch({ paidCount: 0, failedCount: 1, skippedCount: 0 });
    const { container } = render(<PayoutDownloadPage />);
    await driveToApply(container);

    const heading = await screen.findByText('Applied with issues');
    expect(screen.queryByText('UTR results applied')).toBeNull();

    const bannerDiv = heading.closest('div.rounded-xl') as HTMLElement;
    expect(bannerDiv).toBeTruthy();
    expect(bannerDiv.className).toMatch(/amber/);
    expect(bannerDiv.className).not.toMatch(/emerald/);

    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it('shows the GREEN "UTR results applied" banner only when nothing failed', async () => {
    mockFetch({ paidCount: 1, failedCount: 0, skippedCount: 0 });
    const { container } = render(<PayoutDownloadPage />);
    await driveToApply(container);

    const heading = await screen.findByText('UTR results applied');
    expect(screen.queryByText('Applied with issues')).toBeNull();

    const bannerDiv = heading.closest('div.rounded-xl') as HTMLElement;
    expect(bannerDiv.className).toMatch(/emerald/);
    expect(bannerDiv.className).not.toMatch(/amber/);
  });
});
