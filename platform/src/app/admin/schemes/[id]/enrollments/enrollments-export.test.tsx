/**
 * enrollments-export.test.tsx
 *
 * Tests for the enrollment dashboard's xlsx export button.
 *
 * Verifies:
 *  1. Clicking "Export Excel" calls GET /api/admin/schemes/:id/enrollments/export
 *     (RAW blob — does NOT JSON-parse the response body).
 *  2. A download anchor is created and clicked on success.
 *  3. An error message is shown when the backend returns non-OK.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));

// React.use() is used for params — mock it to return { id: 'sch-test' }
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: (val: unknown) => {
      // If it looks like a promise (thenable), resolve synchronously to the params value
      if (val && typeof (val as Promise<unknown>).then === 'function') {
        return { id: 'sch-test' };
      }
      return val;
    },
  };
});

const mockFetch = vi.fn();
const mockClick = vi.fn();
const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'test-token'),
    setItem: vi.fn(),
  });

  // Stub URL.createObjectURL and revokeObjectURL
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: mockRevokeObjectURL,
  });

  // Stub document.createElement to intercept anchor click
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      // Override click so we can track it without navigating
      Object.defineProperty(el, 'click', { value: mockClick, configurable: true });
    }
    return el;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function renderPage() {
  const { default: EnrollmentDashboardPage } = await import('./page');
  const fakeParams = Promise.resolve({ id: 'sch-test' }) as Promise<{ id: string }>;
  return render(<EnrollmentDashboardPage params={fakeParams} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Enrollment Dashboard — Export Excel', () => {
  it('GETs /api/admin/schemes/:id/enrollments/export and triggers blob download on success', async () => {
    const fakeBlob = new Blob(['xlsx-bytes'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      blob: async () => fakeBlob,
    } as unknown as Response);

    await act(async () => { await renderPage(); });

    const exportBtn = screen.getByRole('button', { name: /export excel/i });
    await act(async () => { fireEvent.click(exportBtn); });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/admin/schemes/sch-test/enrollments/export',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });

    // Anchor click should have been invoked (download triggered)
    await waitFor(() => expect(mockClick).toHaveBeenCalled());

    // URL.revokeObjectURL should be called to clean up
    await waitFor(() => expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url'));
  });

  it('shows an error message when the backend returns non-OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Insufficient permissions' }),
    } as unknown as Response);

    await act(async () => { await renderPage(); });

    const exportBtn = screen.getByRole('button', { name: /export excel/i });
    await act(async () => { fireEvent.click(exportBtn); });

    await waitFor(() => {
      expect(screen.getByText(/export failed/i)).toBeInTheDocument();
    });

    // No download should have been triggered
    expect(mockClick).not.toHaveBeenCalled();
  });
});
