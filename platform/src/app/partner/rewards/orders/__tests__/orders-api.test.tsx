/// <reference types="vitest/globals" />
/**
 * OR — Partner Rewards Orders page API wiring (live data)
 *
 * OR1: shows loading spinner on mount
 * OR2: renders reward name from API response
 * OR3: renders order count in header
 * OR4: shows error message when fetch fails
 * OR5: confirmed GIFT_CARD order renders its voucher code
 * OR6: copy button writes the voucher code to the clipboard
 * OR7: PHYSICAL_GIFT order renders a tracking link
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

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

const VOUCHER_ORDER = {
  id: 'o1',
  orderNumber: 'RDM-1',
  reward: { id: 'r1', name: 'Amazon Gift Voucher ₹200', imageUrls: [] },
  partner: { id: 'p1', businessName: 'Test Store' },
  status: 'CONFIRMED',
  redemptionMode: 'GIFT_CARD',
  totalPointsCost: 200,
  voucherCode: 'AMZ-GIFT-7788-CODE',
  voucherProvider: 'Gifsy',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-05T00:00:00.000Z',
};

const PHYSICAL_ORDER = {
  id: 'o2',
  orderNumber: 'RDM-2',
  reward: { id: 'r2', name: 'Bluetooth Speaker (JBL)', imageUrls: [] },
  partner: { id: 'p1', businessName: 'Test Store' },
  status: 'DISPATCHED',
  redemptionMode: 'PHYSICAL_GIFT',
  totalPointsCost: 2500,
  trackingNumber: 'DEOLEO-5512',
  trackingUrl: 'https://track.example.com/DEOLEO-5512',
  createdAt: '2026-05-10T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
  dispatchedAt: '2026-05-13T00:00:00.000Z',
};

const MOCK_ORDERS = [VOUCHER_ORDER, PHYSICAL_ORDER];

function stubOrders(orders: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: { orders, pagination: { page: 1, limit: 20, total: orders.length, pages: 1 } },
      }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OR — Orders API wiring (live data)', () => {
  it('OR1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<OrdersPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('OR2: renders reward name from API response', async () => {
    stubOrders(MOCK_ORDERS);
    render(<OrdersPage />);
    expect(await screen.findByText('Amazon Gift Voucher ₹200')).toBeInTheDocument();
  });

  it('OR3: renders order count in header', async () => {
    stubOrders(MOCK_ORDERS);
    render(<OrdersPage />);
    expect(await screen.findByText('2 orders')).toBeInTheDocument();
  });

  it('OR4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<OrdersPage />);
    expect(await screen.findByText(/failed to load orders/i)).toBeInTheDocument();
  });

  it('OR5: confirmed GIFT_CARD order renders its voucher code', async () => {
    stubOrders([VOUCHER_ORDER]);
    render(<OrdersPage />);
    const code = await screen.findByTestId('voucher-code');
    expect(code).toHaveTextContent('AMZ-GIFT-7788-CODE');
  });

  it('OR6: copy button writes the voucher code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    stubOrders([VOUCHER_ORDER]);
    render(<OrdersPage />);
    const btn = await screen.findByTestId('copy-voucher-btn');
    await userEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('AMZ-GIFT-7788-CODE'));
    // A polite live region announces it.
    expect(screen.getByTestId('copy-voucher-btn-status')).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(screen.getByTestId('copy-voucher-btn-status')).toHaveTextContent('Copied'));
  });

  it('OR6e: a clipboard failure says "Copy failed — long-press to copy" (visible + announced); the value is selectable', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubOrders([VOUCHER_ORDER]);
    render(<OrdersPage />);
    await userEvent.click(await screen.findByTestId('copy-voucher-btn'));
    const status = screen.getByTestId('copy-voucher-btn-status');
    await waitFor(() => expect(status).toHaveTextContent('Copy failed — long-press to copy'));
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).not.toHaveClass('sr-only'); // visible, not only announced
    expect(screen.getByTestId('voucher-code')).toHaveClass('select-all');
  });

  it('OR6f: the "Copy failed" hint clears after ~4 s, and a new tap starts fresh', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('NotAllowedError')).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubOrders([VOUCHER_ORDER]);
    render(<OrdersPage />);
    const btn = await screen.findByTestId('copy-voucher-btn');
    const status = screen.getByTestId('copy-voucher-btn-status');
    await userEvent.click(btn);
    await waitFor(() => expect(status).toHaveTextContent('Copy failed'));
    // next tap: the failure is replaced (here by a successful copy)
    await userEvent.click(btn);
    await waitFor(() => expect(status).toHaveTextContent('Copied'));
    expect(status).not.toHaveTextContent('Copy failed');
    // and on its own after ~4 s
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await userEvent.click(btn);
      await waitFor(() => expect(status).toHaveTextContent('Copy failed'));
      await act(async () => { vi.advanceTimersByTime(4100); });
      expect(status).toHaveTextContent('');
      expect(status).not.toHaveTextContent('Copy failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('item 11: a REPEATED failure is re-announced (the region empties, then says it again); an old timer never cuts the new hint short', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubOrders([VOUCHER_ORDER]);
    render(<OrdersPage />);
    const btn = await screen.findByTestId('copy-voucher-btn');
    const status = screen.getByTestId('copy-voucher-btn-status');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await userEvent.click(btn);
      await waitFor(() => expect(status).toHaveTextContent('Copy failed'));
      await act(async () => { vi.advanceTimersByTime(3000); }); // 1 s left on the first hint
      const seen: string[] = [];
      const obs = new MutationObserver(() => seen.push(status.textContent ?? ''));
      obs.observe(status, { childList: true, characterData: true, subtree: true });
      await userEvent.click(btn);
      await waitFor(() => expect(status).toHaveTextContent('Copy failed'));
      obs.disconnect();
      // The region went EMPTY and then carried the hint again → a screen reader announces it again.
      expect(seen).toContain('');
      expect(seen[seen.length - 1]).toContain('Copy failed');
      // The FIRST tap's 4 s timer was cleared: 1.5 s later the new hint is still there.
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(status).toHaveTextContent('Copy failed');
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(status).not.toHaveTextContent('Copy failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('OR6b: voucher line shows the reward BRAND, never the back-end aggregator (e.g. Hubble)', async () => {
    stubOrders([{ ...VOUCHER_ORDER, reward: { id: 'r1', name: 'Amazon Voucher', imageUrls: [] }, voucherProvider: 'Hubble' }]);
    render(<OrdersPage />);
    // "Amazon Voucher" → brand "Amazon"; the aggregator name must not leak to the partner.
    expect(await screen.findByText(/Voucher Code\s*·\s*Amazon/)).toBeInTheDocument();
    expect(screen.queryByText(/Hubble/i)).toBeNull();
  });

  it('OR6c: a card number + PIN gift card shows "Card no." and "PIN", each with its own copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubOrders([{ ...VOUCHER_ORDER, voucherCode: '6001220012345678', voucherPin: '482913', voucherProvider: 'Hubble' }]);
    render(<OrdersPage />);
    expect(await screen.findByTestId('voucher-code')).toHaveTextContent('6001220012345678');
    expect(screen.getByTestId('voucher-pin')).toHaveTextContent('482913');
    expect(screen.getByText('Card no.')).toBeInTheDocument();
    expect(screen.getByText('PIN')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('copy-voucher-pin-btn'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('482913'));
    await userEvent.click(screen.getByTestId('copy-voucher-btn'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('6001220012345678'));
  });

  it('OR6d: a number-only voucher (no PIN) renders exactly as before — no PIN row', async () => {
    stubOrders([{ ...VOUCHER_ORDER, voucherPin: null }]);
    render(<OrdersPage />);
    expect(await screen.findByText(/Voucher Code/)).toBeInTheDocument();
    expect(screen.queryByTestId('voucher-pin')).toBeNull();
    expect(screen.queryByText('Card no.')).toBeNull();
  });

  it('OR7: PHYSICAL_GIFT order renders a tracking link to the tracking URL', async () => {
    stubOrders([PHYSICAL_ORDER]);
    render(<OrdersPage />);
    const link = await screen.findByTestId('tracking-link');
    expect(link).toHaveAttribute('href', 'https://track.example.com/DEOLEO-5512');
  });

  // OR8/OR9: the paid voucher code must survive the whole post-issuance lifecycle — ops
  // can move a DIGITAL_VOUCHER order past CONFIRMED, and the member still needs the code.
  it('OR8: a voucher code stays visible once the order advances past CONFIRMED (DISPATCHED/DELIVERED)', async () => {
    for (const status of ['PROCESSING', 'DISPATCHED', 'DELIVERED']) {
      stubOrders([{ ...VOUCHER_ORDER, id: `v-${status}`, status }]);
      const { unmount } = render(<OrdersPage />);
      const code = await screen.findByTestId('voucher-code');
      expect(code).toHaveTextContent('AMZ-GIFT-7788-CODE');
      unmount();
    }
  });

  it('OR9: a voucher code is hidden for dead / pre-issuance states (RETURNED, CANCELLED, PENDING)', async () => {
    for (const status of ['PENDING', 'CANCELLED', 'RETURNED', 'REVERSED', 'FAILED']) {
      stubOrders([{ ...VOUCHER_ORDER, id: `v-${status}`, status }]);
      const { unmount } = render(<OrdersPage />);
      await screen.findByText('Amazon Gift Voucher ₹200'); // list rendered
      expect(screen.queryByTestId('voucher-code')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('OR10: an error offers a Retry that reloads the orders', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { orders: [VOUCHER_ORDER] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<OrdersPage />);
    const retry = await screen.findByTestId('orders-retry');
    await userEvent.click(retry);

    expect(await screen.findByText('Amazon Gift Voucher ₹200')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
