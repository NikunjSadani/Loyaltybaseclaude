/// <reference types="vitest/globals" />
/**
 * PTN — Partner Targets page: KPIs with NO target + multi-outlet aggregation (owner 2026-11-15).
 *
 * Every new behaviour is gated on the tenant flag `partnerDashboardV2` (Bajaj), read from the
 * authenticated /partner/me features. Flag OFF (Deoleo) must render exactly as before.
 *
 * Flag ON:
 *   PTN1: target-less KPI with sales → "₹2.8K so far"; null achieved → "—"; negative → "-₹1.5K so far";
 *         non-INR → "12.3 cases so far"; no % on those cards; targeted card unchanged.
 *   PTN2: "targets hit" counts ONLY targeted KPIs.
 *   PTN3: only target-less KPIs → neutral note + "so far" card, no scored hero.
 *   PTN4: multi-outlet table formats a target-less cell like the card (₹2.8K); targeted cells unchanged.
 *   PTN5: sales at an outlet WITHOUT the target do not inflate the % (separate "+₹2K so far" line).
 *   PTN6: negative untargeted amount (returns) → no "+X" line.
 *   PTN7: a PAST month never says "this month" / "so far".
 * Flag OFF (Deoleo byte-identical):
 *   PTN-OFF1: mixed outlets → plain sums (250%), no extra line; target-less KPIs hidden; raw table cells.
 *   PTN-OFF2: only target-less KPIs → the old "No targets configured" empty state.
 * All tenants:
 *   PTN-TBL: multi-outlet table columns = union of KPI codes, cells looked up by code ("—" when absent).
 *   PTN-INR: ParamCard "Achieved/Target" shows ₹ + Indian grouping + whole rupees for INR; other units unchanged.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { istDateKey } from '@/lib/ist-date';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import PartnerTargetsPage from '../page';

type Kpi = { code: string; name?: string; target: number | null; achieved: number | null; pace: number | null; unit?: string; isPrimary?: boolean };
type Outlet = { outletCode: string; outletName: string; outletType: string; kpis: Kpi[] };

// Date-relative: the current IST month (live, "so far") and the previous one (closed).
const CUR = istDateKey(new Date()).slice(0, 7);
const PREV = (() => {
  const [y, m] = CUR.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

function stub(outlets: Outlet[], opts: { v2?: boolean; period?: string } = {}) {
  const v2 = opts.v2 ?? true;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/partner/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { features: { partnerDashboardV2: v2 } } }) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { period: opts.period ?? CUR, outlets } }),
    });
  }));
}

const outlet = (kpis: Kpi[], code = 'OUT-001', name = 'Kumar General Store') =>
  ({ outletCode: code, outletName: name, outletType: 'RETAILER', kpis });

// Outlet A: SALES target ₹1,000 / sales ₹500. Outlet B: NO SALES target, sales ₹2,000. LINES targeted at both.
const MIXED: Outlet[] = [
  outlet([
    { code: 'SALES', name: 'Monthly Sales', target: 1000, achieved: 500, pace: 0.5, unit: 'INR', isPrimary: true },
    { code: 'LINES', name: 'Lines',         target: 4,    achieved: 4,   pace: 1,   unit: 'SKU' },
  ], 'OUT-A', 'Shah Stores A'),
  outlet([
    { code: 'SALES', name: 'Monthly Sales', target: null, achieved: 2000, pace: null, unit: 'INR', isPrimary: true },
    { code: 'LINES', name: 'Lines',         target: 4,    achieved: 1,    pace: 0.25, unit: 'SKU' },
  ], 'OUT-B', 'Shah Stores B'),
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('PTN — partnerDashboardV2 ON', () => {
  it('PTN1: target-less KPIs render a neutral "so far" figure; targeted KPI unchanged', async () => {
    stub([outlet([
      { code: 'MONTH',   name: 'Month Target', target: 800,  achieved: 400,     pace: 0.5, unit: 'cases', isPrimary: true },
      { code: 'NONADHO', name: 'NON ADHO',     target: null, achieved: 2755.12, pace: null, unit: 'INR' },
      { code: 'FB',      name: 'Focus Brand',  target: 0,    achieved: null,    pace: null, unit: 'INR' },
      { code: 'NEG',     name: 'Returns',      target: null, achieved: -1500,   pace: null, unit: 'INR' },
      { code: 'VOL',     name: 'Volume',       target: 0,    achieved: 12.34,   pace: null, unit: 'cases' },
    ])]);
    render(<PartnerTargetsPage />);

    const nonAdho = await screen.findByTestId('kpi-no-target-NONADHO', {}, { timeout: 15000 });
    expect(within(nonAdho).getByText('NON ADHO')).toBeInTheDocument();
    expect(within(nonAdho).getByText('No target this month')).toHaveClass('text-gray-500');
    expect(within(nonAdho).getByText('₹2.8K so far')).toBeInTheDocument();
    expect(within(nonAdho).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-no-target-FB')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-no-target-NEG')).getByText('-₹1.5K so far')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-no-target-VOL')).getByText('12.3 cases so far')).toBeInTheDocument();
    for (const id of ['NONADHO', 'FB', 'NEG', 'VOL']) {
      const c = screen.getByTestId(`kpi-no-target-${id}`);
      expect(c.textContent).not.toMatch(/%|On track|to go|Target achieved|NaN|Infinity/);
    }

    // Targeted card exactly as before: 50% pill + "Achieved: 400 cases / Target: 800 cases".
    expect(screen.getAllByText('50%').length).toBeGreaterThan(0);
    expect(screen.getByText('400 cases')).toBeInTheDocument();
    expect(screen.getByText('800 cases')).toBeInTheDocument();
    // Hero "0/1 targets hit" — the four target-less KPIs are not in the denominator.
    expect(screen.getByText('/1')).toBeInTheDocument();
    expect(screen.queryByText('/5')).not.toBeInTheDocument();
    expect(screen.getByText('targets hit this month')).toBeInTheDocument();
  }, 20000);

  it('PTN2: "targets hit" counts only targeted KPIs', async () => {
    stub([outlet([
      { code: 'MONTH',   name: 'Month Target', target: 100,  achieved: 150, pace: 1.5, unit: 'cases', isPrimary: true },
      { code: 'NONADHO', name: 'NON ADHO',     target: null, achieved: 400, pace: null, unit: 'INR' },
    ])]);
    render(<PartnerTargetsPage />);

    await screen.findByTestId('kpi-no-target-NONADHO', {}, { timeout: 15000 });
    expect(screen.getByText('/1')).toBeInTheDocument();
    expect(screen.queryByText('/2')).not.toBeInTheDocument();
    expect(screen.getByText(/All targets achieved!/)).toBeInTheDocument();
    expect(screen.getByText('₹400 so far')).toBeInTheDocument();
  }, 20000);

  it('PTN3: only target-less KPIs → neutral note + "so far" card, no scored hero', async () => {
    stub([outlet([
      { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, pace: null, unit: 'INR', isPrimary: true },
    ])]);
    render(<PartnerTargetsPage />);

    const note = await screen.findByTestId('no-targets-note', {}, { timeout: 15000 });
    expect(note).toHaveTextContent(/No targets set for .*Your sales so far are shown below\./);
    expect(screen.getByText('₹2.8K so far')).toBeInTheDocument();
    expect(screen.queryByText('targets hit this month')).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  }, 20000);

  it('PTN4: multi-outlet table formats a target-less cell like the card; targeted cells unchanged', async () => {
    stub([
      outlet([
        { code: 'MONTH',   name: 'Month Target', target: 400,  achieved: 200,     pace: 0.5, unit: 'cases', isPrimary: true },
        { code: 'NONADHO', name: 'NON ADHO',     target: null, achieved: 2755.12, pace: null, unit: 'INR' },
      ]),
      outlet([
        { code: 'MONTH',   name: 'Month Target', target: 400,  achieved: 300,  pace: 0.75, unit: 'cases', isPrimary: true },
        { code: 'NONADHO', name: 'NON ADHO',     target: null, achieved: null, pace: null, unit: 'INR' },
      ], 'OUT-002', 'Singh Traders'),
    ]);
    render(<PartnerTargetsPage />);

    const row1 = (await screen.findByText('Kumar General Store', {}, { timeout: 15000 })).closest('tr')!;
    expect(within(row1).getByText('₹2.8K')).toBeInTheDocument();
    expect(within(row1).getByText('200')).toBeInTheDocument();
    expect(within(row1).getByText('(50%)')).toBeInTheDocument();
    const row2 = screen.getByText('Singh Traders').closest('tr')!;
    expect(within(row2).getByText('—')).toBeInTheDocument();
    expect(within(row2).getByText('300')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-no-target-NONADHO')).getByText('₹2.8K so far')).toBeInTheDocument();
    // Both outlets have the MONTH target → plain sum exactly as before (500/800 = 63%), no extra line.
    expect(screen.getByText('500 cases')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-untargeted-extra-MONTH')).not.toBeInTheDocument();
  }, 20000);

  it('PTN5 (Mr Shah): sales at an outlet WITHOUT the target do not inflate the % — shown as a separate neutral line', async () => {
    stub(MIXED);
    render(<PartnerTargetsPage />);

    const extra = await screen.findByTestId('kpi-untargeted-extra-SALES', {}, { timeout: 15000 });
    expect(extra).toHaveTextContent('+₹2K so far at outlets without this target');
    // Scored figure = Outlet A only: ₹500 / ₹1,000 = 50% (NOT 2,500 / 1,000 = 250%).
    expect(screen.getByText('₹500')).toBeInTheDocument();
    expect(screen.getByText('₹1,000')).toBeInTheDocument();
    expect(screen.getAllByText('50%').length).toBeGreaterThan(0);
    expect(screen.queryByText('250%')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-untargeted-extra-LINES')).not.toBeInTheDocument();
    // "targets hit" uses targeted-only figures: SALES 50%, LINES 63% → 0/2.
    expect(screen.getByText('targets hit this month').previousElementSibling?.textContent).toBe('0/2');
    expect(screen.queryByTestId('kpi-no-target-SALES')).not.toBeInTheDocument();
  }, 20000);

  it('PTN6: a NEGATIVE untargeted amount (net returns) shows no "+X" line', async () => {
    stub([
      outlet([{ code: 'SALES', name: 'Monthly Sales', target: 1000, achieved: 500, pace: 0.5, unit: 'INR', isPrimary: true }], 'OUT-A', 'A'),
      outlet([{ code: 'SALES', name: 'Monthly Sales', target: null, achieved: -800, pace: null, unit: 'INR', isPrimary: true }], 'OUT-B', 'B'),
    ]);
    render(<PartnerTargetsPage />);

    await screen.findByText('₹500', {}, { timeout: 15000 });
    expect(screen.queryByTestId('kpi-untargeted-extra-SALES')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/outlets without this target/);
  }, 20000);

  it('PTN7: a PAST month never says "this month" / "so far" on the no-target pieces', async () => {
    stub([
      ...MIXED,
      outlet([{ code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, pace: null, unit: 'INR' }], 'OUT-C', 'C'),
    ], { period: PREV });
    render(<PartnerTargetsPage />);

    const card = await screen.findByTestId('kpi-no-target-NONADHO', {}, { timeout: 15000 });
    expect(card).toHaveTextContent(/No target for /);
    expect(within(card).getByText('₹2.8K')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/this month|so far/);
    expect(screen.getByTestId('kpi-untargeted-extra-SALES')).toHaveTextContent(/^\+₹2K at outlets without this target$/);
  }, 20000);
});

describe('PTN-OFF — partnerDashboardV2 OFF (Deoleo: unchanged)', () => {
  it('PTN-OFF1: mixed outlets → plain sums, no extra line; target-less KPI hidden; raw table cells', async () => {
    stub([
      ...MIXED.map((o, i) => i === 0
        ? { ...o, kpis: [...o.kpis, { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, pace: null, unit: 'INR' }] }
        : o),
    ], { v2: false });
    render(<PartnerTargetsPage />);

    await screen.findByText('Shah Stores A', {}, { timeout: 15000 });
    // Plain sum across BOTH outlets: ₹2,500 of ₹1,000 = 250% (the pre-change behaviour).
    expect(screen.getByText('₹2,500')).toBeInTheDocument();
    expect(screen.getByText('₹1,000')).toBeInTheDocument();
    expect(screen.getAllByText('250%').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('kpi-untargeted-extra-SALES')).not.toBeInTheDocument();
    // Target-less KPI is filtered out (no "so far" card) as before.
    expect(screen.queryByTestId('kpi-no-target-NONADHO')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/so far/);
    // Table: raw achieved values, no compact ₹ / so-far formatting.
    const rowA = screen.getByText('Shah Stores A').closest('tr')!;
    expect(within(rowA).getByText('2755.12')).toBeInTheDocument();
    const rowB = screen.getByText('Shah Stores B').closest('tr')!;
    expect(within(rowB).getByText('2000')).toBeInTheDocument();
    expect(screen.getByText('targets hit this month').previousElementSibling?.textContent).toBe('1/2');
  }, 20000);

  it('PTN-OFF2: only target-less KPIs → the old "No targets configured" empty state', async () => {
    stub([outlet([
      { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, pace: null, unit: 'INR', isPrimary: true },
    ])], { v2: false });
    render(<PartnerTargetsPage />);

    expect(await screen.findByText(/No targets configured for/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByTestId('no-targets-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-no-target-NONADHO')).not.toBeInTheDocument();
  }, 20000);
});

describe('PTN — all tenants (flag-independent)', () => {
  for (const v2 of [false, true]) {
    it(`PTN-TBL (${v2 ? 'v2' : 'flag OFF'}): table header = union of KPI codes; each cell under its own header; "—" when absent`, async () => {
      // Outlet 1 has A, B; outlet 2 has B, C (different order + a KPI the first lacks).
      stub([
        outlet([
          { code: 'A', name: 'Alpha', target: 10, achieved: 5, pace: 0.5, unit: 'cases', isPrimary: true },
          { code: 'B', name: 'Beta',  target: 20, achieved: 7, pace: 0.3, unit: 'cases' },
        ], 'O1', 'First Shop'),
        outlet([
          { code: 'C', name: 'Gamma', target: 30, achieved: 9,  pace: 0.3, unit: 'cases' },
          { code: 'B', name: 'Beta',  target: 20, achieved: 11, pace: 0.5, unit: 'cases' },
        ], 'O2', 'Second Shop'),
      ], { v2 });
      render(<PartnerTargetsPage />);

      const row1 = (await screen.findByText('First Shop', {}, { timeout: 15000 })).closest('tr')!;
      const table = row1.closest('table')!;
      const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent);
      expect(headers).toEqual(['Outlet', 'Type', 'Alpha', 'Beta', 'Gamma']);
      const cells = (tr: Element) => Array.from(tr.querySelectorAll('td')).slice(2).map(td => td.textContent);
      expect(cells(row1)).toEqual(['5(50%)', '7(35%)', '—']);
      const row2 = screen.getByText('Second Shop').closest('tr')!;
      expect(cells(row2)).toEqual(['—', '11(55%)', '9(30%)']);
    }, 20000);
  }

  it('PTN-INR: INR ParamCard shows ₹ + Indian grouping + whole rupees; non-INR card unchanged (flag OFF)', async () => {
    stub([outlet([
      { code: 'SALES', name: 'Monthly Sales', target: 10000,  achieved: 10414.4, pace: 1,   unit: 'INR', isPrimary: true },
      { code: 'BIG',   name: 'Big Sales',     target: 250000, achieved: -1500.2, pace: 0,   unit: 'INR' },
      { code: 'LINES', name: 'Lines',         target: 8,      achieved: 4,       pace: 0.5, unit: 'SKU' },
    ])], { v2: false });
    render(<PartnerTargetsPage />);

    expect(await screen.findByText('₹10,414', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText('₹10,000')).toBeInTheDocument();
    expect(screen.getByText('₹2,50,000')).toBeInTheDocument();
    expect(screen.getByText('-₹1,500')).toBeInTheDocument();
    expect(screen.queryByText('10414.4 INR')).not.toBeInTheDocument();
    expect(screen.queryByText('10000 INR')).not.toBeInTheDocument();
    // Non-INR unit: raw "<n> <unit>" exactly as before.
    expect(screen.getByText('4 SKU')).toBeInTheDocument();
    expect(screen.getByText('8 SKU')).toBeInTheDocument();
  }, 20000);
});
