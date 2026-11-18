/// <reference types="vitest/globals" />
/**
 * TDS upload panel — fetch() itself rejecting (network drop) must never surface the raw
 * "Failed to fetch".
 *  - PREVIEW (apply=false) writes nothing → "Nothing was saved — please try again."
 *  - APPLY (apply=true) is one all-or-nothing insert and a re-upload is de-duplicated server-side →
 *    "It may have been saved — refresh and check before uploading again." (never "some or all").
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminTdsPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/admin-session', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/admin-session')>();
  return {
    ...mod,
    useAdminSession: vi.fn(() => ({ role: 'CLIENT_ADMIN', clientId: 'deoleo', name: 'T', canManageSchemes: false })),
  };
});

const MOCK_194R = {
  success: true,
  data: {
    section: '194R',
    fyLabel: '2025-26',
    summary: { totalBasePaise: '0', totalLiabilityPaise: '0', totalDepositedPaise: '0', totalOutstandingPaise: '0' },
    rows: [],
  },
};

const PREVIEW = { success: true, data: { processed: 1, succeeded: 1, skipped: 0, failed: 0, errors: [], warnings: [] } };

function mockFetch(opts: { preview?: 'ok' | 'reject'; apply?: 'reject' }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/upload') && url.includes('apply=false')) {
        if (opts.preview === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PREVIEW) });
      }
      if (url.includes('/upload') && url.includes('apply=true')) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(MOCK_194R) });
    }),
  );
}

function pickFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'tds.xlsx')] } });
}

afterEach(() => vi.unstubAllGlobals());

describe('TDS upload — fetch rejects', () => {
  it('PREVIEW network error → readable, says nothing was saved', async () => {
    mockFetch({ preview: 'reject' });
    const { container } = render(<AdminTdsPage />);
    await screen.findByText('Off-Platform 194R Upload');
    pickFile(container);
    const msg = await screen.findByText(/Couldn't reach the server/);
    expect(msg.textContent).toBe("Couldn't reach the server (network error). Nothing was saved — please try again.");
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it('APPLY network error → "it may have been saved — refresh and check before uploading again"', async () => {
    mockFetch({ preview: 'ok', apply: 'reject' });
    const { container } = render(<AdminTdsPage />);
    await screen.findByText('Off-Platform 194R Upload');
    pickFile(container);
    fireEvent.click(await screen.findByText('Confirm & Apply'));
    const msg = await screen.findByText(/Couldn't reach the server/);
    expect(msg.textContent).toBe(
      "Couldn't reach the server (network error). It may have been saved — refresh and check before uploading again.",
    );
    expect(msg.textContent).not.toMatch(/Some or all/);
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    expect(screen.queryByText('Applying…')).toBeNull();
  });
});
