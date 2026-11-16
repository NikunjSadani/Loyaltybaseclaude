/// <reference types="vitest/globals" />
/**
 * Sales Leaderboard page — API wiring (dynamic hierarchy tabs)
 *
 * SLB1: FIRST load fetches /api/sales/leaderboard with NO scope param
 * SLB2: renders the API rows once fetch resolves (enveloped { success, data })
 * SLB3: renders the isMe hero (#rank + achievement) for the caller's entry
 * SLB4: renders the dynamic tab names from the response (not Reporting Mgr/State/National)
 * SLB5: clicking a tab refetches with ?scope=<thatTabId>
 * SLB6: the subtitle shows the SELECTED tab's name
 * SLB7: a single-tab response (top-of-chain caller) renders exactly one tab
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

import SalesLeaderboardPage from '../page';

afterEach(() => { vi.unstubAllGlobals(); });

const entries = [
  { userId: 'u-bravo',   name: 'Bravo Rep',   territory: 'North', achievementPct: 92, activeOutlets: 12, change: 1,  isMe: false },
  { userId: 'u-anita',   name: 'Anita Rep',   territory: 'West',  achievementPct: 78, activeOutlets: 9,  change: -1, isMe: true  },
  { userId: 'u-charlie', name: 'Charlie Rep', territory: 'South', achievementPct: 55, activeOutlets: 4,  change: 0,  isMe: false },
];

// Three-tab reporting chain (immediate manager first).
const body = {
  success: true,
  data: {
    tabs: [
      { id: 'mgr-1', name: 'Priya Menon' },
      { id: 'mgr-2', name: 'Rohit Sharma' },
      { id: 'mgr-3', name: 'Deepa Nair' },
    ],
    selectedTabId: 'mgr-1',
    entries,
  },
};

// Response for a tab-click on mgr-2 (server echoes the resolved selectedTabId).
const bodyMgr2 = {
  success: true,
  data: {
    tabs: body.data.tabs,
    selectedTabId: 'mgr-2',
    entries,
  },
};

// Top-of-chain caller: a single 'national' tab.
const nationalBody = {
  success: true,
  data: {
    tabs: [{ id: 'national', name: 'All India' }],
    selectedTabId: 'national',
    entries,
  },
};

const resolve = (payload: unknown) =>
  ({ ok: true, json: () => Promise.resolve(payload) });

describe('Sales Leaderboard — API wiring (dynamic tabs)', () => {
  it('SLB1: FIRST load fetches /api/sales/leaderboard with no scope param', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resolve(body));
    vi.stubGlobal('fetch', mockFetch);
    render(<SalesLeaderboardPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // AF-6: auth rides the httpOnly cookie (same-origin fetch sends it); no Authorization header.
    // No scope on first load — the server resolves the default tab.
    expect(mockFetch).toHaveBeenCalledWith('/api/sales/leaderboard');
  });

  it('SLB2: renders the API rows once fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolve(body)));
    render(<SalesLeaderboardPage />);
    // Bravo appears in both the podium and the list.
    const bravo = await screen.findAllByText('Bravo Rep');
    expect(bravo.length).toBeGreaterThan(0);
    expect(await screen.findAllByText('Charlie Rep')).toHaveLength(1);
  });

  it('SLB3: renders the isMe hero with the caller rank + achievement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolve(body)));
    render(<SalesLeaderboardPage />);
    // The "You" badge marks the caller's row.
    expect(await screen.findByText('You')).toBeTruthy();
    // The caller (Anita, rank #2) hero shows #2 and 78%.
    expect(await screen.findByText('#2')).toBeTruthy();
    const pcts = await screen.findAllByText('78%');
    expect(pcts.length).toBeGreaterThan(0);
  });

  it('SLB4: renders the dynamic ancestor tab names from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolve(body)));
    render(<SalesLeaderboardPage />);
    expect(await screen.findByRole('button', { name: 'Priya Menon' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Rohit Sharma' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Deepa Nair' })).toBeTruthy();
    // The old hardcoded labels are gone.
    expect(screen.queryByRole('button', { name: 'Reporting Mgr' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'National' })).toBeNull();
  });

  it('SLB5: clicking a tab refetches with ?scope=<thatTabId>', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(resolve(body))      // first load (no scope)
      .mockResolvedValueOnce(resolve(bodyMgr2)); // after click on mgr-2
    vi.stubGlobal('fetch', mockFetch);
    render(<SalesLeaderboardPage />);

    const tab2 = await screen.findByRole('button', { name: 'Rohit Sharma' });
    fireEvent.click(tab2);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/sales/leaderboard?scope=mgr-2'),
    );
    // First load carried no scope.
    expect(mockFetch).toHaveBeenNthCalledWith(1, '/api/sales/leaderboard');
  });

  it('SLB6: the subtitle shows the selected tab name', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(resolve(body))
      .mockResolvedValueOnce(resolve(bodyMgr2));
    vi.stubGlobal('fetch', mockFetch);
    render(<SalesLeaderboardPage />);

    // Default selected tab (mgr-1 = Priya Menon) in the subtitle.
    expect(await screen.findByText(/Priya Menon peers/)).toBeTruthy();

    // Switch to mgr-2 → subtitle follows the server's resolved selectedTabId.
    fireEvent.click(await screen.findByRole('button', { name: 'Rohit Sharma' }));
    expect(await screen.findByText(/Rohit Sharma peers/)).toBeTruthy();
  });

  it('SLB7: a single-tab response (top-of-chain caller) renders exactly one tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolve(nationalBody)));
    render(<SalesLeaderboardPage />);
    expect(await screen.findByRole('button', { name: 'All India' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Priya Menon' })).toBeNull();
  });
});
