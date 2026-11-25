/// <reference types="vitest/globals" />
/**
 * Visibility Capture Mode card — no silent fallback (owner rule): when the current mode can't be read the card shows
 * an error + Retry and NO mode control, so a Gifsy admin can't save over a mode nobody could see.
 * Run: npx vitest run src/app/admin/settings/__tests__/capture-mode.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Admin', role: 'GIFSY_ADMIN', phone: '900' }),
    getAssumedBrand: () => null,
  };
});
vi.mock('@/lib/auth-actions', () => ({ getAssumedContext: vi.fn(async () => ({ brandName: null })) }));
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: vi.fn().mockResolvedValue(true) };
});
vi.mock('@/lib/visibility-capture-mode', () => ({
  fetchVisibilityCaptureMode: vi.fn(),
  saveVisibilityCaptureMode: vi.fn().mockResolvedValue(undefined),
}));

import SettingsPage from '../page';
import { fetchVisibilityCaptureMode, saveVisibilityCaptureMode } from '@/lib/visibility-capture-mode';

const fetchMode = fetchVisibilityCaptureMode as ReturnType<typeof vi.fn>;
const control = () => screen.queryByRole('radiogroup', { name: 'Visibility capture mode' })
  ?? screen.queryByLabelText('Visibility capture mode');

describe('Visibility Capture Mode card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('a failed read → error + Retry, NO mode control, nothing saved; Retry → the control appears', async () => {
    fetchMode.mockResolvedValueOnce('UNKNOWN').mockResolvedValue('AMOUNT_UPLOAD');
    render(<SettingsPage />);
    const alert = await screen.findByTestId('capture-mode-unknown');
    expect(alert).toHaveTextContent("Couldn't load the current capture mode");
    expect(control()).toBeNull();
    expect(screen.queryByText(/^Active:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(control()).not.toBeNull());
    expect(screen.queryByTestId('capture-mode-unknown')).toBeNull();
    expect(screen.getByText(/Active: no photo capture/)).toBeInTheDocument();
    expect(fetchMode).toHaveBeenCalledTimes(2);
    expect(saveVisibilityCaptureMode).not.toHaveBeenCalled();
  });

  it('a known mode → the control is shown (no error)', async () => {
    fetchMode.mockResolvedValue('PHOTO_APPROVAL');
    render(<SettingsPage />);
    await waitFor(() => expect(control()).not.toBeNull());
    expect(screen.queryByTestId('capture-mode-unknown')).toBeNull();
  });
});
