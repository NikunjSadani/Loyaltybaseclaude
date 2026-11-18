/// <reference types="vitest/globals" />
/**
 * TDS — Admin TDS page API wiring (P6.5d)
 *
 * TDS1:  194R table calls /api/admin/tds/194r?fy=...
 * TDS2:  paise ÷ 100 display — liabilityPaise shown as ₹
 * TDS3:  outstanding non-zero highlighted (red for positive)
 * TDS4:  outstanding negative shown as credit (green)
 * TDS5:  194C tab hidden for CLIENT_ADMIN (tab not rendered)
 * TDS6:  194C tab visible for GIFSY_ADMIN
 * TDS7:  summary cards render for 194R
 * TDS8:  off-platform upload preview calls /api/admin/tds/off-platform/upload?apply=false
 * TDS9:  194R export download button targets /api/admin/tds/194r/export?fy=...
 * TDS10: FY selector changes the fetch URL
 * TDS11: 194R fetch shows loading indicator on mount
 * TDS12: 194R fetch error shows error message
 * TDS13: deposit upload calls /api/admin/tds/deposits/upload?section=194R&apply=false on preview
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import AdminTdsPage from '../page';
import CONTRACT from './fixtures/tds-report-contract.json';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

// Admin session: default CLIENT_ADMIN; override per test via localStorage stub
vi.mock('@/lib/admin-session', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/admin-session')>();
  return {
    ...mod,
    useAdminSession: vi.fn(() => ({
      role:             'CLIENT_ADMIN',
      name:             'Test Admin',
      canManageSchemes: false,
    })),
  };
});

import { useAdminSession } from '@/lib/admin-session';
const mockUseAdminSession = vi.mocked(useAdminSession);

// ── Mock data ──────────────────────────────────────────────────────────────────

/**
 * Built from the SHARED response contract (fixtures/tds-report-contract.json) — the same file
 * api/src/tds/tds.controller.contract.spec.ts checks the controller against, so these mocks can't
 * drift from the real API shape again (summary keys are total*; money is paise as strings).
 */
const MOCK_194R: { success: true; data: typeof CONTRACT.r194 } = { success: true, data: CONTRACT.r194 };
const MOCK_194C: { success: true; data: typeof CONTRACT.r194c } = { success: true, data: CONTRACT.r194c };

const MOCK_UPLOAD_PREVIEW: { success: true; data: object } = {
  success: true,
  data: {
    processed: 5,
    succeeded: 4,
    skipped:   1,
    failed:    0,
    errors:    [],
  },
};

// ── Setup ──────────────────────────────────────────────────────────────────────

/** Returns a fetch mock that serves 194R data for the first call, then empty */
function make194RFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(MOCK_194R),
  });
}

/** Returns a fetch mock that serves 194R for first call, 194C for second */
function makeGifsyFetch() {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    call++;
    return Promise.resolve({
      ok:   true,
      json: () =>
        Promise.resolve(call === 1 ? MOCK_194R : MOCK_194C),
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockUseAdminSession.mockReturnValue({
    role:             'CLIENT_ADMIN',
    name:             'Test Admin',
    userId:           '',
    canManageSchemes: false,
  });
});

beforeEach(() => {
  // Stub URL.createObjectURL used by download helpers
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  });
  // NB: do NOT mock document.body.appendChild/removeChild — RTL's render() uses
  // appendChild to attach its container; mocking it leaves document.body empty.
  // The download helper's anchor append/click is harmless under jsdom.
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TDS — Admin TDS page API wiring', () => {

  // TDS1 — 194R endpoint called on mount
  it('TDS1: 194R table calls /api/admin/tds/194r?fy=...', async () => {
    const fetchMock = make194RFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminTdsPage />);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('/api/admin/tds/194r'))).toBe(true);
    });
  });

  // TDS2 — paise ÷ 100 display
  it('TDS2: liabilityPaise=50000 shown as ₹500.00', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    // ₹500.00 should appear (in summary card and/or table cell)
    const els = await screen.findAllByText(/₹500\.00/);
    expect(els.length).toBeGreaterThan(0);
  });

  // TDS3 — outstanding positive → red (has "font-semibold text-red-600")
  it('TDS3: outstanding positive is highlighted (text-red-600)', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    // Wait for table to load
    await screen.findByText('ABCDE1234F');
    // The outstanding ₹200.00 cell in the table row (OutstandingCell component)
    // uses className with text-red-600 for positive values
    const redEls = document.querySelectorAll('.text-red-600');
    // At least one element with text-red-600 should contain ₹200.00
    const hasRedOutstanding = Array.from(redEls).some((el) =>
      (el.textContent ?? '').includes('₹200.00'),
    );
    expect(hasRedOutstanding).toBe(true);
  });

  // TDS4 — outstanding negative shown as credit (green + " cr")
  it('TDS4: outstanding negative shown as credit (emerald, " cr" suffix)', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    // outstandingPaise=-5000 → negated → "₹50.00 cr" with emerald class
    await screen.findByText('XYZPQ9876G');
    const creditEl = await screen.findByText(/₹50\.00 cr/);
    expect(creditEl.className).toMatch(/emerald/);
  });

  // TDS5 — 194C tab hidden for CLIENT_ADMIN
  it('TDS5: 194C tab NOT rendered for CLIENT_ADMIN', async () => {
    mockUseAdminSession.mockReturnValue({
      role:             'CLIENT_ADMIN',
      name:             'Test Admin',
      userId:           '',
      canManageSchemes: false,
    });
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    await screen.findByText(/194R — Perquisites/);
    expect(screen.queryByText(/194C/)).not.toBeInTheDocument();
  });

  // TDS6 — 194C tab visible for GIFSY_ADMIN
  it('TDS6: 194C tab visible for GIFSY_ADMIN', async () => {
    mockUseAdminSession.mockReturnValue({
      role:             'GIFSY_ADMIN',
      name:             'Gifsy Platform Admin',
      userId:           '',
      canManageSchemes: true,
    });
    vi.stubGlobal('fetch', makeGifsyFetch());
    render(<AdminTdsPage />);
    expect(await screen.findByText(/194C — Contractor/)).toBeInTheDocument();
  });

  // TDS7 — summary cards for 194R
  it('TDS7: summary cards render for 194R (4 cards including "TDS Liability")', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    // These labels appear in both a summary card and the table header → allow multiples.
    expect((await screen.findAllByText('TDS Liability')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Total Amount Paid')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Deposited')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Outstanding')).length).toBeGreaterThan(0);
  });

  // TDS8 — off-platform upload preview calls apply=false
  it('TDS8: off-platform upload preview calls /api/admin/tds/off-platform/upload?apply=false', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/admin/tds/194r')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_194R) });
      }
      // upload preview
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_UPLOAD_PREVIEW) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');

    // Find the off-platform upload panel file input
    const fileInputs = document.querySelectorAll('input[type="file"]');
    // First file input belongs to the Off-Platform 194R Upload panel
    const offPlatformInput = fileInputs[0] as HTMLInputElement;
    expect(offPlatformInput).toBeDefined();

    const file = new File(['dummy'], 'test.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(offPlatformInput, { target: { files: [file] } });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('/api/admin/tds/off-platform/upload') && u.includes('apply=false'))).toBe(true);
    });
  });

  it('TDS8b: upload preview renders backend { row, message } errors and the warnings (notes) block', async () => {
    const preview = {
      success: true,
      data: {
        processed: 2, succeeded: 1, skipped: 0, failed: 1,
        errors: [{ row: 2, message: 'Row 2: PAN is required — enter the PAN, or PANNOTAVBL if the deductee has none' }],
        warnings: [{ row: 3, message: 'Row 3: PAN found on file for outlet OUT1 — counted under that PAN' }],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/api/admin/tds/194r') ? MOCK_194R : preview) }),
    ));
    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');
    const input = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 't.xlsx')] } });
    expect(await screen.findByText(/Row 2: PAN is required — enter the PAN, or PANNOTAVBL/)).toBeInTheDocument();
    const notes = await screen.findByTestId('tds-upload-warnings');
    expect(notes.textContent).toMatch(/PAN found on file for outlet OUT1 — counted under that PAN/);
  });

  // TDS9 — 194R export download button
  it('TDS9: "Download 194R Excel" button targets /api/admin/tds/194r/export?fy=...', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/admin/tds/194r/export')) {
        return Promise.resolve({
          ok:   true,
          blob: () => Promise.resolve(new Blob(['xlsx'])),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_194R) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');

    fireEvent.click(screen.getByText(/Download 194R Excel/));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('/api/admin/tds/194r/export'))).toBe(true);
    });
  });

  // TDS10 — FY selector changes fetch URL
  it('TDS10: changing FY selector re-fetches with the new FY in the URL', async () => {
    const fetchMock = make194RFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');

    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: '2024-25' } });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('fy=2024-25'))).toBe(true);
    });
  });

  // TDS11 — loading spinner on mount
  it('TDS11: shows loading indicator on mount (before fetch resolves)', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AdminTdsPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  // TDS12 — error message on 194R fetch failure
  it('TDS12: shows error message when 194R fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   false,
      json: () => Promise.resolve({ success: false, error: 'Unauthorized' }),
    }));
    render(<AdminTdsPage />);
    expect(await screen.findByText(/Unauthorized/)).toBeInTheDocument();
  });

  // TDS13 — deposit upload preview calls correct endpoint with section
  it('TDS13: deposit upload preview calls /api/admin/tds/deposits/upload?section=194R&apply=false', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/admin/tds/deposits/upload')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_UPLOAD_PREVIEW) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_194R) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');

    // The deposit upload panel is the last file input on the 194R tab
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const depositInput = fileInputs[fileInputs.length - 1] as HTMLInputElement;

    const file = new File(['dummy'], 'deposits.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(depositInput, { target: { files: [file] } });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(
        calls.some((u) =>
          u.includes('/api/admin/tds/deposits/upload') &&
          u.includes('section=194R') &&
          u.includes('apply=false'),
        ),
      ).toBe(true);
    });
  });
  // TDS14 — D10 (owner 2026-11-18): the 194R row shows how the year's TDS was worked out.
  it('TDS14: 194R row shows cash/non-cash base, method · rate, deducted/client-borne parts, deducted so far and imported vendor TDS', async () => {
    const row = {
      panNumber: 'ABCDE1234F',
      baseFyTotalPaise: 2300000, liabilityPaise: 238900, depositedPaise: 100000, outstandingPaise: 138900,
      methodology: 'DEDUCT', ratePct: 10,
      cashBasePaise: 1500000, nonCashBasePaise: 800000,
      deductLiabilityPaise: 150000, clientBorneLiabilityPaise: 88900,
      deductedPaise: 150000, importedVendorDepositPaise: 40000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { ...MOCK_194R.data, rows: [row] } }),
    }));
    render(<AdminTdsPage />);
    expect(await screen.findByTestId('r194-method')).toHaveTextContent('Deduct · 10%');
    expect(screen.getByTestId('r194-cash-noncash')).toHaveTextContent('₹15,000.00 / ₹8,000.00');
    expect(screen.getByTestId('r194-parts')).toHaveTextContent('₹1,500.00 / ₹889.00');
    expect(screen.getByTestId('r194-deducted')).toHaveTextContent('₹1,500.00');
    expect(screen.getByTestId('r194-imported')).toHaveTextContent('of which imported vendor TDS ₹400.00');
  });

  it('TDS15: a row without the D10 fields (older API) still renders (Gross-up, ₹0 parts, no imported note)', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    const methods = await screen.findAllByTestId('r194-method');
    expect(methods[0]).toHaveTextContent('Gross-up');
    expect(screen.queryByTestId('r194-imported')).toBeNull();
  });
  // TDS16 — the summary cards read the REAL API names (total*). Before the fix they read
  // summary.baseFyTotalPaise / liabilityPaise and showed ₹0.00 against the real API.
  it('TDS16: 194R summary cards show the API totals (total* keys from the shared contract)', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    expect(await screen.findByTestId('r194-summary-base')).toHaveTextContent('₹6,000.00');
    expect(screen.getByTestId('r194-summary-liability')).toHaveTextContent('₹600.00');
    expect(screen.getByTestId('r194-summary-deposited')).toHaveTextContent('₹450.00');
    expect(screen.getByTestId('r194-summary-outstanding')).toHaveTextContent('₹150.00');
  });

  it('TDS17: 194C summary cards show the API totals (total* keys from the shared contract)', async () => {
    mockUseAdminSession.mockReturnValue({ role: 'GIFSY_ADMIN', name: 'Op', canManageSchemes: false } as ReturnType<typeof useAdminSession>);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/194c') ? MOCK_194C : MOCK_194R) }),
    ));
    render(<AdminTdsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /194C/ }));
    expect(await screen.findByTestId('r194c-summary-liability')).toHaveTextContent('₹80.00');
    expect(screen.getByTestId('r194c-summary-nothreshold')).toHaveTextContent('₹120.00');
    expect(screen.getByTestId('r194c-summary-deposited')).toHaveTextContent('₹70.00');
    expect(screen.getByTestId('r194c-summary-outstanding')).toHaveTextContent('₹10.00');
  });
});
