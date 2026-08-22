/// <reference types="vitest/globals" />
/**
 * Gift order detail — fulfilment update + transition guard.
 *
 * OD1: renders the order with ops-only "fulfilled by" (internal) fields
 * OD2: fulfilment form PATCHes only the filled fields with the chosen channel
 * OD3: a DELIVERED order offers ONLY the Gifsy-only RETURNED reversal edge
 * OD4: the RETURNED transition confirms with a value-reversal warning before POSTing
 * OD5: a terminal (CANCELLED) order offers no transitions
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'o1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    patch: (url: string, body: unknown) => patch(url, body),
    post: (url: string, body: unknown) => post(url, body),
  },
  authHeader: () => ({}),
}));

import GiftOrderDetailPage from '../[id]/page';

function orderWith(overrides: Record<string, unknown>) {
  return {
    id: 'o1',
    orderNumber: 'DEO-26-000123',
    clientId: 'deoleo',
    tenantName: 'Deoleo',
    status: 'PROCESSING',
    rewardName: 'Bluetooth Speaker',
    partnerName: 'Sharma Store',
    valuePaise: 250000,
    totalPointsCost: 2500,
    fulfilledByVendorName: 'Acme Gifts',
    createdAt: '2026-05-10T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Gift order detail', () => {
  it('OD1: renders the order with the internal "fulfilled by"', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({}) });
    render(<GiftOrderDetailPage />);
    expect(await screen.findByText('DEO-26-000123')).toBeInTheDocument();
    expect(screen.getByText('Acme Gifts')).toBeInTheDocument();
    expect(screen.getByText('(internal)')).toBeInTheDocument();
  });

  it('OD2: PATCHes the fulfilment with the chosen channel + tracking', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({}) });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    fireEvent.change(screen.getByTestId('ff-channel'), { target: { value: 'GIFSY_WAREHOUSE' } });
    fireEvent.change(screen.getByTestId('ff-logistics'), { target: { value: 'Delhivery' } });
    fireEvent.change(screen.getByTestId('ff-tracking-number'), { target: { value: 'TRK-77' } });
    fireEvent.click(screen.getByTestId('ff-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe('/api/admin/gift-orders/o1/fulfilment');
    // Full editable set is sent; unfilled fields ride as null so the backend can clear them.
    expect(body).toEqual({
      fulfilmentChannel: 'GIFSY_WAREHOUSE',
      logisticsPartner: 'Delhivery',
      trackingNumber: 'TRK-77',
      trackingUrl: null,
      supplierOrderRef: null,
      voucherCode: null,
      voucherProvider: null,
    });
  });

  it('OD6: blanking a pre-filled tracking number sends null so the stale value is cleared', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'GIFSY_WAREHOUSE', trackingNumber: 'OLD-TRK' }),
    });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    // The field pre-fills with the stored value; the operator clears it.
    expect((screen.getByTestId('ff-tracking-number') as HTMLInputElement).value).toBe('OLD-TRK');
    fireEvent.change(screen.getByTestId('ff-tracking-number'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ff-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, body] = patch.mock.calls[0];
    expect(body.trackingNumber).toBeNull();
  });

  it('OD7: toggling channel to DIGITAL_VOUCHER resets the stale tracking number', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'GIFSY_WAREHOUSE', trackingNumber: 'OLD-TRK' }),
    });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    fireEvent.change(screen.getByTestId('ff-channel'), { target: { value: 'DIGITAL_VOUCHER' } });
    // Now the voucher fields show; enter a code.
    fireEvent.change(await screen.findByTestId('ff-voucher-code'), { target: { value: 'VC-1' } });
    fireEvent.click(screen.getByTestId('ff-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, body] = patch.mock.calls[0];
    expect(body.fulfilmentChannel).toBe('DIGITAL_VOUCHER');
    expect(body.voucherCode).toBe('VC-1');
    expect(body.trackingNumber).toBeNull(); // stale tracking dropped on the toggle
  });

  it('OD8: a double-clicked transition confirm fires the POST only once', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'DELIVERED' }) });
    // Never resolves — keeps the first call in-flight so the sync guard is exercised.
    post.mockReturnValue(new Promise(() => {}));
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    fireEvent.click(screen.getByTestId('transition-RETURNED'));
    const confirm = await screen.findByTestId('transition-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it('OD3: a DELIVERED order offers only the RETURNED reversal', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'DELIVERED' }) });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByTestId('transition-RETURNED')).toBeInTheDocument();
    expect(screen.queryByTestId('transition-DELIVERED')).not.toBeInTheDocument();
  });

  it('OD4: the RETURNED transition confirms with a value-reversal warning then POSTs', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'DELIVERED' }) });
    post.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    // Opening the transition shows the confirm gate — POST not yet fired.
    fireEvent.click(screen.getByTestId('transition-RETURNED'));
    expect(await screen.findByText(/194R/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('transition-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/admin/gift-orders/o1/transition');
    expect(body).toMatchObject({ toStatus: 'RETURNED' });
  });

  it('OD5: a terminal order offers no transitions', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'CANCELLED' }) });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByText(/no further transitions/i)).toBeInTheDocument();
  });
});
