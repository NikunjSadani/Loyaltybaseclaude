/**
 * TDD tests — "Not Interested" flow (redesigned)
 *
 * The NI action has moved from per-outlet button inside the dropdown
 * to a single page-level button below the Continue button.
 *
 * NI1 : Outlet dropdown rows do NOT contain any "Not Interested" button
 * NI2 : A "Not Interested" button exists below the Continue button
 * NI3 : NI button is disabled when no outlet is selected
 * NI4 : NI button becomes enabled after selecting an outlet
 * NI5 : NI button is NOT visible when a Re-KYC outlet is selected
 * NI6 : Clicking NI opens a confirmation modal
 * NI7 : Modal shows the selected outlet name
 * NI8 : Modal text mentions removal from pending KYC list
 * NI9 : Clicking Cancel closes the modal; outlet stays in the list
 * NI10: Confirming calls POST /api/kyc/not-interested with the outletId
 * NI11: After confirm, the outlet is removed from the dropdown options
 * NI12: After confirm, a success toast is shown
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import NewKYCPage from '../page';

/* ─── Helpers ─────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
});

/** Select a non-Re-KYC outlet (Verma Traders / OUT-2026-001) */
async function selectOutlet(user: ReturnType<typeof userEvent.setup>, outletId = 'OUT-2026-001') {
  render(<NewKYCPage />);
  const trigger = screen.getByTestId('outlet-dropdown-trigger');
  await user.click(trigger);
  // Click the outlet row button (the select-area button inside the dropdown)
  const outletBtn = screen.getByTestId(`outlet-option-${outletId}`);
  await user.click(outletBtn);
}

/** Select a Re-KYC outlet (OUT-2026-K11) */
async function selectReKycOutlet(user: ReturnType<typeof userEvent.setup>) {
  render(<NewKYCPage />);
  const trigger = screen.getByTestId('outlet-dropdown-trigger');
  await user.click(trigger);
  const outletBtn = screen.getByTestId('outlet-option-OUT-2026-K11');
  await user.click(outletBtn);
}

/* ─── NI1: No NI button inside dropdown rows ─────────────────────────────────── */

describe('NI1 — dropdown rows have no Not Interested button', () => {
  it('opening the dropdown shows no per-outlet "Not Interested" button in the rows', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));

    // No per-outlet NI buttons (old pattern: data-testid="not-interested-<outletId>")
    expect(screen.queryByTestId('not-interested-OUT-2026-001')).not.toBeInTheDocument();
    expect(screen.queryByTestId('not-interested-OUT-2026-002')).not.toBeInTheDocument();
    expect(screen.queryByTestId('not-interested-OUT-2026-003')).not.toBeInTheDocument();
  });
});

/* ─── NI2–NI4: NI button location and state ──────────────────────────────────── */

describe('NI2–NI4 — NI button location and enabled state', () => {
  it('NI2: a "Not Interested" button exists on the outlet selection step', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    expect(screen.getByTestId('ni-btn')).toBeInTheDocument();
  });

  it('NI3: NI button is disabled when no outlet is selected', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    expect(screen.getByTestId('ni-btn')).toBeDisabled();
  });

  it('NI4: NI button becomes enabled after selecting a non-Re-KYC outlet', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    expect(screen.getByTestId('ni-btn')).not.toBeDisabled();
  });
});

/* ─── NI5: Re-KYC outlets — NI button hidden ─────────────────────────────────── */

describe('NI5 — Re-KYC outlet hides NI button', () => {
  it('NI5: NI button is not visible when a Re-KYC outlet is selected', async () => {
    const user = userEvent.setup();
    await selectReKycOutlet(user);
    expect(screen.queryByTestId('ni-btn')).not.toBeInTheDocument();
  });
});

/* ─── NI6–NI8: Confirmation modal content ────────────────────────────────────── */

describe('NI6–NI8 — confirmation modal', () => {
  it('NI6: clicking NI button opens a confirmation modal', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    expect(screen.getByTestId('not-interested-confirm-dialog')).toBeInTheDocument();
  });

  it('NI7: modal shows the selected outlet name', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    const dialog = screen.getByTestId('not-interested-confirm-dialog');
    expect(within(dialog).getByText(/Verma Traders/i)).toBeInTheDocument();
  });

  it('NI8: modal mentions removal from pending KYC list', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    const dialog = screen.getByTestId('not-interested-confirm-dialog');
    expect(within(dialog).getByText(/pending KYC/i)).toBeInTheDocument();
  });
});

/* ─── NI9: Cancel keeps outlet ───────────────────────────────────────────────── */

describe('NI9 — cancel keeps outlet', () => {
  it('NI9: clicking Cancel closes the modal and keeps the outlet selectable', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    expect(screen.getByTestId('not-interested-confirm-dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByTestId('not-interested-confirm-dialog')).not.toBeInTheDocument();

    // Outlet option still appears in the dropdown
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    expect(screen.getByTestId('outlet-option-OUT-2026-001')).toBeInTheDocument();
  });
});

/* ─── NI10: API call on confirm ──────────────────────────────────────────────── */

describe('NI10 — API call on confirm', () => {
  it('NI10: confirming calls POST /api/kyc/not-interested with the outletId', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(screen.getByRole('button', { name: /^yes, not interested$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/kyc/not-interested',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ outletId: 'OUT-2026-001' }),
        }),
      );
    });
  });
});

/* ─── NI11: Outlet removed after confirm ─────────────────────────────────────── */

describe('NI11 — outlet removed from dropdown', () => {
  it('NI11: after confirm, the outlet no longer appears in the dropdown', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(screen.getByRole('button', { name: /^yes, not interested$/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('not-interested-confirm-dialog')).not.toBeInTheDocument();
    });

    // Reopen dropdown — Verma Traders should be gone
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    expect(screen.queryByTestId('outlet-option-OUT-2026-001')).not.toBeInTheDocument();
  });
});

/* ─── NI12: Toast after confirm ──────────────────────────────────────────────── */

describe('NI12 — success feedback', () => {
  it('NI12: a success toast appears after confirming Not Interested', async () => {
    const user = userEvent.setup();
    await selectOutlet(user);
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(screen.getByRole('button', { name: /^yes, not interested$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('not-interested-toast')).toBeInTheDocument();
    });
  });
});
