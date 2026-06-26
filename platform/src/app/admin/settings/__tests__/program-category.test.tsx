/// <reference types="vitest/globals" />
/**
 * Outlet Programs & Categories — Gifsy Settings card
 *
 * The allowed Program Name / Program Category values for the Outlet Master upload are now a
 * per-tenant Gifsy Setting (replacing the former hardcoded frontend constants). The settings
 * card lets a GIFSY_ADMIN add/remove values; each change persists the WHOLE updated array via
 * saveGifsySettings (REPLACE-WHOLE).
 *
 * U1: card renders both list sections
 * U2: current programs + categories (defaults) are shown as chips
 * U3: adding a program calls saveGifsySettings with the appended array
 * U4: removing a category calls saveGifsySettings with the shortened array
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Render the editor as a GIFSY_ADMIN (the role that may edit). useAdminSession derives the role
// from getStoredUser(); returning a GIFSY_ADMIN user enables the add/remove controls.
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Gifsy Admin', role: 'GIFSY_ADMIN', phone: '900' }),
  };
});

// Spy on saveGifsySettings while keeping getGifsySettings/useGifsySettings real (defaults seed
// the card). The save is stubbed to succeed so the optimistic update sticks.
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return {
    ...actual,
    saveGifsySettings: vi.fn().mockResolvedValue(true),
  };
});

import SettingsPage from '../page';
import { saveGifsySettings } from '@/lib/gifsy-settings';

describe('Outlet Programs & Categories settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Lib helpers (task-config, visibility-capture-mode) fetch on mount — fail them so they
    // resolve to their defaults without touching a real server.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('U1: renders the Outlet Programs & Categories card with both sections', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('outlet-programs-card')).toBeInTheDocument();
    expect(screen.getByTestId('outlet-programs-section')).toBeInTheDocument();
    expect(screen.getByTestId('outlet-categories-section')).toBeInTheDocument();
  });

  it('U2: shows the current programs and categories as chips (defaults)', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Trade Loyalty')).toBeInTheDocument();
    expect(screen.getByText('Gold Programme')).toBeInTheDocument();
    expect(screen.getByText('Premium')).toBeInTheDocument();
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('Economy')).toBeInTheDocument();
  });

  it('U3: adding a program saves the appended array', async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByTestId('outlet-program-input'), { target: { value: 'Platinum Club' } });
    fireEvent.click(screen.getByTestId('outlet-program-add'));

    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith({
        outletPrograms: ['Trade Loyalty', 'Gold Programme', 'Platinum Club'],
      });
    });
  });

  it('U4: removing a category saves the shortened array', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByLabelText('Remove Economy'));

    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith({
        outletCategories: ['Premium', 'Standard'],
      });
    });
  });
});
