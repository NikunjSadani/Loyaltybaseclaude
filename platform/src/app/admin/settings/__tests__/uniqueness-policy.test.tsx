/// <reference types="vitest/globals" />
/**
 * Identity & Payout Uniqueness — Settings card (per-tenant, GIFSY_ADMIN only)
 *
 * `uniquenessPolicy` = { gst, phone, bank, upi } is a REPLACE-WHOLE nested key: every toggle
 * saves the COMPLETE object via saveGifsySettings({ uniquenessPolicy }). PAN + GST are always-on
 * golden keys (rendered as an "Always on" pill, never a toggle). GIFSY_ADMIN-only to edit.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let mockRole: 'GIFSY_ADMIN' | 'CLIENT_ADMIN' = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return { ...actual, getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }), getAssumedBrand: () => null };
});

// Un-assumed by default so the new platform-mode effect resolves to platform mode and never
// loads the real 'use server' auth-actions module (next/headers) in jsdom.
vi.mock('@/lib/auth-actions', () => ({
  getAssumedContext: vi.fn(async () => ({ brandName: null })),
}));
vi.mock('@/lib/points-expiry', () => ({
  fetchPointsExpiry: vi.fn().mockResolvedValue({ pointsExpiryDays: 90 }),
  savePointsExpiry: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return {
    ...actual,
    saveGifsySettings: vi.fn().mockResolvedValue(true),
    // The salesApp + uniqueness toggles save via the DETAILED variant (surfaces server messages).
    saveGifsySettingsDetailed: vi.fn().mockResolvedValue({ ok: true }),
  };
});

import SettingsPage from '../page';
import { saveGifsySettingsDetailed, hydrateGifsySettings } from '@/lib/gifsy-settings';

// The toggles on this card save through saveGifsySettingsDetailed.
const saveGifsySettings = saveGifsySettingsDetailed;

const DEFAULT_POLICY = { gst: true, phone: true, bank: false, upi: false };

function stubFetch(uniquenessPolicy: unknown, effective?: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/admin/settings') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { settings: { uniquenessPolicy } } }),
        });
      }
      // GET /api/settings (the reactive refresh) — only answered when a test supplies the
      // effective settings block (stored vs derived policy + salesApp).
      if (url === '/api/settings' && effective) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, data: effective }),
        });
      }
      return Promise.reject(new Error('no server in test'));
    }),
  );
}

// Effective-settings block where the DERIVED policy differs from the STORED one: manual UPI
// entry is ON, so the server forces the derived upi=true while the stored upi is false.
function effectiveSettings(opts: {
  stored: { gst: boolean; phone: boolean; bank: boolean; upi: boolean };
  derived: { gst: boolean; phone: boolean; bank: boolean; upi: boolean };
  upiManualEntry: boolean;
}) {
  return {
    conversionRate: 1,
    minBankTransferAmount: 250,
    minVoucherFreeAmount: 250,
    paceAmberThreshold: 10,
    visibilityEnabled: false,
    kycGstinRequired: true,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
    salesApp: { ledgerLabel: 'Wallet', upiEnabled: true, upiManualEntry: opts.upiManualEntry },
    outletPrograms: ['A'],
    outletCategories: ['B'],
    uniquenessPolicy: opts.derived,
    uniquenessPolicyStored: opts.stored,
  };
}

describe('Identity & Payout Uniqueness settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    // The settings store is module-level — reset it to defaults so no test's policy/salesApp leaks.
    hydrateGifsySettings(effectiveSettings({ stored: DEFAULT_POLICY, derived: DEFAULT_POLICY, upiManualEntry: false }));
  });

  it('renders PAN/GST as always-on and seeds the editable toggles from stored policy', async () => {
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    // PAN + GST are always-on golden keys.
    expect((await screen.findByTestId('uniq-pan')).textContent).toContain('Always on');
    expect(screen.getByTestId('uniq-gst').textContent).toContain('Always on');
    // Bank seeded OFF → the OFF segment is selected.
    await waitFor(() => expect(screen.getByTestId('uniq-bank-off')).toHaveAttribute('aria-checked', 'true'));
  });

  it('turning bank ON saves the WHOLE uniquenessPolicy object (gst stays true)', async () => {
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    const bankOn = await screen.findByTestId('uniq-bank-on');
    fireEvent.click(bankOn);
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenCalledWith({
        uniquenessPolicy: { gst: true, phone: true, bank: true, upi: false },
      }),
    );
  });

  it('disables the editable toggles for a non-GIFSY admin', async () => {
    mockRole = 'CLIENT_ADMIN';
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    expect(await screen.findByTestId('uniq-bank-on')).toBeDisabled();
    expect(screen.getByTestId('uniq-upi-on')).toBeDisabled();
  });

  it('saves on the STORED policy (never the derived upi=true) while manual UPI entry is on', async () => {
    // Stored upi=false, but manual entry ON → the server's derived/enforced upi=true.
    const stored  = { gst: true, phone: true, bank: false, upi: false };
    const derived = { gst: true, phone: true, bank: false, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived, upiManualEntry: true }));
    render(<SettingsPage />);

    // Display uses the STORED value: UPI shows OFF; only OFF is disabled (ON stays selectable to
    // repair this invalid stored state), and the note explains why.
    await waitFor(() => expect(screen.getByTestId('uniq-upi-off')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('uniq-upi-off')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('uniq-upi-on')).not.toBeDisabled());
    expect(screen.getByTestId('uniq-upi-note')).toHaveTextContent('Enforced automatically while UPI Manual Entry is on');

    fireEvent.click(screen.getByTestId('uniq-bank-on'));
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenCalledWith({
        uniquenessPolicy: { gst: true, phone: true, bank: true, upi: false },
      }),
    );
  });

  it('U6: manual entry ON + STORED upi OFF (invalid state) → selecting UPI uniqueness ON saves upi=true (recovery)', async () => {
    const stored  = { gst: true, phone: true, bank: false, upi: false };
    const derived = { ...stored, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived, upiManualEntry: true }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('uniq-upi-on')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('uniq-upi-on'));
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenCalledWith({
        uniquenessPolicy: { gst: true, phone: true, bank: false, upi: true },
      }),
    );
  });

  it('U6: while manual entry is ON, UPI uniqueness OFF is disabled and a click on it never saves', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: true }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('uniq-upi-on')).not.toBeDisabled());
    expect(screen.getByTestId('uniq-upi-on')).toHaveAttribute('aria-checked', 'true');
    const off = screen.getByTestId('uniq-upi-off');
    expect(off).toBeDisabled();
    fireEvent.click(off);
    expect(saveGifsySettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('uniq-upi-note')).toHaveTextContent('Enforced automatically while UPI Manual Entry is on');
  });

  it('disables UPI Manual Entry ON while STORED upi uniqueness is off (OFF stays allowed)', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: false };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    render(<SettingsPage />);

    // Wait for the post-mount refresh to complete (the salesApp toggles unlock after it).
    await waitFor(() => expect(screen.getByTestId('upi-collection-on')).not.toBeDisabled());
    expect(screen.getByTestId('upi-manual-entry-on')).toBeDisabled();
    expect(screen.getByTestId('upi-manual-entry-off')).not.toBeDisabled();
    expect(screen.getByTestId('upi-manual-entry-needs-uniqueness')).toHaveTextContent('Turn on UPI ID uniqueness first');

    fireEvent.click(screen.getByTestId('upi-manual-entry-on'));
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('enables UPI Manual Entry ON once STORED upi uniqueness is on', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('upi-manual-entry-on')).not.toBeDisabled());
    expect(screen.queryByTestId('upi-manual-entry-needs-uniqueness')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('upi-manual-entry-on'));
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenCalledWith({
        salesApp: expect.objectContaining({ upiEnabled: true, upiManualEntry: true }),
      }),
    );
  });

  /* ── G2: NO post-save refresh (a GET can hit another instance's stale 5-min cache) ── */
  it('G2: a salesApp toggle save does NOT re-fetch /api/settings, so a stale server snapshot cannot revert it', async () => {
    const actual = await vi.importActual<typeof import('@/lib/gifsy-settings')>('@/lib/gifsy-settings');
    // Run the REAL save (PUT → local cache update) so the post-save display is the real outcome.
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockImplementation(actual.saveGifsySettingsDetailed);
    const stored = { gst: true, phone: true, bank: false, upi: false };
    // The server's GET keeps answering the PRE-save snapshot (upiEnabled: true) — as another
    // instance's cache would.
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('upi-collection-off')).not.toBeDisabled());
    expect(screen.getByTestId('upi-collection-on')).toHaveAttribute('aria-checked', 'true');

    const settingsGets = () =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => u === '/api/settings').length;
    const before = settingsGets();
    fireEvent.click(screen.getByTestId('upi-collection-off'));
    await waitFor(() => expect(saveGifsySettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('upi-collection-off')).not.toBeDisabled());
    // Still OFF (the saved value) — not reverted to the stale ON.
    expect(screen.getByTestId('upi-collection-off')).toHaveAttribute('aria-checked', 'true');
    expect(settingsGets()).toBe(before);
  });

  it('G2: a uniqueness toggle save does NOT re-fetch /api/settings; the stored policy (save base) keeps the saved value', async () => {
    const actual = await vi.importActual<typeof import('@/lib/gifsy-settings')>('@/lib/gifsy-settings');
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockImplementation(actual.saveGifsySettingsDetailed);
    const stored = { gst: true, phone: true, bank: false, upi: false };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('uniq-upi-on')).not.toBeDisabled());

    const settingsGets = () =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => u === '/api/settings').length;
    const before = settingsGets();
    fireEvent.click(screen.getByTestId('uniq-bank-on'));
    await waitFor(() => expect(screen.getByTestId('uniq-bank-on')).toHaveAttribute('aria-checked', 'true'));
    expect(settingsGets()).toBe(before);
    // The NEXT toggle merges onto the saved base (bank stays true).
    await waitFor(() => expect(screen.getByTestId('uniq-phone-off')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('uniq-phone-off'));
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenLastCalledWith({
        uniquenessPolicy: { gst: true, phone: false, bank: true, upi: false },
      }),
    );
  });

  /* ── G3: the server's error message is surfaced (fixed copy only as a fallback) ── */
  it('G3: UPI Manual Entry save failure shows the SERVER message', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'Turn on UPI ID uniqueness first' });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('upi-manual-entry-on')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('upi-manual-entry-on'));
    const err = await screen.findByTestId('upi-manual-entry-error');
    expect(err).toHaveTextContent('Turn on UPI ID uniqueness first');
    expect(err).not.toHaveTextContent(/Gifsy Admin/);
    expect(err).toHaveAttribute('role', 'alert');
  });

  it('G3: uniqueness save failure shows the SERVER message ("Turn off UPI Manual Entry first")', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'Turn off UPI Manual Entry first' });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('uniq-upi-off')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('uniq-upi-off'));
    expect(await screen.findByTestId('uniq-policy-error')).toHaveTextContent('Turn off UPI Manual Entry first');
  });

  it('G3: a failure with NO server message falls back to the fixed copy', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: false };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('upi-collection-off')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('upi-collection-off'));
    expect(await screen.findByTestId('upi-collection-error'))
      .toHaveTextContent('Could not save — UPI collection can only be changed by a Gifsy Admin.');
  });

  /* ── G7: SegmentedControl a11y with a disabled option ── */
  it('G7: when the CHECKED option is disabled the group stays keyboard-reachable (tab stop on the first ENABLED option)', async () => {
    // Legacy state: manual entry ON while STORED upi uniqueness is OFF → ON is checked AND disabled.
    const stored  = { gst: true, phone: true, bank: false, upi: false };
    const derived = { ...stored, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived, upiManualEntry: true }));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('upi-manual-entry-off')).not.toBeDisabled());
    const on  = screen.getByTestId('upi-manual-entry-on');
    const off = screen.getByTestId('upi-manual-entry-off');
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(on).toBeDisabled();
    expect(off).toHaveAttribute('tabindex', '0');
    expect(on).toHaveAttribute('tabindex', '-1');
  });

  it('G7: arrow keys skip a disabled option (focus + tab stop stay on the enabled one)', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: false };
    stubFetch(stored, effectiveSettings({ stored, derived: stored, upiManualEntry: false }));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('upi-manual-entry-off')).not.toBeDisabled());
    const on  = screen.getByTestId('upi-manual-entry-on');
    const off = screen.getByTestId('upi-manual-entry-off');
    expect(on).toBeDisabled();
    off.focus();
    fireEvent.keyDown(off, { key: 'ArrowRight' });
    expect(off).toHaveAttribute('tabindex', '0');
    expect(on).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(off);
    fireEvent.keyDown(off, { key: 'End' });
    expect(document.activeElement).toBe(off);
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('G7: explanatory notes are linked to the control via aria-describedby', async () => {
    const stored = { gst: true, phone: true, bank: false, upi: false };
    stubFetch(stored, effectiveSettings({ stored, derived: { ...stored, upi: false }, upiManualEntry: false }));
    render(<SettingsPage />);
    const note = await screen.findByTestId('upi-manual-entry-needs-uniqueness');
    const group = screen.getByRole('radiogroup', { name: 'UPI manual entry' });
    expect(note.id).not.toBe('');
    expect(group.getAttribute('aria-describedby')?.split(' ')).toContain(note.id);
  });

  it('G7: the uniqueness-row note ("Enforced automatically…") describes the UPI ID toggle', async () => {
    const stored  = { gst: true, phone: true, bank: false, upi: false };
    const derived = { ...stored, upi: true };
    stubFetch(stored, effectiveSettings({ stored, derived, upiManualEntry: true }));
    render(<SettingsPage />);
    const note = await screen.findByTestId('uniq-upi-note');
    const group = screen.getByRole('radiogroup', { name: 'UPI ID' });
    expect(group.getAttribute('aria-describedby')?.split(' ')).toContain(note.id);
  });
});
