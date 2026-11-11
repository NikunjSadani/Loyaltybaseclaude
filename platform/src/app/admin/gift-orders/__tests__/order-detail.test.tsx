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
    // Full SHIPPING set is sent (unfilled → null so the backend can clear them); blank voucher
    // fields are OMITTED — a null voucherCode / voucherProvider is a backend 400.
    expect(body).toEqual({
      fulfilmentChannel: 'GIFSY_WAREHOUSE',
      logisticsPartner: 'Delhivery',
      trackingNumber: 'TRK-77',
      trackingUrl: null,
      supplierOrderRef: null,
    });
  });

  it('OD2b: a stored code is read-only; with no PIN yet the PIN box is offered once (hint) and Save sends it', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'CARD-1111-2222', voucherProvider: 'Croma', voucherPin: null, voucherFillable: true }),
    });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByTestId('ff-voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.queryByTestId('ff-voucher-code')).toBeNull();
    expect(screen.getByTestId('ff-voucher-provider')).toHaveAttribute('readonly');
    expect(screen.getByText('Add the PIN for this card — it can be saved once')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('PIN (if the card has one)'), { target: { value: ' 4455 ' } });
    fireEvent.click(screen.getByTestId('ff-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toMatchObject({ voucherCode: 'CARD-1111-2222', voucherPin: '4455', voucherProvider: 'Croma' });
  });

  it('F4: a stored code the server would NOT take a PIN on (voucherFillable false — e.g. Hubble / unpaid / closed) shows no PIN box', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'CARD-1111-2222', voucherProvider: 'Hubble', voucherPin: null, voucherFillable: false }),
    });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.queryByTestId('ff-voucher-pin')).toBeNull();
    expect(screen.queryByText('Add the PIN for this card — it can be saved once')).toBeNull();
  });

  it('a stored code: EVERY channel is selectable; on a physical channel the code + PIN stay visible read-only; Save sends no voucher clear', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'CARD-1111-2222', voucherProvider: 'Croma', voucherPin: '4455', voucherFillable: true }),
    });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    const select = screen.getByTestId('ff-channel') as HTMLSelectElement;
    expect(Array.from(select.options).every((o) => !o.disabled)).toBe(true);
    expect(screen.queryByTestId('ff-channel-hint')).toBeNull();
    fireEvent.change(select, { target: { value: 'GIFSY_WAREHOUSE' } });
    expect(select.value).toBe('GIFSY_WAREHOUSE');
    // Never hidden: the stored code (and the masked PIN) are shown read-only on the physical channel.
    expect(screen.getByTestId('ff-voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.getByTestId('ff-voucher-pin-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('ff-voucher-code')).toBeNull();
    expect(screen.queryByTestId('ff-voucher-pin')).toBeNull();
    expect(screen.getByTestId('ff-tracking-number')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ff-tracking-number'), { target: { value: 'TRK-9' } });
    fireEvent.click(screen.getByTestId('ff-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toMatchObject({ fulfilmentChannel: 'GIFSY_WAREHOUSE', trackingNumber: 'TRK-9' });
    expect(patch.mock.calls[0][1]).not.toHaveProperty('voucherCode');
    expect(patch.mock.calls[0][1]).not.toHaveProperty('voucherPin');
    // Back on DIGITAL_VOUCHER the stored values are restored (F1).
    fireEvent.change(select, { target: { value: 'DIGITAL_VOUCHER' } });
    expect(screen.getByTestId('ff-voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.getByTestId('ff-voucher-provider')).toHaveValue('Croma');
  });

  it('F1/B5: a stored code with NO provider → provider is a set-once editable box (when fillable)', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'CARD-1111-2222', voucherProvider: null, voucherFillable: true }),
    });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    const provider = screen.getByTestId('ff-voucher-provider');
    expect(provider).not.toHaveAttribute('readonly');
    fireEvent.change(provider, { target: { value: 'Croma' } });
    fireEvent.click(screen.getByTestId('ff-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toMatchObject({ voucherProvider: 'Croma' });
  });

  it('OD2c: a stored PIN is read-only and masked behind "Show" (default hidden)', async () => {
    get.mockResolvedValue({
      success: true,
      data: orderWith({ fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'CARD-1111-2222', voucherPin: '4455' }),
    });
    render(<GiftOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.queryByTestId('ff-voucher-pin')).toBeNull();
    const pin = screen.getByTestId('ff-voucher-pin-readonly');
    expect(pin).toHaveTextContent('PIN ••••');
    expect(pin).not.toHaveTextContent('4455');
    fireEvent.click(screen.getByRole('button', { name: 'Show PIN for order DEO-26-000123' }));
    expect(pin).toHaveTextContent('4455');
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
