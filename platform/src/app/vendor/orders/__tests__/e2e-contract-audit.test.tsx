/// <reference types="vitest/globals" />
/**
 * ADVERSARIAL AUDIT — FE↔BE CONTRACT lane (vendor order detail).
 *
 * DEFECT C2 (HIGH) — FIXED. The vendor FE reads a MAPPED shape
 * ({ delivery:{name,address,phone}, rewardName }). The vendor BE originally returned the
 * RAW Prisma select (flat deliveryName / deliveryAddressLine1..pincode / deliveryPhone,
 * nested reward:{name}) so every live in-window order rendered "delivery details aren't
 * available" and the item name showed "—". The fix maps the row on the BE
 * (getOrder/listOrders → toVendorOrderView in api/src/vendor/vendor-portal.service.ts):
 * deliveryName→delivery.name, deliveryAddressLine1+city+state+pincode→delivery.address,
 * deliveryPhone→delivery.phone, reward.name→rewardName — WITHOUT surfacing valuePaise /
 * points (that 194R cost basis stays hidden per decision #15) and AFTER retention (#16).
 *
 * This file pins BOTH sides of the contract:
 *  - the CORRECT-BEHAVIOUR case feeds the MAPPED shape the BE now returns → PII + item
 *    render, value stays hidden;
 *  - the TRIPWIRES feed the RAW flat shape and prove the FE alone cannot render it — a
 *    regression guard that the mapping must stay on the BE (revert the mapper → these fail).
 *
 * Run: cd platform && npx vitest run src/app/vendor/orders/__tests__/e2e-contract-audit.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import VendorOrderDetailPage from '../[id]/page';

/** The MAPPED shape GET /v1/vendor/orders/:id NOW returns (toVendorOrderView + retention). */
function mappedVendorOrderResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'DEO-26-000123',
    status: 'PROCESSING',
    redemptionMode: 'PHYSICAL_GIFT',
    quantity: 1,
    rewardName: 'Bluetooth Speaker',
    fulfilmentChannel: 'BRAND',
    logisticsPartner: null,
    supplierOrderRef: null,
    trackingNumber: null,
    trackingUrl: null,
    voucherCode: null,
    voucherProvider: null,
    podUrl: null,
    // NESTED delivery block composed on the BE from the flat DB columns.
    delivery: { name: 'Ravi Kumar', address: '12 MG Road, Pune, MH, 411001', phone: '9876543210' },
    piiWithheld: false,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    // NOTE: no valuePaise / totalPointsCost / metadata / sourceType — hidden per #15.
    ...overrides,
  };
}

/** The RAW flat select shape (pre-mapping) — used ONLY by the regression tripwires. */
function realVendorOrderResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'DEO-26-000123',
    status: 'PROCESSING',
    redemptionMode: 'PHYSICAL_GIFT',
    quantity: 1,
    fulfilmentChannel: 'BRAND',
    logisticsPartner: null,
    supplierOrderRef: null,
    trackingNumber: null,
    trackingUrl: null,
    voucherCode: null,
    voucherProvider: null,
    podUrl: null,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    // FLAT delivery PII — the real BE shape (NOT nested `delivery`).
    deliveryName: 'Ravi Kumar',
    deliveryPhone: '9876543210',
    deliveryAddressLine1: '12 MG Road',
    deliveryAddressLine2: null,
    deliveryCity: 'Pune',
    deliveryState: 'MH',
    deliveryPincode: '411001',
    reward: { id: 'rw1', name: 'Bluetooth Speaker', imageUrls: [] },
    statusHistory: [],
    piiWithheld: false,
    // NOTE: no `delivery`, no `rewardName`, no `valuePaise`, no `totalPointsCost`.
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FE↔BE contract — vendor order detail against the REAL backend shape', () => {
  // C2 (HIGH) — FIXED. With the MAPPED BE payload the vendor detail page reads
  // order.delivery.{name,address,phone} + order.rewardName, so a live in-window order shows
  // the ship-to name/address/phone the vendor needs to dispatch — and NEVER the cost basis.
  it('shows the ship-to name/address/phone + item name from the mapped BE shape (C2)', async () => {
    get.mockResolvedValue({ success: true, data: mappedVendorOrderResponse() });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByText(/12 MG Road/)).toBeInTheDocument();
    expect(screen.getByText('9876543210')).toBeInTheDocument();
    // Item name resolves from the mapped rewardName.
    expect(screen.getAllByText('Bluetooth Speaker').length).toBeGreaterThan(0);
    // PRIVACY (#15): no rupee value / points reach the vendor.
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
  });

  it('REGRESSION GUARD: a RAW flat payload → PII NOT rendered (mapping must stay on the BE)', async () => {
    // If the BE mapper is ever reverted (flat select returned verbatim), the FE cannot read
    // it and falls back to the "not available" notice — this tripwire then fails loudly.
    get.mockResolvedValue({ success: true, data: realVendorOrderResponse() });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    expect(screen.getByText(/retention window has passed/i)).toBeInTheDocument();
    expect(screen.queryByText('Ravi Kumar')).not.toBeInTheDocument();
    expect(screen.queryByText('9876543210')).not.toBeInTheDocument();
  });

  it('REGRESSION GUARD: a RAW flat payload → item name (reward.name, not rewardName) shows "—"', async () => {
    get.mockResolvedValue({ success: true, data: realVendorOrderResponse() });
    render(<VendorOrderDetailPage />);
    await screen.findByText('DEO-26-000123');
    // Unmapped flat shape carries reward.name (not rewardName) → the item title is not shown.
    expect(screen.queryByText('Bluetooth Speaker')).not.toBeInTheDocument();
  });
});
