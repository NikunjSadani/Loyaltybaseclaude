/**
 * G1 — "Not interested" must not be offered for an outlet whose KYC is APPROVED or under review (the server refuses
 * it with a 409), and a server refusal must be SHOWN — never a success toast for a mark that did not happen.
 *
 * The block comes from the server (`notInterestedBlock` on /api/sales/outlets — mirrors KycService.notInterested),
 * so an outlet whose latest re-KYC was rejected but which was approved before is still blocked.
 *
 * Run: npx vitest run src/app/sales/kyc/new/__tests__/not-interested-blocked.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import NewKYCPage from '../page';

// R4: accurate for an outlet approved once whose latest re-KYC was rejected (the case below) — never "already approved".
const APPROVED_REASON = "This outlet was KYC-approved before — it can't be marked Not interested.";
const IN_REVIEW_REASON = "This outlet's KYC is under review — it can't be marked Not interested now.";

const OUTLETS = [
  // Approved before; latest re-KYC REJECTED (deep-link re-entry keeps Step 1) → still blocked.
  { id: 'o-approved', outletCode: 'OC-A', name: 'Approved Store', district: 'B', type: 'SSS', kycStatus: 'REJECTED', notInterestedBlock: 'APPROVED' },
  { id: 'o-review', outletCode: 'OC-R', name: 'Review Store', district: 'B', type: 'SSS', kycStatus: 'PENDING_GIFSY', notInterestedBlock: 'IN_REVIEW' },
  { id: 'o-free', outletCode: 'OC-F', name: 'Free Store', district: 'B', type: 'SSS', kycStatus: 'NOT_STARTED', notInterestedBlock: null },
];

let niResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { success: true } };

beforeEach(() => {
  vi.clearAllMocks();
  niResponse = { ok: true, status: 200, body: { success: true } };
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: OUTLETS } }) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc/not-interested')) {
      return Promise.resolve({ ok: niResponse.ok, status: niResponse.status, json: () => Promise.resolve(niResponse.body) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  });
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

const deepLink = (outletId: string) => window.history.replaceState({}, '', `/sales/kyc/new?outletId=${outletId}`);

describe('G1 — Not interested is disabled, with the reason, for approved / in-review outlets', () => {
  it('approved (even with a later rejected re-KYC) → button disabled + the "already approved" reason', async () => {
    deepLink('o-approved');
    render(<NewKYCPage />);
    expect(await screen.findByTestId('ni-blocked-reason')).toHaveTextContent(APPROVED_REASON);
    expect(screen.getByTestId('ni-blocked-reason')).not.toHaveTextContent(/already approved/i);
    expect(screen.getByTestId('ni-btn')).toBeDisabled();
    expect(screen.getByTestId('ni-btn')).toHaveAttribute('aria-describedby', 'ni-blocked-reason');
  });

  it('KYC in flight → button disabled + the "under review" reason', async () => {
    deepLink('o-review');
    render(<NewKYCPage />);
    expect(await screen.findByTestId('ni-blocked-reason')).toHaveTextContent(IN_REVIEW_REASON);
    expect(screen.getByTestId('ni-btn')).toBeDisabled();
  });

  it('an outlet with no blocking KYC → button enabled, no reason shown', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    await user.click(await screen.findByTestId('outlet-option-o-free'));
    await waitFor(() => expect(screen.getByTestId('ni-btn')).not.toBeDisabled());
    expect(screen.queryByTestId('ni-blocked-reason')).toBeNull();
  });
});

describe('G1 — a server refusal is shown, never a false success', () => {
  it('409 from the server → the server message is shown; no success toast; the outlet stays in the list', async () => {
    niResponse = {
      ok: false,
      status: 409,
      body: { success: false, error: 'This outlet is parked by the admin.' },
    };
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    await user.click(await screen.findByTestId('outlet-option-o-free'));
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(await screen.findByRole('button', { name: /^yes, not interested$/i }));

    expect(await screen.findByTestId('not-interested-error')).toHaveTextContent('This outlet is parked by the admin.');
    expect(screen.queryByTestId('not-interested-toast')).toBeNull();
    // Still selectable — it was NOT dismissed locally.
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    expect(await screen.findByTestId('outlet-option-o-free')).toBeInTheDocument();
  });

  it('success → toast shown, outlet dropped, no error', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    await user.click(await screen.findByTestId('outlet-option-o-free'));
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(await screen.findByRole('button', { name: /^yes, not interested$/i }));

    expect(await screen.findByTestId('not-interested-toast')).toBeInTheDocument();
    expect(screen.queryByTestId('not-interested-error')).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/kyc/not-interested',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ outletId: 'o-free' }) }),
    );
  });

  it('network failure → an honest error, no toast', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: OUTLETS } }) });
      }
      if (typeof url === 'string' && url.includes('/api/kyc/not-interested')) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    await user.click(await screen.findByTestId('outlet-option-o-free'));
    await user.click(screen.getByTestId('ni-btn'));
    await user.click(await screen.findByRole('button', { name: /^yes, not interested$/i }));

    expect(await screen.findByTestId('not-interested-error')).toHaveTextContent(/NOT marked Not interested/);
    expect(screen.queryByTestId('not-interested-toast')).toBeNull();
  });
});
