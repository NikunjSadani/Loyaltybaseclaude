/// <reference types="vitest/globals" />
/**
 * Credits & Payouts config — Settings card (per-tenant, GIFSY_ADMIN only)
 *
 * The creditsPayouts block (month cutoff + per-row safety caps + notify emails) is stripped
 * from the tenant /me settings, so the card seeds from GET /api/admin/settings and writes via
 * saveGifsySettings({ creditsPayouts }) (a REPLACE-WHOLE nested key → the whole object is sent).
 * The card is GIFSY_ADMIN-only. Save is disabled until the fetch resolves so placeholder
 * defaults can't be persisted over the real stored values.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let mockRole: 'GIFSY_ADMIN' | 'CLIENT_ADMIN' = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return { ...actual, getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }) };
});
vi.mock('@/lib/points-expiry', () => ({
  fetchPointsExpiry: vi.fn().mockResolvedValue({ pointsExpiryDays: 90 }),
  savePointsExpiry: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: vi.fn().mockResolvedValue(true) };
});

import SettingsPage from '../page';
import { saveGifsySettings } from '@/lib/gifsy-settings';

// Resolve ONLY the exact /api/admin/settings GET with the given creditsPayouts; every other
// on-mount fetch (visibility-capture-mode, task-config…) rejects and its lib falls back.
function stubFetch(creditsPayouts: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/admin/settings') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { settings: { creditsPayouts } } }),
        });
      }
      return Promise.reject(new Error('no server in test'));
    }),
  );
}

describe('Credits & Payouts settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('seeds from stored creditsPayouts and saves edits as the whole object', async () => {
    stubFetch({ monthCutoffDay: 15, safetyCapPoints: 40000, safetyCapInr: 80000, fourEyesEnabled: false, notifyEmails: ['a@x.com'] });
    render(<SettingsPage />);
    const cutoff = await screen.findByTestId('cp-cutoff-input');
    await waitFor(() => expect(cutoff).toHaveValue(15));
    expect(screen.getByTestId('cp-cap-points-input')).toHaveValue(40000);
    expect(screen.getByTestId('cp-cap-inr-input')).toHaveValue(80000);

    fireEvent.change(cutoff, { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('cp-notify-emails-input'), {
      target: { value: 'ops@deoleo.com, finance@deoleo.com' },
    });
    const saveBtn = screen.getByTestId('cp-save');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith({
        creditsPayouts: {
          monthCutoffDay: 20,
          safetyCapPoints: 40000,
          safetyCapInr: 80000,
          fourEyesEnabled: false, // round-tripped, not dropped
          notifyEmails: ['ops@deoleo.com', 'finance@deoleo.com'],
        },
      });
    });
  });

  it('is usable from scratch when no creditsPayouts is stored (defaults, Save enabled)', async () => {
    stubFetch(undefined);
    render(<SettingsPage />);
    const cutoff = await screen.findByTestId('cp-cutoff-input');
    await waitFor(() => expect(cutoff).toHaveValue(28));
    const saveBtn = screen.getByTestId('cp-save');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith(
        expect.objectContaining({
          creditsPayouts: expect.objectContaining({ monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, notifyEmails: [] }),
        }),
      );
    });
  });

  it('rejects an invalid email and does NOT save', async () => {
    stubFetch({ monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] });
    render(<SettingsPage />);
    const emails = await screen.findByTestId('cp-notify-emails-input');
    fireEvent.change(emails, { target: { value: 'not-an-email' } });
    const saveBtn = screen.getByTestId('cp-save');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(screen.getByText(/is not a valid email/)).toBeInTheDocument());
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('rejects a cutoff day outside 1–31 and does NOT save', async () => {
    stubFetch({ monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] });
    render(<SettingsPage />);
    const cutoff = await screen.findByTestId('cp-cutoff-input');
    await waitFor(() => expect(cutoff).toHaveValue(28));
    fireEvent.change(cutoff, { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('cp-save'));
    await waitFor(() => expect(screen.getByText(/between 1 and 31/)).toBeInTheDocument());
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('does not render for CLIENT_ADMIN (GIFSY-operated setting)', async () => {
    mockRole = 'CLIENT_ADMIN';
    stubFetch({ monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] });
    render(<SettingsPage />);
    await screen.findByTestId('conversion-rate-card'); // page rendered
    expect(screen.queryByTestId('credits-payouts-card')).not.toBeInTheDocument();
  });
});
