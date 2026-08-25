/// <reference types="vitest/globals" />
/**
 * Delivery Status report — renders per-channel funnels + a paginated receipt table from the REAL
 * backend response shapes (C2-regression: the fixtures are typed as the BE contract, so a shape
 * drift breaks the test), applies filters, never sends a clientId (BE-scoped), shows the OTP
 * "indicative" caveat when the BE flags it, and the Download button hits the export route.
 *
 * Run: npx vitest run src/app/admin/notification-delivery/__tests__/notification-delivery.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (url: string) => get(url) },
  authHeader: () => ({}),
}));

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

let mockRole = 'GIFSY_ADMIN';
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({ role: mockRole, clientId: 'gifsy', name: 'T', userId: '', canManageSchemes: true }),
}));

import NotificationDeliveryPage from '../page';
import type { DeliverySummary, DeliveryListPage } from '@/lib/notification-delivery';

// ── the EXACT shapes the backend NotificationDeliveryReportService returns ──
const SUMMARY: DeliverySummary = {
  sms: { sent: 7, delivered: 5, failed: 1, pending: 3, deliveryRate: 5 / 6 },
  whatsapp: { sent: 7, delivered: 6, read: 4, failed: 0, pending: 0, deliveryRate: 1 },
  otp: { sent: 2, delivered: 9, failed: 1, deliveryRate: 0.9, indicative: false },
};

const LIST: DeliveryListPage = {
  items: [
    {
      id: 'r1',
      channel: 'SMS',
      eventKey: 'ORDER_APPROVED',
      recipientPhone: '9830011252',
      status: 'DELIVERED',
      sentAt: '2026-02-01T10:00:00.000Z',
      deliveredAt: '2026-02-01T10:00:05.000Z',
      readAt: null,
      failureReason: null,
      createdAt: '2026-02-01T09:59:59.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

function mockOk(summary: DeliverySummary = SUMMARY, list: DeliveryListPage = LIST) {
  get.mockImplementation((url: string) =>
    url.includes('/notification-delivery/summary')
      ? Promise.resolve({ success: true, data: summary })
      : Promise.resolve({ success: true, data: list }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = 'GIFSY_ADMIN';
  mockOk();
  // Export goes through the lib's raw fetch → stub it so the download path is exercised.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'attachment; filename="notification-delivery-2026-02-01.xlsx"' },
      blob: async () => new Blob(['xlsx']),
    }),
  );
});

describe('NotificationDeliveryPage', () => {
  it('renders the funnels + a receipt row from the real BE shape (C2 regression)', async () => {
    render(<NotificationDeliveryPage />);
    const row = await screen.findByTestId('delivery-row');
    expect(within(row).getByText('9830011252')).toBeInTheDocument();
    expect(within(row).getByText('SMS')).toBeInTheDocument();
    expect(within(row).getByText('Delivered')).toBeInTheDocument();

    // Funnel delivery rates rendered from deliveryRate (5/6 → 83%, 1 → 100%).
    expect(within(screen.getByTestId('funnel-sms')).getByTestId('funnel-sms-rate')).toHaveTextContent('83%');
    expect(within(screen.getByTestId('funnel-whatsapp')).getByTestId('funnel-whatsapp-rate')).toHaveTextContent('100%');
    // SMS funnel Sent=7.
    expect(within(screen.getByTestId('funnel-sms')).getByText('7')).toBeInTheDocument();
  });

  it('never sends a clientId on any request (BE enforces the tenant scope)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<NotificationDeliveryPage />);
    await screen.findByTestId('delivery-row');
    for (const [url] of get.mock.calls) {
      expect(url).not.toContain('clientId=');
    }
  });

  it('shows the OTP indicative caveat only when the BE flags it', async () => {
    render(<NotificationDeliveryPage />);
    await screen.findByTestId('delivery-row');
    // indicative:false in the default fixture → no caveat.
    expect(screen.queryByTestId('otp-indicative')).not.toBeInTheDocument();
  });

  it('renders the OTP caveat when indicative is true', async () => {
    mockOk({ ...SUMMARY, otp: { ...SUMMARY.otp, indicative: true } });
    render(<NotificationDeliveryPage />);
    expect(await screen.findByTestId('otp-indicative')).toBeInTheDocument();
  });

  it('applies the channel filter to the request query', async () => {
    render(<NotificationDeliveryPage />);
    await screen.findByTestId('delivery-row');
    fireEvent.change(screen.getByTestId('filter-channel'), { target: { value: 'WHATSAPP' } });
    fireEvent.click(screen.getByTestId('apply-filters-btn'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining('channel=WHATSAPP')),
    );
  });

  it('Download Excel hits the export route and saves the blob', async () => {
    render(<NotificationDeliveryPage />);
    await screen.findByTestId('delivery-row');
    fireEvent.click(screen.getByTestId('download-delivery-btn'));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/notification-delivery/export'),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
  });

  it('shows an empty state when there are no receipts', async () => {
    mockOk(SUMMARY, { items: [], total: 0, page: 1, pageSize: 25 });
    render(<NotificationDeliveryPage />);
    expect(await screen.findByTestId('delivery-empty')).toBeInTheDocument();
  });

  it('surfaces a list error with a retry', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/notification-delivery/summary')
        ? Promise.resolve({ success: true, data: SUMMARY })
        : Promise.resolve({ success: false, error: 'Boom' }),
    );
    render(<NotificationDeliveryPage />);
    const err = await screen.findByTestId('delivery-error');
    expect(within(err).getByText('Boom')).toBeInTheDocument();
  });
});
