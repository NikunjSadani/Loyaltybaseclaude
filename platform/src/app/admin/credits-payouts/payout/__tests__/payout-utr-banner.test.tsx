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
// Memory-safety shape: only ERROR rows are echoed (problemRows), capped at 500.
const PREVIEW = {
  headerError: null,
  problemRows: [] as unknown[],
  problemRowCount: 0,
  problemRowsTruncated: false,
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
function mockFetch(
  applyData: { paidCount: number; failedCount: number; skippedCount: number },
  preview: unknown = PREVIEW,
) {
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
      return json({ success: true, data: { parseResult: preview } });
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

    expect(await screen.findByText(/1 failed/)).toBeTruthy();
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

describe('Payout UTR preview — problem rows only (memory-safety)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asGifsyAdmin();
  });

  it('lists the echoed ERROR rows and says when the list was capped', async () => {
    const badRow = {
      rowNum: 3, outletId: 'O-BAD', batchId: 'PD-2026-06-001', utr: '', success: true,
      remarks: '', status: 'ERROR', errors: ['UTR is required'],
    };
    mockFetch({ paidCount: 0, failedCount: 0, skippedCount: 0 }, {
      headerError: null,
      problemRows: [badRow],
      problemRowCount: 720,
      problemRowsTruncated: true,
      hasErrors: true,
      canProceed: false,
      summary: { total: 900, ok: 180, skipped: 0, errors: 720, paidCount: 180, failedCount: 0 },
    });
    const { container } = render(<PayoutDownloadPage />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'd1' } });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });

    fireEvent.click(await screen.findByText(/Show row details \(720\)/));
    expect(await screen.findByText('O-BAD')).toBeTruthy();
    expect(await screen.findByText('UTR is required')).toBeTruthy();
    expect((await screen.findByRole('status')).textContent).toMatch(/first 1 of 720 problem rows/);
    // Errors block the apply.
    expect(screen.queryByText('Apply UTR Results')).toBeNull();
  });
});

describe('Payout UTR preview — full row details before Apply (H3, API returns every row again)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asGifsyAdmin();
  });

  it('lists OK rows (outlet, UTR, payment date) and Skipped rows WITH the reason, before Apply', async () => {
    const rows = [
      { rowNum: 2, outletId: 'O-OK', batchId: 'PD-2026-06-001', utr: 'UTR123', success: true, remarks: '', status: 'OK', errors: [], paymentDate: '2026-06-28T00:00:00.000Z' },
      { rowNum: 3, outletId: 'O-SKIP', batchId: 'PD-2026-06-001', utr: 'UTR999', success: true, remarks: '', status: 'SKIP', errors: [] },
    ];
    mockFetch({ paidCount: 1, failedCount: 0, skippedCount: 1 }, {
      headerError: null,
      rows,
      rowCount: 2,
      rowsTruncated: false,
      problemRows: [],
      problemRowCount: 0,
      problemRowsTruncated: false,
      hasErrors: false,
      canProceed: true,
      summary: { total: 2, ok: 1, skipped: 1, errors: 0, paidCount: 1, failedCount: 0 },
    });
    const { container } = render(<PayoutDownloadPage />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'd1' } });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });

    fireEvent.click(await screen.findByText(/Show row details \(2\)/));
    const ok = await screen.findByTestId('utr-row-2');
    expect(ok.textContent).toMatch(/O-OK/);
    expect(ok.textContent).toMatch(/UTR: UTR123/);
    expect(ok.textContent).toMatch(/Paid: 28\/6\/2026/);
    const skip = await screen.findByTestId('utr-row-3');
    expect(skip.textContent).toMatch(/O-SKIP/);
    expect(skip.textContent).toMatch(/Already paid/);
    expect(skip.textContent).toMatch(/Skipped/);
    // The list is shown BEFORE the Apply button, and Apply is available.
    const apply = await screen.findByText('Apply UTR Results');
    expect((await screen.findByTestId('utr-row-details')).compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "Showing the first N of M rows" when the API capped the full list', async () => {
    mockFetch({ paidCount: 0, failedCount: 0, skippedCount: 0 }, {
      headerError: null,
      rows: [{ rowNum: 2, outletId: 'O1', batchId: 'B', utr: 'U', success: true, remarks: '', status: 'OK', errors: [] }],
      rowCount: 25000,
      rowsTruncated: true,
      problemRows: [],
      problemRowCount: 0,
      problemRowsTruncated: false,
      hasErrors: false,
      canProceed: true,
      summary: { total: 25000, ok: 25000, skipped: 0, errors: 0, paidCount: 25000, failedCount: 0 },
    });
    const { container } = render(<PayoutDownloadPage />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'd1' } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });
    fireEvent.click(await screen.findByText(/Show row details \(25,000\)/));
    expect((await screen.findByTestId('upload-truncation-note')).textContent).toMatch(/Showing the first 1 of 25,000 rows/);
  });
});
