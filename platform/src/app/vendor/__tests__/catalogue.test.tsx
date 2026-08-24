/// <reference types="vitest/globals" />
/**
 * Vendor catalogue — list + editor (validation, re-approval note).
 *
 * CL1: lists the vendor's items with moderation badges
 * CL2: renders the approval-policy note (material edit → re-approval)
 * CL3: the editor blocks save when the selling price exceeds the MRP (no POST)
 * CL4: a valid create POSTs the rupees→paise payload to /api/vendor/catalogue
 * CL5: editing an APPROVED item with a material change warns it will re-submit for approval
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/vendor/catalogue',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

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

import VendorCataloguePage from '../catalogue/page';
import { VendorMeProvider } from '@/lib/vendor-context';
import type { VendorMe } from '@/lib/vendor';

const ME: VendorMe = {
  vendor: { id: 'v1', name: 'Acme Gifts', status: 'ACTIVE' },
  clientId: 'deoleo',
  clientName: 'Deoleo',
  approvalPolicy: 'GIFSY_APPROVE',
};

const CATEGORIES = [{ id: 'cat-1', parentId: null, code: 'ELX', name: 'Electronics', imageUrl: null, sortOrder: 0, isActive: true }];

const ITEMS = [
  {
    id: 'i1', name: 'JBL Speaker', categoryId: 'cat-1', categoryName: 'Electronics',
    sellingValuePaise: 199900, mrpPaise: 249900, pointsCost: 1999,
    moderationStatus: 'APPROVED', stockQuantity: 10, imageUrls: ['https://x/a.jpg'],
  },
  {
    id: 'i2', name: 'Power Bank', categoryId: 'cat-1', categoryName: 'Electronics',
    sellingValuePaise: 99900, mrpPaise: 129900, moderationStatus: 'PENDING', stockQuantity: null,
  },
];

const DETAIL_I1 = {
  ...ITEMS[0], description: 'Great speaker', termsAndConditions: '', imageUrls: ['https://x/a.jpg'],
};

function mockGet(items = ITEMS) {
  get.mockImplementation((url: string) => {
    if (url === '/api/vendor/catalogue') return Promise.resolve({ success: true, data: { items } });
    if (url === '/api/vendor/categories') return Promise.resolve({ success: true, data: { items: CATEGORIES } });
    if (url === '/api/vendor/catalogue/i1') return Promise.resolve({ success: true, data: DETAIL_I1 });
    return Promise.resolve({ success: false, error: 'unexpected url ' + url });
  });
}

function renderPage() {
  return render(<VendorMeProvider value={ME}><VendorCataloguePage /></VendorMeProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Vendor catalogue', () => {
  it('CL1: lists items with moderation badges', async () => {
    mockGet();
    renderPage();
    expect(await screen.findByText('JBL Speaker')).toBeInTheDocument();
    expect(screen.getByTestId('moderation-i1')).toHaveTextContent('Approved');
    expect(screen.getByTestId('moderation-i2')).toHaveTextContent('Pending approval');
  });

  it('CL2: renders the approval-policy note', async () => {
    mockGet();
    renderPage();
    await screen.findByText('JBL Speaker');
    expect(screen.getByTestId('policy-note')).toHaveTextContent(/approval/i);
  });

  it('CL3: blocks save when selling price exceeds MRP', async () => {
    mockGet();
    renderPage();
    await screen.findByText('JBL Speaker');

    fireEvent.click(screen.getByTestId('new-item-btn'));
    await screen.findByTestId('field-name');
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Overpriced' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'cat-1' } });
    fireEvent.change(screen.getByTestId('field-selling'), { target: { value: '3000' } });
    fireEvent.change(screen.getByTestId('field-mrp'), { target: { value: '2499' } });
    fireEvent.click(screen.getByTestId('save-item-btn'));

    expect(await screen.findByTestId('item-errors')).toHaveTextContent('Selling price cannot exceed the MRP.');
    expect(post).not.toHaveBeenCalled();
  });

  it('CL4: a valid create POSTs the rupees→paise payload', async () => {
    mockGet();
    post.mockResolvedValue({ success: true, data: {} });
    renderPage();
    await screen.findByText('JBL Speaker');

    fireEvent.click(screen.getByTestId('new-item-btn'));
    await screen.findByTestId('field-name');
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'New Gift' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'cat-1' } });
    fireEvent.change(screen.getByTestId('field-selling'), { target: { value: '1999' } });
    fireEvent.change(screen.getByTestId('field-mrp'), { target: { value: '2499' } });
    fireEvent.click(screen.getByTestId('save-item-btn'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/vendor/catalogue');
    expect(body).toMatchObject({
      name: 'New Gift',
      categoryId: 'cat-1',
      sellingValuePaise: 199900,
      mrpPaise: 249900,
    });
  });

  it('CL5: a material edit of an approved item warns it will re-submit for approval', async () => {
    mockGet();
    renderPage();
    await screen.findByText('JBL Speaker');

    fireEvent.click(screen.getByTestId('edit-i1'));
    // Editor loads the detail then hydrates the form.
    await waitFor(() =>
      expect((screen.getByTestId('field-selling') as HTMLInputElement).value).toBe('1999'),
    );
    // No warning while nothing material has changed.
    expect(screen.queryByTestId('reapproval-warning')).not.toBeInTheDocument();

    // Material change → warning appears.
    fireEvent.change(screen.getByTestId('field-selling'), { target: { value: '1500' } });
    expect(await screen.findByTestId('reapproval-warning')).toHaveTextContent(/re-submit/i);
  });

  it('CL6: a suspended/403 catalogue call shows the blocked state (keyed on HTTP 403)', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/vendor/catalogue') {
        return Promise.resolve({ success: false, error: "You don't have permission to do that", status: 403 });
      }
      return Promise.resolve({ success: true, data: { items: CATEGORIES } });
    });
    renderPage();
    expect(await screen.findByTestId('catalogue-blocked')).toBeInTheDocument();
  });

  it('CL6b: a NON-403 permission-ish error is NOT treated as blocked (no over-match)', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/vendor/catalogue') {
        // A transient 500 whose message merely contains "forbidden" must NOT flip the
        // whole page into the permanent suspended panel — it is a retryable error.
        return Promise.resolve({ success: false, error: 'Upstream forbidden the request (500)', status: 500 });
      }
      return Promise.resolve({ success: true, data: { items: CATEGORIES } });
    });
    renderPage();
    // Generic error (with its own retry), not the blocked panel.
    expect(await screen.findByText(/upstream forbidden the request/i)).toBeInTheDocument();
    expect(screen.queryByTestId('catalogue-blocked')).not.toBeInTheDocument();
  });

  it('CL7: the blocked panel offers a Retry that re-fetches (active vendor, transient 403)', async () => {
    let call = 0;
    get.mockImplementation((url: string) => {
      if (url === '/api/vendor/catalogue') {
        call += 1;
        // First load 403s (blocked); the retry succeeds and shows the catalogue.
        return call === 1
          ? Promise.resolve({ success: false, error: 'Forbidden', status: 403 })
          : Promise.resolve({ success: true, data: { items: ITEMS } });
      }
      if (url === '/api/vendor/categories') return Promise.resolve({ success: true, data: { items: CATEGORIES } });
      if (url === '/api/vendor/catalogue/i1') return Promise.resolve({ success: true, data: DETAIL_I1 });
      return Promise.resolve({ success: false, error: 'unexpected url ' + url });
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('catalogue-blocked-retry'));
    expect(await screen.findByText('JBL Speaker')).toBeInTheDocument();
    expect(screen.queryByTestId('catalogue-blocked')).not.toBeInTheDocument();
  });
});
