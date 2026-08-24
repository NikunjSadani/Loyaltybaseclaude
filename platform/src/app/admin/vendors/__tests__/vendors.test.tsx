/// <reference types="vitest/globals" />
/**
 * Vendor management — list renders + create; detail renders grants/logins, add-grant
 * POSTs, suspend confirms with the cascade warning before PATCHing status.
 *
 * Run: npx vitest run src/app/admin/vendors/__tests__/vendors.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
    patch: (url: string, body: unknown) => patch(url, body),
  },
  authHeader: () => ({}),
}));

// Detail page reads the vendor id from useParams; list page uses next/link only.
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'v1' }),
}));

import VendorListPage from '../page';
import VendorDetailPage from '../[id]/page';
import type { VendorSummary, VendorDetail } from '@/lib/vendors';

const VENDOR_SUMMARY: VendorSummary = {
  id: 'v1',
  name: 'Acme Fulfilment',
  status: 'ACTIVE',
  userCount: 2,
  grants: [
    { id: 'g1', clientId: 'deoleo', clientName: 'Deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' },
  ],
};

const VENDOR_DETAIL: VendorDetail = {
  ...VENDOR_SUMMARY,
  users: [
    { id: 'u1', name: 'Acme Ops', phone: '9830011252', clientId: 'deoleo', clientName: 'Deoleo' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ success: true, data: {} });
  patch.mockResolvedValue({ success: true, data: {} });
});

describe('VendorListPage', () => {
  beforeEach(() => {
    get.mockResolvedValue({ success: true, data: { items: [VENDOR_SUMMARY] } });
  });

  it('renders the vendor list with its granted tenant + login count', async () => {
    render(<VendorListPage />);
    expect(await screen.findByTestId('vendor-row-v1')).toBeInTheDocument();
    expect(screen.getByText('Acme Fulfilment')).toBeInTheDocument();
    expect(screen.getByText(/Deoleo/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no vendors', async () => {
    get.mockResolvedValueOnce({ success: true, data: { items: [] } });
    render(<VendorListPage />);
    expect(await screen.findByTestId('vendor-empty')).toBeInTheDocument();
  });

  it('creates a vendor — validates name then POSTs { name }', async () => {
    render(<VendorListPage />);
    fireEvent.click(await screen.findByTestId('new-vendor-btn'));

    // Empty name blocks the POST.
    fireEvent.click(screen.getByTestId('create-vendor-btn'));
    await screen.findByTestId('vendor-errors');
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('vendor-name-input'), { target: { value: 'New Vendor' } });
    fireEvent.click(screen.getByTestId('create-vendor-btn'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/vendors', { name: 'New Vendor' }),
    );
  });
});

describe('VendorDetailPage', () => {
  beforeEach(() => {
    get.mockImplementation((url: string) => {
      if (url === '/api/admin/vendors/v1') return Promise.resolve({ success: true, data: VENDOR_DETAIL });
      if (url === '/api/admin/tenants') {
        return Promise.resolve({
          success: true,
          data: { items: [{ id: 'deoleo', name: 'Deoleo' }, { id: 'gifsy2', name: 'Britannia' }] },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    });
  });

  it('renders grants + logins for the vendor', async () => {
    render(<VendorDetailPage />);
    expect(await screen.findByTestId('grant-row-g1')).toBeInTheDocument();
    expect(screen.getByTestId('login-row-u1')).toBeInTheDocument();
    expect(screen.getByText('Acme Ops')).toBeInTheDocument();
  });

  it('add-grant only offers ungranted tenants and POSTs { clientId, approvalPolicy }', async () => {
    render(<VendorDetailPage />);
    fireEvent.click(await screen.findByTestId('add-grant-btn'));

    const select = await screen.findByTestId('grant-tenant-select');
    // Deoleo is already granted → not an option; Britannia (gifsy2) is.
    expect(select).toHaveTextContent('Britannia');
    expect(select).not.toHaveTextContent('Deoleo');

    fireEvent.change(select, { target: { value: 'gifsy2' } });
    fireEvent.click(screen.getByTestId('grant-save-btn'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/vendors/v1/grants', {
        clientId: 'gifsy2',
        approvalPolicy: 'GIFSY_APPROVE',
      }),
    );
  });

  it('suspend shows the cascade warning and only PATCHes status after confirm', async () => {
    render(<VendorDetailPage />);
    fireEvent.click(await screen.findByTestId('suspend-btn'));

    // The cascade warning is shown; nothing has been PATCHed yet.
    const confirm = await screen.findByTestId('suspend-confirm');
    expect(confirm).toHaveTextContent(/hides all of the vendor/i);
    expect(confirm).toHaveTextContent(/cancel \+ refund/i);
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('status-confirm-btn'));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/admin/vendors/v1', { status: 'SUSPENDED' }),
    );
  });

  it('revoke a grant confirms with the cascade warning then PATCHes status REVOKED', async () => {
    render(<VendorDetailPage />);
    fireEvent.click(await screen.findByTestId('revoke-g1'));

    const confirm = await screen.findByTestId('revoke-confirm');
    expect(confirm).toHaveTextContent(/cancel \+ refund/i);
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('revoke-confirm-btn'));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/admin/vendors/v1/grants/g1', { status: 'REVOKED' }),
    );
  });
});
