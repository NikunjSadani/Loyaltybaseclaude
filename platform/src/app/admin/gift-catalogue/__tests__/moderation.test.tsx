/// <reference types="vitest/globals" />
/**
 * Moderation queue — approve POSTs to /approve; reject requires a reason and POSTs it.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/moderation.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
  },
  authHeader: () => ({}),
}));

import ModerationQueuePage from '../moderation/page';
import type { ModerationItem } from '@/lib/gift-catalogue';

const ITEM: ModerationItem = {
  id: 'm1', name: 'Vendor Mug', vendorName: 'Acme', clientName: 'Deoleo',
  sellingValuePaise: 50000, mrpPaise: 60000, imageUrl: null, categoryName: 'Home',
  moderationStatus: 'PENDING', submittedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ success: true, data: { items: [ITEM] } });
  post.mockResolvedValue({ success: true, data: {} });
});

describe('ModerationQueuePage', () => {
  it('shows an empty state when nothing is pending', async () => {
    get.mockResolvedValueOnce({ success: true, data: { items: [] } });
    render(<ModerationQueuePage />);
    await screen.findByTestId('moderation-empty');
  });

  it('approve POSTs to the /approve endpoint', async () => {
    render(<ModerationQueuePage />);
    fireEvent.click(await screen.findByTestId('approve-m1'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/gift-catalogue/moderation/m1/approve', {}));
  });

  it('reject requires a reason, then POSTs it to the /reject endpoint', async () => {
    render(<ModerationQueuePage />);
    fireEvent.click(await screen.findByTestId('reject-m1'));

    // Confirm is disabled until a reason is typed.
    const confirm = await screen.findByTestId('reject-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId('reject-reason'), { target: { value: 'Price exceeds MRP' } });
    expect(screen.getByTestId('reject-confirm')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('reject-confirm'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/gift-catalogue/moderation/m1/reject', { reason: 'Price exceeds MRP' }),
    );
  });
});
