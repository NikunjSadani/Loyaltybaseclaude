/// <reference types="vitest/globals" />
/**
 * Points Engine — Settings page.
 *  - PE-S1: GIFSY_ADMIN sees editable toggles + a Save button, reflecting the loaded flags.
 *  - PE-S2: CLIENT_ADMIN sees a read-only "managed by Gifsy" view with NO Save button.
 *  - PE-S3: a load failure shows an explicit error state (Try again), no fabricated toggles.
 *  - PE-S4: saving posts the current flags via setSettings and shows "Saved".
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import SettingsPage from '../page';
import { getSettings, setSettings } from '@/lib/points-engine/api';
import { useAdminSession } from '@/lib/admin-session';

vi.mock('@/lib/points-engine/api', () => ({ getSettings: vi.fn(), setSettings: vi.fn() }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: vi.fn() }));

const asGifsy = () =>
  (useAdminSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Gifsy', userId: '', canManageSchemes: true,
  });
const asClient = () =>
  (useAdminSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    role: 'CLIENT_ADMIN', clientId: 'deoleo', name: 'CA', userId: '', canManageSchemes: false,
  });

beforeEach(() => {
  vi.clearAllMocks();
  (getSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true, data: { clientId: 'deoleo', enabled: true, directCreditEnabled: false },
  });
  (setSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true, data: { clientId: 'deoleo', enabled: true, directCreditEnabled: true },
  });
});

describe('Points Engine settings page', () => {
  it('PE-S1: GIFSY_ADMIN sees editable toggles + Save', async () => {
    asGifsy();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument());
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches.every((s) => !s.hasAttribute('disabled'))).toBe(true); // engine on → both enabled
  });

  it('PE-S2: CLIENT_ADMIN sees a read-only managed-by-Gifsy view, no Save', async () => {
    asClient();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/managed by gifsy/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    screen.getAllByRole('switch').forEach((s) => expect(s).toBeDisabled());
  });

  it('PE-S3: a load failure shows an error state', async () => {
    asGifsy();
    (getSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'boom' });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/couldn.t load points engine settings/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('PE-S4: saving posts the flags and shows Saved', async () => {
    asGifsy();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/^saved$/i)).toBeInTheDocument());
  });
});
