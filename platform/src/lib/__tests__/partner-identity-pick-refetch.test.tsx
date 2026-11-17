/**
 * PIR — usePartnerIdentity after an outlet pick (announceActivePartnerChanged) + stored write-back.
 *
 * PIR1: a successful /partner/me writes its businessName/outletName into the stored user (only those
 *       fields), and marks the identity `resolved`.
 * PIR2: a resolved "no channel partner" (data:null) does NOT touch the stored user.
 * PIR3: a post-pick refetch that fails is retried ONCE; a successful retry shows the new outlet.
 * PIR4: a post-pick refetch that fails twice RESETS to the defaults — the previous outlet's nav
 *       features / activity flags / operable outlets / active id are never shown as the new outlet's —
 *       keeping the stored title (set to the picked outlet by rememberActiveOutletDisplay).
 * PIR5: an INITIAL /partner/me failure keeps the seeded stored identity, is not retried, and is not
 *       `resolved`.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: vi.fn().mockResolvedValue({ success: true }),
}));

import {
  usePartnerIdentity,
  announceActivePartnerChanged,
  rememberActiveOutletDisplay,
} from '@/lib/partner-identity';
import { DEFAULT_FEATURES } from '@/lib/tenant-features';

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (data: unknown): Reply => ({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
const fail: Reply = { ok: false, status: 503, json: () => Promise.resolve({}) };

/** Queue of /partner/me replies, consumed in call order. */
let replies: Reply[];
const fetchMock = vi.fn(() => {
  const next = replies.shift();
  return next ? Promise.resolve(next) : new Promise<Reply>(() => {});
});

const OUTLET_A_ME = {
  businessName: 'Kumar General Store', outletName: 'Kumar GS', ownerName: 'Rajesh', partnerCode: 'PA',
  outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: true, loyaltyEnabled: false,
  features: { walletModule: true, partnerApp: { showLeaderboard: true } },
  activePartnerId: null, groupOverviewAvailable: true,
  groupParent: { parentId: 'g1', businessName: 'Kumar Group', ownerName: 'Rajesh' },
  operableOutlets: [
    { partnerId: 'pa', outletId: 'oa', outletCode: 'OUT-A', outletName: 'Kumar GS', businessName: 'Kumar General Store', ownerName: 'Rajesh', isOwnLogin: true },
    { partnerId: 'pb', outletId: 'ob', outletCode: 'OUT-B', outletName: 'Kumar WS', businessName: 'Kumar Wholesale', ownerName: 'Rajesh', isOwnLogin: false },
  ],
};

const stored = () => JSON.parse(localStorage.getItem('user') ?? 'null');

beforeEach(() => {
  replies = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('user', JSON.stringify({
    id: 'u1', name: 'RAJESH', role: 'WHOLESALER', phone: '9', businessName: 'Kumar General Store', outletName: 'Kumar GS',
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('PIR — write-back + post-pick refetch', () => {
  it('PIR1: a successful /partner/me writes ONLY the display names back to the stored user', async () => {
    replies.push(ok({ ...OUTLET_A_ME, businessName: 'Kumar Wholesale', outletName: 'Kumar WS', activePartnerId: 'pb' }));
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(stored()).toEqual({
      id: 'u1', name: 'RAJESH', role: 'WHOLESALER', phone: '9', businessName: 'Kumar Wholesale', outletName: 'Kumar WS',
    });
  });

  it('PIR2: a resolved no-partner reply (data:null) leaves the stored user untouched', async () => {
    replies.push(ok(null));
    const before = localStorage.getItem('user');
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(localStorage.getItem('user')).toBe(before);
  });

  it('PIR3: a failed post-pick refetch is retried once; the retry\'s outlet B is shown', async () => {
    replies.push(ok(OUTLET_A_ME));
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.outletName).toBe('Kumar GS'));
    await waitFor(() => expect(result.current.resolved).toBe(true));

    replies.push(fail, ok({ ...OUTLET_A_ME, businessName: 'Kumar Wholesale', outletName: 'Kumar WS', activePartnerId: 'pb' }));
    act(() => {
      rememberActiveOutletDisplay(OUTLET_A_ME.operableOutlets[1]);
      announceActivePartnerChanged();
    });
    await waitFor(() => expect(result.current.outletName).toBe('Kumar WS'));
    expect(result.current.activePartnerId).toBe('pb');
    expect(result.current.resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + failed refetch + one retry
  });

  it('PIR4: a post-pick refetch failing twice resets to defaults + the stored (picked) title — never A\'s state', async () => {
    replies.push(ok(OUTLET_A_ME));
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.hasPointsActivity).toBe(true);
    expect(result.current.operableOutlets).toHaveLength(2);

    replies.push(fail, fail);
    act(() => {
      rememberActiveOutletDisplay(OUTLET_A_ME.operableOutlets[1]); // the pick → stored title = B
      announceActivePartnerChanged();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.operableOutlets).toEqual([]));

    const id = result.current;
    // Title = the picked outlet from storage; person on the sub-line.
    expect(id.outletName).toBe('Kumar WS');
    expect(id.businessName).toBe('Kumar Wholesale');
    expect(id.ownerName).toBe('RAJESH');
    // None of outlet A's state survives as B's.
    expect(id.hasPointsActivity).toBe(false);
    expect(id.hasPayoutActivity).toBe(false);
    expect(id.loyaltyEnabled).toBe(true); // the documented default
    expect(id.features).toEqual(DEFAULT_FEATURES);
    expect(id.activePartnerId).toBeNull();
    expect(id.partnerCode).toBeNull();
    expect(id.outletType).toBeNull();
    expect(id.groupOverviewAvailable).toBe(false);
    expect(id.groupParent).toBeNull();
    expect(id.loading).toBe(false);
    expect(id.resolved).toBe(false);
    // No further retries.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('PIR4b: while the post-pick refetch is in flight the identity is NOT resolved (A is no longer confirmed)', async () => {
    replies.push(ok(OUTLET_A_ME));
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    // No reply queued → the refetch hangs.
    act(() => { announceActivePartnerChanged(); });
    await waitFor(() => expect(result.current.resolved).toBe(false));
  });

  it('PIR5: an initial failure keeps the seeded stored identity, is not retried, and is not resolved', async () => {
    replies.push(fail);
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.outletName).toBe('Kumar GS');
    expect(result.current.resolved).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
