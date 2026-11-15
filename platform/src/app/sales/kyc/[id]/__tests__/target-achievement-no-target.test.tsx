/// <reference types="vitest/globals" />
/**
 * TAN — Sales outlet-detail Target Achievement card: KPIs with NO target this month (owner 2026-11-15).
 *
 * A KPI with sales but no target (Bajaj SAMT's NON ADHO eligibility gate) used to render "2,755.12 /–"
 * with a red "0%" pill (and a red 0% bar when it was the primary). It now renders a neutral grey
 * "₹2.8K so far" — no "/–", no pill, no bar; no sales data → "—". Targeted KPIs render exactly as before.
 *
 * TAN1: target-less grid KPIs → "so far" / "—" / negative; targeted primary + grid KPIs unchanged.
 * TAN2: a target-less PRIMARY KPI → neutral "so far" row, no red 0% pill or bar.
 * TAN-OFF: partnerDashboardV2 OFF (Deoleo) → the original "x /– · 0%" rendering, unchanged.
 *
 * Gated on the tenant flag `partnerDashboardV2`, read from the authenticated /sales/me features.
 */

import React, { Suspense, act } from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { GifsySettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/lib/gifsy-settings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'XSR', hasTeamView: () => false }));

let mockSettings: GifsySettings = DEFAULT_SETTINGS;
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/gifsy-settings');
  return { ...actual, useGifsySettings: () => mockSettings };
});

import SalesKYCDetailPage from '../page';

const SUBMISSION = {
  id: 'KYC42',
  status: 'APPROVED',
  submittedAt: '2026-05-01T00:00:00.000Z',
  rejectionReason: null,
  user: { id: 'u1', name: 'Anil XSR', phone: '9900000011', role: 'SALES_XSR' },
  partner: {
    id: 'p1', businessName: 'Mehta Distributors', ownerName: 'Mehta',
    address: '12 Market Rd', city: 'Pune', state: 'Maharashtra',
    outlets: [{ id: 'OUT9', name: 'Mehta Distributors', outletCode: 'W123', phone: '9900000011',
      city: 'Pune', state: 'Maharashtra', pincode: '411001', outletType: { code: 'SSS' } }],
  },
  documents: [],
  statusHistory: [],
};

type Col = { code: string; name: string; unit: string; isPrimary: boolean };
type Val = { target: number | null; achieved: number | null; pace: number | null };

function stubFetch(kpiColumns: Col[], kpis: Record<string, Val>, v2 = true) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/sales/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { features: { partnerDashboardV2: v2 } } }) });
    }
    if (url.startsWith('/api/kyc/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { submission: SUBMISSION } }) });
    }
    if (url.includes('/api/sales/outlet-targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true,
        data: { kpiColumns, rows: [{ outletCode: 'W123', kpis }] },
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function renderPage() {
  const params = Promise.resolve({ id: 'KYC42' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

beforeEach(() => { mockSettings = DEFAULT_SETTINGS; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('TAN — Target Achievement card, target-less KPIs', () => {
  it('TAN1: target-less grid KPIs show "so far" / "—"; targeted KPIs unchanged', async () => {
    stubFetch(
      [
        { code: 'MONTH',   name: 'Month Target', unit: 'cases', isPrimary: true },
        { code: 'NONADHO', name: 'NON ADHO',     unit: 'INR',   isPrimary: false },
        { code: 'FB',      name: 'Focus Brand',  unit: 'INR',   isPrimary: false },
        { code: 'NEG',     name: 'Returns',      unit: 'INR',   isPrimary: false },
        { code: 'LINES',   name: 'Lines',        unit: 'SKU',   isPrimary: false },
      ],
      {
        MONTH:   { target: 1000, achieved: 500,     pace: 0.5 },
        NONADHO: { target: null, achieved: 2755.12, pace: null },
        FB:      { target: 0,    achieved: null,    pace: null },
        NEG:     { target: null, achieved: -1500,   pace: null },
        LINES:   { target: 8,    achieved: 7,       pace: 0.875 },
      },
    );
    await renderPage();

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);

    const nonAdho = inCard.getByTestId('kpi-no-target-NONADHO');
    expect(within(nonAdho).getByText('₹2.8K so far')).toBeInTheDocument();
    expect(nonAdho.textContent).not.toMatch(/%|\/–|2,755\.12/);
    expect(within(inCard.getByTestId('kpi-no-target-FB')).getByText('—')).toBeInTheDocument();
    expect(inCard.getByTestId('kpi-no-target-FB').textContent).not.toMatch(/%/);
    expect(within(inCard.getByTestId('kpi-no-target-NEG')).getByText('-₹1.5K so far')).toBeInTheDocument();

    // Targeted primary + grid KPI exactly as before.
    expect(inCard.getByText('50%')).toBeInTheDocument();
    expect(inCard.getByText('/1,000 cases', { exact: false })).toBeInTheDocument();
    expect(inCard.getByText('88%')).toBeInTheDocument();
    expect(inCard.getByText('/8', { exact: false })).toBeInTheDocument();
    // Exactly two % pills: the two targeted KPIs. No red "0%" for the target-less ones.
    expect(inCard.getAllByText(/^\d+%$/)).toHaveLength(2);
    expect(inCard.queryByText('0%')).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/NaN|Infinity/);
  }, 20000);

  it('TAN2: a target-less flagged-primary KPI → headline is the first TARGETED KPI (same as the partner side); NON ADHO shows as neutral "so far"', async () => {
    stubFetch(
      [
        { code: 'NONADHO', name: 'NON ADHO', unit: 'INR', isPrimary: true },
        { code: 'LINES',   name: 'Lines',    unit: 'SKU', isPrimary: false },
      ],
      {
        NONADHO: { target: 0, achieved: 2755.12, pace: null },
        LINES:   { target: 8, achieved: 4,       pace: 0.5 },
      },
    );
    await renderPage();

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);
    // NON ADHO (flagged primary but no target) is shown neutrally, never as a red 0%.
    expect(inCard.getByText('NON ADHO')).toBeInTheDocument();
    expect(inCard.getByText('₹2.8K so far')).toBeInTheDocument();
    expect(inCard.queryByText('0%')).not.toBeInTheDocument();
    // The headline is the targeted Lines KPI with its percentage.
    expect(inCard.getByText('Lines')).toBeInTheDocument();
    expect(inCard.getAllByText(/50%/).length).toBeGreaterThan(0);
  }, 20000);

  it('TAN-OFF: flag OFF (Deoleo) → target-less KPIs keep the original "x /– · 0%" rendering', async () => {
    stubFetch(
      [
        { code: 'NONADHO', name: 'NON ADHO', unit: 'INR', isPrimary: true },
        { code: 'FB',      name: 'Focus',    unit: 'INR', isPrimary: false },
        { code: 'LINES',   name: 'Lines',    unit: 'SKU', isPrimary: false },
      ],
      {
        NONADHO: { target: null, achieved: 2755.12, pace: null },
        FB:      { target: 0,    achieved: 400,     pace: null },
        LINES:   { target: 8,    achieved: 4,       pace: 0.5 },
      },
      false,
    );
    await renderPage();

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);
    expect(inCard.queryByTestId('kpi-no-target-NONADHO')).not.toBeInTheDocument();
    expect(inCard.queryByTestId('kpi-no-target-FB')).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/so far/);
    // Primary: raw "2,755.12 /– INR" + 0% pill + bar, exactly as before.
    expect(inCard.getByText('2,755.12', { exact: false })).toBeInTheDocument();
    expect(inCard.getByText('/– INR', { exact: false })).toBeInTheDocument();
    expect(card.querySelector('.h-1\\.5')).not.toBeNull();
    // Grid: FB "400 /0 · 0%", LINES "4 /8 · 50%" → pills 0% (primary), 0% (FB), 50%.
    expect(inCard.getByText('/0', { exact: false })).toBeInTheDocument();
    expect(inCard.getAllByText('0%')).toHaveLength(2);
    expect(inCard.getByText('50%')).toBeInTheDocument();
  }, 20000);
});
