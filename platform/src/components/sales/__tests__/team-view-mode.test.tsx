/**
 * TeamViewScreen — OVERVIEW (default) vs SINGLE KPI rendering.
 *
 * MV1: default (no kpi in URL) renders the all-KPI OVERVIEW grid + the score badge, "—" for null.
 * MV2: the backend's ascending order is preserved as returned.
 * MV3: choosing a specific KPI renders the compact SINGLE row (single % badge, no grid).
 * MV4: the KPI Pill lists "Overview" first, then the individual KPIs; default selection = Overview.
 * MV5: the request sends kpi=OVERVIEW when none is selected.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const replace = vi.fn();
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
  usePathname: () => '/sales/team',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import { TeamViewScreen } from '../team-view-screen';
import { OVERVIEW_KPI } from '@/lib/sales-team';

const KPIS = [
  { code: 'PRIMARY_SALES', label: 'Primary Sales' },
  { code: 'SECONDARY_SALES', label: 'Secondary Sales' },
];

const OVERVIEW_PAYLOAD = {
  mode: 'OVERVIEW' as const,
  member: null,
  kpis: KPIS,
  summary: { outlets: 30, kycDone: 20, kycPending: 10, avgScore: 55 },
  members: [
    // Deliberately ascending by score — must render as returned (worst first).
    {
      id: 'm-low', name: 'Zoe Low', roleLabel: 'ISR', employeeCode: 'E-001', mobile: '9000000001',
      teamSize: 0, outlets: 10, kycDone: 6, kycPending: 4,
      kpiPercents: { PRIMARY_SALES: 40, SECONDARY_SALES: null }, score: 40,
    },
    {
      id: 'm-high', name: 'Amy High', roleLabel: 'ISR', employeeCode: 'E-002', mobile: '9000000002',
      teamSize: 0, outlets: 20, kycDone: 14, kycPending: 6,
      kpiPercents: { PRIMARY_SALES: 90, SECONDARY_SALES: 110 }, score: 100,
    },
  ],
  filterOptions: { outletTypes: [], programs: [], kpis: KPIS },
};

const SINGLE_PAYLOAD = {
  mode: 'SINGLE' as const,
  member: null,
  summary: { outlets: 30, kycDone: 20, kycPending: 10, avgTargetPct: 72 },
  members: [
    {
      id: 'm-1', name: 'Zoe Low', employeeCode: 'E-001', mobile: '9000000001', role: 'ISR', roleLabel: 'ISR',
      teamSize: 0, outlets: 10, kycDone: 6, kycPending: 4,
      outletsAchieved: 2, outletsWithTarget: 5, achievedPct: 40,
    },
  ],
  filterOptions: { outletTypes: [], programs: [], kpis: KPIS },
  kpiCode: 'PRIMARY_SALES',
};

/** Stub fetch and capture every requested URL. */
function stubFetch(data: unknown) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
  }));
  return urls;
}

describe('TeamViewScreen — OVERVIEW vs SINGLE', () => {
  beforeEach(() => { currentSearch = ''; replace.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('MV1: default renders the all-KPI grid + score badge, "—" for a null KPI', async () => {
    stubFetch(OVERVIEW_PAYLOAD);
    render(<TeamViewScreen />);

    expect(await screen.findByText('Zoe Low')).toBeInTheDocument();
    expect(screen.getAllByText('Primary Sales').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Secondary Sales').length).toBeGreaterThan(0);
    // Score badge (40%) + a per-KPI value; null KPI shows an em dash.
    expect(screen.getAllByText('40%').length).toBeGreaterThan(0);
    expect(screen.getByText('—')).toBeInTheDocument(); // Zoe's SECONDARY_SALES is null
    // 4th summary card is "Avg Score" in overview.
    expect(screen.getByText('Avg Score')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.queryByText('Avg Target')).not.toBeInTheDocument();
  });

  it('MV2: ascending order is preserved as returned', async () => {
    stubFetch(OVERVIEW_PAYLOAD);
    render(<TeamViewScreen />);

    await screen.findByText('Zoe Low');
    const names = screen.getAllByText(/Low|High/).map((n) => n.textContent);
    expect(names).toEqual(['Zoe Low', 'Amy High']); // worst-first, unsorted by the component
  });

  it('MV3: choosing a specific KPI renders the compact SINGLE row (single %, no grid)', async () => {
    currentSearch = 'kpi=PRIMARY_SALES';
    stubFetch(SINGLE_PAYLOAD);
    render(<TeamViewScreen />);

    expect(await screen.findByText('Zoe Low')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('2/5 hit target')).toBeInTheDocument();
    // The all-KPI grid is absent → the only "Secondary Sales" text is the Pill <option>,
    // never a rendered grid cell (a <span>).
    const secondaryMatches = screen.queryAllByText('Secondary Sales');
    expect(secondaryMatches.every((el) => el.tagName === 'OPTION')).toBe(true);
    // 4th card is "Avg Target" in single mode.
    expect(screen.getByText('Avg Target')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('MV4: KPI Pill lists Overview first; default selection = Overview', async () => {
    stubFetch(OVERVIEW_PAYLOAD);
    render(<TeamViewScreen />);

    await screen.findByText('Zoe Low');
    const overviewOpt = screen.getByRole('option', { name: 'Overview' }) as HTMLOptionElement;
    const select = overviewOpt.closest('select') as HTMLSelectElement;
    expect(select.value).toBe(OVERVIEW_KPI);
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues[0]).toBe(OVERVIEW_KPI);
    expect(optionValues).toContain('PRIMARY_SALES');
  });

  it('MV5: the request sends kpi=OVERVIEW when none is selected', async () => {
    const urls = stubFetch(OVERVIEW_PAYLOAD);
    render(<TeamViewScreen />);
    await screen.findByText('Zoe Low');
    expect(urls.some((u) => u.includes(`kpi=${OVERVIEW_KPI}`))).toBe(true);
  });
});
