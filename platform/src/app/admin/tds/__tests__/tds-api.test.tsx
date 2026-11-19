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

// jsdom has no URL.revokeObjectURL. lib/download revokes on a 1 s timer, which can fire after a test's URL stub has
// been restored (afterEach → unstubAllGlobals) while later tests in this file still run → an unhandled TypeError.
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
}

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

/** All money fields are integer paise, matching the backend contract */
const MOCK_194R: { success: true; data: object } = {
  success: true,
  data: {
    section: '194R',
    fyLabel: '2025-26',
    summary: {
      baseFyTotalPaise: 500000,   // ₹5,000.00
      liabilityPaise:   50000,    // ₹500.00
      depositedPaise:   30000,    // ₹300.00
      outstandingPaise: 20000,    // ₹200.00  (positive → red)
    },
    rows: [
      {
        panNumber:        'ABCDE1234F',
        baseFyTotalPaise: 500000,
        liabilityPaise:   50000,
        depositedPaise:   30000,
        outstandingPaise: 20000,
      },
      {
        panNumber:        'XYZPQ9876G',
        baseFyTotalPaise: 100000,
        liabilityPaise:   10000,
        depositedPaise:   15000,
        outstandingPaise: -5000,   // negative → over-deposit / credit
      },
    ],
  },
};

const MOCK_194C: { success: true; data: object } = {
  success: true,
  data: {
    section: '194C',
    fyLabel: '2025-26',
    summary: {
      liabilityPaise:             8000,
      liabilityNoThresholdPaise:  12000,
      depositedPaise:             8000,
      outstandingPaise:           0,
    },
    rows: [
      {
        panNumber:                'GIFSY1234A',
        entityType:               'COMPANY',
        maxSinglePaise:           200000,
        thresholdMet:             true,
        liabilityPaise:           8000,
        liabilityNoThresholdPaise: 12000,
        depositedPaise:           8000,
        outstandingPaise:         0,
      },
    ],
  },
};

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
    expect(screen.getAllByText('Total Amount Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Deposited').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Outstanding').length).toBeGreaterThan(0);
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

    const select = screen.getByRole('combobox');
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
  // Fix round B (D1/D3/M2) — a PAN with a reversed payout carries an amber flag + the API's notes; others unchanged.
  it('TDS14: 194R/194C rows with a `reversal` show the flag + notes and a summary line; rows without it are unchanged', async () => {
    mockUseAdminSession.mockReturnValue({ role: 'GIFSY_ADMIN', name: 'G', userId: '', canManageSchemes: true });
    const flag = {
      reversedPaise: '1000000',
      items: [{ amountPaise: '1000000', reversedAt: '2026-11-16T00:00:00.000Z', period: '2026-10', outletCode: 'O1', retroactive: true }],
      belowThresholdAfterReversal: true,
      notes: [
        '₹10,000.00 reversed on 16 Nov 2026',
        'PAN below threshold after reversal',
        'Changed after reversal on 16 Nov 2026 — revise return if already filed',
        '₹1,000.00 over-deducted — handed back on the next payout on this PAN',
      ],
    };
    const r = MOCK_194R.data as { rows: object[]; summary: object };
    const c = MOCK_194C.data as { rows: object[]; summary: object };
    const r194 = { success: true, data: { ...r, summary: { ...r.summary, reversalFlags: 1 }, rows: [{ ...r.rows[0], reversal: flag }, r.rows[1]] } };
    const r194c = { success: true, data: { ...c, rows: [{ ...c.rows[0], reversal: { ...flag, belowThresholdAfterReversal: false, notes: ['₹10,000.00 reversed on 16 Nov 2026'] } }] } };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/194c') ? r194c : r194) }),
    ));
    render(<AdminTdsPage />);
    const flags = await screen.findAllByTestId('tds-reversal-flag');
    expect(flags).toHaveLength(1); // only the flagged 194R row
    expect(flags[0].textContent).toContain('Reversed ₹10,000.00 · below threshold · changed after reversal');
    expect(flags[0].textContent).toContain('Changed after reversal on 16 Nov 2026 — revise return if already filed');
    expect(flags[0].textContent).toContain('₹1,000.00 over-deducted — handed back on the next payout on this PAN');
    expect(screen.getByTestId('tds-194r-reversal-summary').textContent).toMatch(/1 PAN changed after a payout reversal/);
    // the unflagged row's PAN cell is just the PAN
    expect(screen.getByText('XYZPQ9876G').closest('td')!.textContent).toBe('XYZPQ9876G');

    fireEvent.click(screen.getByText('194C — Contractor (Gifsy)'));
    const cflags = await screen.findAllByTestId('tds-reversal-flag');
    expect(cflags).toHaveLength(1);
    expect(cflags[0].textContent).toContain('Reversed ₹10,000.00 · changed after reversal');
    expect(cflags[0].textContent).not.toContain('below threshold');
    expect(screen.getByTestId('tds-194c-reversal-summary').textContent).toMatch(/1 PAN changed/);
  });

  it('TDS15: no reversal on any row → no flag, no summary line', async () => {
    vi.stubGlobal('fetch', make194RFetch());
    render(<AdminTdsPage />);
    await screen.findByText('194R Liability — 2025-26');
    await screen.findAllByText(/₹500\.00/);
    expect(screen.queryByTestId('tds-reversal-flag')).toBeNull();
    expect(screen.queryByTestId('tds-194r-reversal-summary')).toBeNull();
  });
});
