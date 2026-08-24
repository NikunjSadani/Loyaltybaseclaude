/// <reference types="vitest/globals" />
/**
 * Vendor orders — list + detail (fulfilment form, RESTRICTED transitions).
 *
 * OL1: the list renders the vendor's own orders
 * OD1: detail shows the order + the delivery address (needed to ship)
 * OD2: the fulfilment form PATCHes /api/vendor/orders/:id/fulfilment with the chosen channel
 * OD3: switching the channel to DIGITAL_VOUCHER swaps tracking → voucher-code input
 * OD4: a PROCESSING order offers ONLY "Dispatched" — never cancel / return / failed
 * OD5: a DELIVERED order is terminal for the vendor (no transitions; only Gifsy can reverse)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'o1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/vendor/orders',
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

import VendorOrdersPage from '../orders/page';
import VendorOrderDetailPage from '../orders/[id]/page';
import { VendorMeProvider } from '@/lib/vendor-context';
import type { VendorMe } from '@/lib/vendor';

const ME: VendorMe = {
  vendor: { id: 'v1', name: 'Acme Gifts', status: 'ACTIVE' },
  clientId: 'deoleo',
  clientName: 'Deoleo',
  approvalPolicy: 'GIFSY_APPROVE',
};

/**
 * The REAL mapped vendor BE output (VENDOR_ORDER_SELECT → applyVendorPiiRetention →
 * toVendorOrderView): a NESTED `delivery.{name,address,phone}` block + `rewardName`, and
 * DELIBERATELY NO `valuePaise` / `totalPointsCost` — the 194R cost basis stays hidden from
 * the vendor (decision #15). `piiWithheld` flags whether the retention window has elapsed.
 */
function orderWith(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'DEO-26-000123',
    status: 'PROCESSING',
    rewardName: 'Bluetooth Speaker',
    createdAt: '2026-05-10T00:00:00.000Z',
    delivery: { name: 'Ravi Kumar', address: '12 MG Road, Pune, MH, 411001', phone: '9876543210' },
    piiWithheld: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Vendor orders list', () => {
  it('OL1: renders the vendor’s own orders', async () => {
    get.mockResolvedValue({ success: true, data: { items: [orderWith({})] } });
    render(<VendorOrdersPage />);
    expect(await screen.findByText('DEO-26-000123')).toBeInTheDocument();
    expect(screen.getByText('Bluetooth Speaker')).toBeInTheDocument();
  });

  it('OL2: a 403 shows the blocked panel with a Retry that recovers (transient block)', async () => {
    let call = 0;
    get.mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.resolve({ success: false, error: 'Forbidden', status: 403 })
        : Promise.resolve({ success: true, data: { items: [orderWith({})] } });
    });
    render(<VendorOrdersPage />);
    fireEvent.click(await screen.findByTestId('orders-blocked-retry'));
    expect(await screen.findByText('DEO-26-000123')).toBeInTheDocument();
    expect(screen.queryByTestId('orders-blocked')).not.toBeInTheDocument();
  });

  it('OL3: defence-in-depth — drops a row that isn’t this vendor’s (fulfilledByVendorId slip)', async () => {
    get.mockResolvedValue({
      success: true,
      data: {
        items: [
          orderWith({ id: 'o1', orderNumber: 'MINE-1', fulfilledByVendorId: 'v1' }),
          orderWith({ id: 'o2', orderNumber: 'FOREIGN-2', fulfilledByVendorId: 'v-other', rewardName: 'Not Mine' }),
        ],
      },
    });
    render(<VendorMeProvider value={ME}><VendorOrdersPage /></VendorMeProvider>);
    expect(await screen.findByText('MINE-1')).toBeInTheDocument();
    // The foreign vendor's order is filtered out client-side (BE remains the boundary).
    expect(screen.queryByText('FOREIGN-2')).not.toBeInTheDocument();
  });
});

describe('Vendor order detail', () => {
  it('OD1: shows the order + delivery PII (name/address/phone) + item name; hides value/points', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({}) });
    render(<VendorOrderDetailPage />);
    expect(await screen.findByText('DEO-26-000123')).toBeInTheDocument();
    // Delivery PII the vendor needs to SHIP (C2 — this is the core dispatch flow).
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByText('12 MG Road, Pune, MH, 411001')).toBeInTheDocument();
    expect(screen.getByText('9876543210')).toBeInTheDocument();
    // Item name resolves from the mapped `rewardName` (was "—" under the old raw shape).
    expect(screen.getAllByText('Bluetooth Speaker').length).toBeGreaterThan(0);
    // PRIVACY (#15): the 194R cost basis is never sent → no rupee value / points shown.
    expect(screen.queryByText('₹1,999')).not.toBeInTheDocument();
    expect(screen.queryByText('1,999')).not.toBeInTheDocument();
  });

  it('OD2: PATCHes the fulfilment with the chosen channel + tracking', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({}) });
    patch.mockResolvedValue({ success: true, data: {} });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    fireEvent.change(screen.getByTestId('ff-channel'), { target: { value: 'BRAND' } });
    fireEvent.change(screen.getByTestId('ff-logistics'), { target: { value: 'Delhivery' } });
    fireEvent.change(screen.getByTestId('ff-tracking-number'), { target: { value: 'TRK-9' } });
    fireEvent.click(screen.getByTestId('ff-save'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe('/api/vendor/orders/o1/fulfilment');
    expect(body).toMatchObject({ fulfilmentChannel: 'BRAND', logisticsPartner: 'Delhivery', trackingNumber: 'TRK-9' });
  });

  it('OD3: switching to DIGITAL_VOUCHER swaps tracking → voucher-code input', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({}) });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    // Physical channel shows a tracking-number field.
    fireEvent.change(screen.getByTestId('ff-channel'), { target: { value: 'BRAND' } });
    expect(screen.getByTestId('ff-tracking-number')).toBeInTheDocument();

    // Digital voucher swaps to a voucher-code field.
    fireEvent.change(screen.getByTestId('ff-channel'), { target: { value: 'DIGITAL_VOUCHER' } });
    expect(await screen.findByTestId('ff-voucher-code')).toBeInTheDocument();
    expect(screen.queryByTestId('ff-tracking-number')).not.toBeInTheDocument();
  });

  it('OD4: a PROCESSING order offers ONLY Dispatched (no cancel/return/failed)', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'PROCESSING' }) });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    expect(screen.getByTestId('transition-DISPATCHED')).toBeInTheDocument();
    expect(screen.queryByTestId('transition-CANCELLED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-RETURNED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-FAILED')).not.toBeInTheDocument();
  });

  it('OD4b: a DISPATCHED order offers ONLY Delivered', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'DISPATCHED' }) });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByTestId('transition-DELIVERED')).toBeInTheDocument();
    expect(screen.queryByTestId('transition-RETURNED')).not.toBeInTheDocument();
  });

  it('OD5: a DELIVERED order is terminal for the vendor (no transitions)', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'DELIVERED' }) });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.queryByTestId('transition-DELIVERED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-RETURNED')).not.toBeInTheDocument();
    expect(screen.getByText(/only Gifsy can cancel or reverse/i)).toBeInTheDocument();
  });

  it('OD6: a dispatch transition confirms then POSTs to the vendor transition endpoint', async () => {
    get.mockResolvedValue({ success: true, data: orderWith({ status: 'PROCESSING' }) });
    post.mockResolvedValue({ success: true, data: {} });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');

    fireEvent.click(screen.getByTestId('transition-DISPATCHED'));
    // Confirm gate first — POST not yet fired.
    const confirm = await screen.findByTestId('transition-confirm');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(confirm);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/vendor/orders/o1/transition');
    expect(body).toMatchObject({ toStatus: 'DISPATCHED' });
  });
});
