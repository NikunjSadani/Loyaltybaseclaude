/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/status — an evidence upload must never be orphaned.
 *
 * The evidence panel renders only while its batch row is open. Collapsing the row (or opening
 * another batch) used to unmount the panel while its one-file-per-request loop kept running.
 * Now the row cannot be collapsed / switched while that batch's upload is running.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/status',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import PayoutStatusPage from '../page';

const batch = (id: string, period: string) => ({
  id,
  batchCode: `CB-${id}`,
  period,
  status: 'PENDING_CONFIRM',
  uploadedBy: 'ops',
  uploadedAt: '2026-10-01T00:00:00.000Z',
  totalOutlets: 1,
  totalPoints: 0,
  totalPayoutPaise: 10000,
});

const ok = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload });

describe('Payout status — evidence upload keeps its batch row open', () => {
  let releaseUpload: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    releaseUpload = null;
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN',
      clientId: 'gifsy',
      name: 'Test Admin',
      userId: '',
      canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/attachments')) {
        if (init?.method === 'POST') {
          return new Promise((resolve) => {
            releaseUpload = () => resolve({ ok: true, status: 201, json: async () => ({ success: true, data: {} }) });
          });
        }
        return ok({ success: true, data: { attachments: [] } });
      }
      if (url.startsWith('/api/admin/credits/batches?')) {
        return ok({
          success: true,
          data: { batches: [batch('b1', '2026-09'), batch('b2', '2026-08')], pagination: { page: 1, limit: 50, total: 2, pages: 1 } },
        });
      }
      const m = /\/api\/admin\/credits\/batches\/(b\d)$/.exec(url);
      if (m) return ok({ success: true, data: { ...batch(m[1], '2026-09'), rows: [] } });
      return ok({ success: true, data: null });
    }) as unknown as typeof fetch;
  });

  it('cannot collapse the row or open another batch while its upload runs; works again after', async () => {
    const { container } = render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    await screen.findByText('No audit evidence uploaded yet.');

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() => expect(releaseUpload).not.toBeNull());

    // Collapse attempt → ignored; panel still mounted.
    fireEvent.click(screen.getByTestId('batch-header-b1'));
    expect(screen.getByTestId('batch-header-b1').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('batch-header-b1').getAttribute('aria-disabled')).toBe('true');
    // Switching to another batch → ignored too.
    fireEvent.click(screen.getByTestId('batch-header-b2'));
    expect(screen.getByTestId('batch-header-b2').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('evidence-upload-progress').textContent).toMatch(/Uploading 1 of 1: a\.jpg/);

    releaseUpload!();
    await screen.findByText('Uploaded 1 of 1 file(s).');

    // Upload finished → collapse works again.
    fireEvent.click(screen.getByTestId('batch-header-b1'));
    await waitFor(() => expect(screen.getByTestId('batch-header-b1').getAttribute('aria-expanded')).toBe('false'));
  });
});
