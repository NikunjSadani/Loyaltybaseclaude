/// <reference types="vitest/globals" />
/**
 * TDS Statutory Config — owner-only platform-level editor (/gifsy/tds-statutory)
 *
 * T1: renders the loaded FY entries (FY + rate + threshold values)
 * T2: "Add financial year" appends a new blank entry
 * T3: "Remove" deletes a row; disabled when only one row remains
 * T4: an out-of-range rate (99) shows an inline error and disables Save
 * T5: Save → confirm → PUTs the full entries list with the right body
 * T6: the owner-only guard hides the editor for a non-GIFSY_ADMIN role
 * T7: a 400 from the backend surfaces the error message verbatim
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mutable role for the mocked session — set per-test before rendering.
let mockRole: string = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Owner', role: mockRole, phone: '900' }),
  };
});

import GifsyTdsStatutoryPage from '../page';

const ENTRY = {
  effectiveFromFy: '2026-27',
  r194rWithPanPct: 10,
  r194rNoPanPct: 20,
  c194cIndividualPct: 1,
  c194cOtherPct: 2,
  c194cNoPanPct: 20,
  thr194cSingleRupees: 30000,
  thr194cFyRupees: 100000,
  thr194rFyRupees: 20000,
};

const PAYLOAD = {
  entries: [ENTRY],
  defaults: ENTRY,
  resolvedForCurrentFy: ENTRY,
};

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

/** Default fetch mock: GET returns PAYLOAD; PUT echoes the sent entries. */
function stubFetch(putHandler?: (init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/admin/tds/statutory') && method === 'PUT') {
      if (putHandler) return putHandler(init);
      return okJson(PAYLOAD);
    }
    if (u.includes('/api/admin/tds/statutory')) return okJson(PAYLOAD);
    return okJson({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { mockRole = 'GIFSY_ADMIN'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('TDS Statutory Config page', () => {
  it('T1: renders the loaded FY entries', async () => {
    stubFetch();
    render(<GifsyTdsStatutoryPage />);
    const fy = await screen.findByTestId('fy-0');
    expect((fy as HTMLInputElement).value).toBe('2026-27');
    expect((screen.getByTestId('field-0-r194rWithPanPct') as HTMLInputElement).value).toBe('10');
    expect((screen.getByTestId('field-0-thr194cSingleRupees') as HTMLInputElement).value).toBe('30000');
  });

  it('T2: "Add financial year" appends a new blank entry', async () => {
    stubFetch();
    render(<GifsyTdsStatutoryPage />);
    await screen.findByTestId('fy-0');
    expect(screen.queryByTestId('entry-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('add-row'));
    expect(screen.getByTestId('entry-1')).toBeInTheDocument();
    expect((screen.getByTestId('fy-1') as HTMLInputElement).value).toBe('');
  });

  it('T3: Remove deletes a row and is disabled when only one row remains', async () => {
    stubFetch();
    render(<GifsyTdsStatutoryPage />);
    await screen.findByTestId('fy-0');
    // With one row, remove is disabled.
    expect(screen.getByTestId('remove-0')).toBeDisabled();
    // Add a second row → both removable → remove one → back to a single row.
    fireEvent.click(screen.getByTestId('add-row'));
    expect(screen.getByTestId('remove-0')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('remove-1'));
    expect(screen.queryByTestId('entry-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('remove-0')).toBeDisabled();
  });

  it('T4: an out-of-range rate shows an inline error and disables Save', async () => {
    stubFetch();
    render(<GifsyTdsStatutoryPage />);
    await screen.findByTestId('fy-0');
    fireEvent.change(screen.getByTestId('field-0-r194rWithPanPct'), { target: { value: '99' } });
    expect(await screen.findByText('Must be between 0 and 95')).toBeInTheDocument();
    expect(screen.getByTestId('save-btn')).toBeDisabled();
  });

  it('T5: Save → confirm → PUTs the full entries list with the right body', async () => {
    const fetchMock = stubFetch();
    render(<GifsyTdsStatutoryPage />);
    await screen.findByTestId('fy-0');

    // Make a valid change so Save enables.
    fireEvent.change(screen.getByTestId('field-0-r194rWithPanPct'), { target: { value: '15' } });
    const save = screen.getByTestId('save-btn');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    // Confirm modal appears — click its confirm.
    const confirm = await screen.findByTestId('confirm-save');
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/tds/statutory'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].effectiveFromFy).toBe('2026-27');
    expect(body.entries[0].r194rWithPanPct).toBe(15); // numeric, coerced from the string input
    expect(body.entries[0].thr194cSingleRupees).toBe(30000);
  });

  it('T6: the owner-only guard hides the editor for a non-GIFSY_ADMIN role', async () => {
    mockRole = 'GIFSY_STAFF';
    stubFetch();
    render(<GifsyTdsStatutoryPage />);
    expect(await screen.findByText('Owner-only')).toBeInTheDocument();
    expect(screen.queryByTestId('fy-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-btn')).not.toBeInTheDocument();
  });

  it('T7: a 400 from the backend surfaces the error message verbatim', async () => {
    const message = 'effectiveFromFy must be unique across entries';
    stubFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ success: false, error: message }),
      }),
    );
    render(<GifsyTdsStatutoryPage />);
    await screen.findByTestId('fy-0');

    fireEvent.change(screen.getByTestId('field-0-r194rWithPanPct'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    fireEvent.click(await screen.findByTestId('confirm-save'));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
