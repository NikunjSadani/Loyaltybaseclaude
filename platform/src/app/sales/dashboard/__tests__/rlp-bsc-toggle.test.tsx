/**
 * Sales dashboard — RLP/BSC outlet-type toggle (gated on the `rlpBscView` feature flag, no slug branch).
 *
 * The flag comes from the authenticated /api/sales/me (data.features.rlpBscView); the RLP/BSC button
 * TEXT comes from the per-tenant outlet-type display names — the two are INDEPENDENT.
 *
 * BT1: the toggle shows when rlpBscView=true, with RLP/BSC labels from the overrides; RLP (SSS) default.
 * BT2: the toggle is HIDDEN when rlpBscView=false even though the outlet-type labels exist (proves the
 *      gate is the FLAG, not the labels/slug) — and the page renders today's layout.
 * BT3: SO-gate — the Trade comparison card shows for SO (hasTeamView) but NOT for XSR (leaf).
 * BT5: the default (RLP) view shows SSS-scoped targets, never the unscoped combined totals.
 * BT6: a non-toggle tenant (flag off) issues exactly ONE no-param /sales/targets request (no race/dup).
 * BT7: the toggle stays HIDDEN while /api/sales/me is still loading (DEFAULT flag → false, no flash).
 * (Visibility-hidden-on-BSC lives in visibility-bsc-hidden.test.tsx, which needs visibility mocks.)
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/rlp-bsc-toggle.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve({ customTaskItems: [], customTaskLabel: 'Reminders' }),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners: () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners: () => [],
  getBgStyle: () => ({}),
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));
// slug is mocked 'bajaj' only so the Visibility card's isBajaj gate is satisfiable elsewhere; the
// toggle gate itself is the FLAG, never the slug.
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ slug: 'bajaj' }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

// Outlet-type overrides for useOutletTypeLabels (checks r.ok + Array.isArray(data)) → RLP/BSC labels.
const OUTLET_TYPES_WITH_OVERRIDES = {
  ok: true,
  json: () => Promise.resolve({ success: true, data: [
    { code: 'SSS',        label: 'RLP', name: 'Retailer',   displayName: 'RLP' },
    { code: 'WHOLESALER', label: 'BSC', name: 'Wholesaler', displayName: 'BSC' },
  ] }),
};
// /api/sales/me feature blob (useTenantFeatures checks r.ok, reads data.features).
const meFeatures = (rlpBscView: boolean) => ({
  ok: true,
  json: () => Promise.resolve({ success: true, data: { features: { rlpBscView } } }),
});

// Distinct payloads so a test can tell the SSS-scoped result from the unscoped (combined) one.
const TARGETS_SCOPED = { success: true, data: {
  period: null, outletCount: 1,
  kpis: [{ code: 'P', name: 'RLP Primary', unit: '', isPrimary: true, target: 100, achieved: 50, pace: 0.5 }],
  trend: [],
} };
const TARGETS_UNSCOPED = { success: true, data: {
  period: null, outletCount: 1,
  kpis: [{ code: 'P', name: 'Combined Primary', unit: '', isPrimary: true, target: 100, achieved: 50, pace: 0.5 }],
  trend: [],
} };

const TEAM_VIEW = { success: true, data: {
  mode: 'OVERVIEW', member: null, kpis: [],
  summary: { outlets: 0, kycDone: 0, kycPending: 0, avgScore: null },
  members: [],
  filterOptions: { outletTypes: [], programs: [], kpis: [] },
} };

const COMPARISON = { success: true, data: {
  outletType: 'SSS', program: null, kpiCode: 'P', kpiName: 'Primary',
  buckets: {
    current:     { monthlySale: 10, targetMet: { achieved: 1, withTarget: 2, pct: 50 } },
    lastMonth:   { monthlySale: 8,  targetMet: { achieved: 1, withTarget: 2, pct: 50 } },
    last3Months: { monthlySale: 9,  targetMet: { achieved: null, withTarget: null, pct: 50 } },
  },
} };

// `flag` drives /api/sales/me → features.rlpBscView; `me` can be overridden (e.g. a never-resolving
// promise to simulate the loading window).
function setupFetch(flag: boolean, me?: unknown) {
  fetchMock.mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/api/sales/me'))              return me !== undefined ? Promise.resolve(me) : Promise.resolve(meFeatures(flag));
    if (u.includes('/api/settings/outlet-types')) return Promise.resolve(OUTLET_TYPES_WITH_OVERRIDES);
    if (u.includes('/api/sales/team-view'))       return Promise.resolve({ ok: true, json: () => Promise.resolve(TEAM_VIEW) });
    if (u.includes('/api/sales/trade-comparison')) return Promise.resolve({ ok: true, json: () => Promise.resolve(COMPARISON) });
    if (u.includes('/api/sales/targets'))          return Promise.resolve({ ok: true, json: () => Promise.resolve(u.includes('outletType=') ? TARGETS_SCOPED : TARGETS_UNSCOPED) });
    if (u.includes('/api/sales/outlets'))          return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
});

describe('Sales dashboard — RLP/BSC toggle gate', () => {
  it('BT1: shows the toggle (RLP default) with override labels when rlpBscView=true', async () => {
    setupFetch(true);
    render(<SalesDashboardPage />);
    const toggle = await screen.findByTestId('rlp-bsc-toggle');
    const rlp = screen.getByRole('tab', { name: 'RLP' });
    const bsc = screen.getByRole('tab', { name: 'BSC' });
    expect(toggle).toContainElement(rlp);
    expect(toggle).toContainElement(bsc);
    // Default selection = RLP (SSS).
    expect(rlp).toHaveAttribute('aria-selected', 'true');
    expect(bsc).toHaveAttribute('aria-selected', 'false');
  });

  it('BT2: hides the toggle when rlpBscView=false even though the outlet-type labels exist (flag-gated, not label/slug)', async () => {
    setupFetch(false); // flag OFF, but OUTLET_TYPES_WITH_OVERRIDES labels still present + slug bajaj
    render(<SalesDashboardPage />);
    await screen.findByText('My Outlets');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/sales/me'), expect.anything()),
    );
    expect(screen.queryByTestId('rlp-bsc-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-comparison-card')).not.toBeInTheDocument();
  });

  it('BT3: Trade comparison card shows for SO but not for XSR (SO-and-above gate)', async () => {
    setupFetch(true);
    const { unmount } = render(<SalesDashboardPage />);
    await screen.findByTestId('rlp-bsc-toggle');
    expect(await screen.findByTestId('trade-comparison-card')).toBeInTheDocument();
    unmount();

    // XSR is a leaf (hasTeamView false) → the card must NOT render.
    localStorage.setItem('loyaltybase_sales_role', 'XSR');
    render(<SalesDashboardPage />);
    await screen.findByTestId('rlp-bsc-toggle');
    expect(screen.queryByTestId('trade-comparison-card')).not.toBeInTheDocument();
  });

  it('BT5: the default (RLP) view shows the SSS-scoped targets, never the unscoped combined totals', async () => {
    setupFetch(true);
    render(<SalesDashboardPage />);
    await screen.findByTestId('rlp-bsc-toggle');
    // Target Achievement card must render the SSS-scoped KPI name, not the combined one.
    // (findAll/queryAll — the KPI name appears in the card, the chart option, and the caption.)
    expect((await screen.findAllByText(/RLP Primary/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Combined Primary/)).toHaveLength(0);
    // Every /sales/targets request carried outletType (single scoped owner) — no unscoped request.
    const targetCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/sales/targets'));
    expect(targetCalls.length).toBeGreaterThan(0);
    expect(targetCalls.every((u) => u.includes('outletType=SSS'))).toBe(true);
  });

  it('BT6: a non-toggle tenant (flag off) issues exactly ONE no-param /sales/targets request', async () => {
    setupFetch(false);
    render(<SalesDashboardPage />);
    await screen.findAllByText(/Combined Primary/); // the unscoped (no-param) result rendered
    const targetCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/sales/targets'));
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]).not.toContain('outletType');
  });

  it('BT7: keeps the toggle HIDDEN while /api/sales/me is still loading (no flash)', async () => {
    // /api/sales/me never resolves → featuresLoading stays true → DEFAULT flag (false) → no toggle.
    setupFetch(true, new Promise(() => {}));
    render(<SalesDashboardPage />);
    await screen.findByText('My Outlets');
    expect(screen.queryByTestId('rlp-bsc-toggle')).not.toBeInTheDocument();
  });
});
