/// <reference types="vitest/globals" />
/**
 * Sales Leaderboard page — API wiring
 *
 * SLB1: fetches /api/sales/leaderboard?scope=rm (NOT the partner /api/leaderboard)
 * SLB2: renders the API rows once fetch resolves (enveloped { success, data })
 * SLB3: renders the isMe hero (#rank + achievement) for the caller's entry
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

import SalesLeaderboardPage from '../page';

afterEach(() => { vi.unstubAllGlobals(); });

const body = {
  success: true,
  data: {
    entries: [
      { name: 'Bravo Rep',  territory: 'North', achievementPct: 92, activeOutlets: 12, change: 1, isMe: false },
      { name: 'Anita Rep',  territory: 'West',  achievementPct: 78, activeOutlets: 9,  change: -1, isMe: true },
      { name: 'Charlie Rep', territory: 'South', achievementPct: 55, activeOutlets: 4, change: 0, isMe: false },
    ],
  },
};

describe('Sales Leaderboard — API wiring', () => {
  it('SLB1: fetches /api/sales/leaderboard?scope=rm (not the partner board)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal('fetch', mockFetch);
    render(<SalesLeaderboardPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // AF-6: auth rides the httpOnly cookie (same-origin fetch sends it); no Authorization header.
    expect(mockFetch).toHaveBeenCalledWith('/api/sales/leaderboard?scope=rm');
  });

  it('SLB2: renders the API rows once fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }));
    render(<SalesLeaderboardPage />);
    // Bravo appears in both the podium and the list.
    const bravo = await screen.findAllByText('Bravo Rep');
    expect(bravo.length).toBeGreaterThan(0);
    expect(await screen.findAllByText('Charlie Rep')).toHaveLength(1);
  });

  it('SLB3: renders the isMe hero with the caller rank + achievement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }));
    render(<SalesLeaderboardPage />);
    // The "You" badge marks the caller's row.
    expect(await screen.findByText('You')).toBeTruthy();
    // The caller (Anita, rank #2) hero shows #2 and 78%.
    expect(await screen.findByText('#2')).toBeTruthy();
    const pcts = await screen.findAllByText('78%');
    expect(pcts.length).toBeGreaterThan(0);
  });
});
