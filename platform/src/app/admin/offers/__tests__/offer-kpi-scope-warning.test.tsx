/// <reference types="vitest/globals" />
/**
 * APPLIES-TO §6 — the offer form's non-blocking warning when the progress KPI's scope does not cover the tile's
 * audience (programs / outlet types). Unscoped KPIs (every tenant today, incl. Deoleo) never warn.
 * Run: npx vitest run src/app/admin/offers/__tests__/offer-kpi-scope-warning.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() } }));

import { OfferForm } from '../_components/offer-form';
import type { OfferKpiOption } from '@/lib/offers';

const KPIS: OfferKpiOption[] = [
  { code: 'ALL', label: 'All-outlet KPI', unit: 'cases' },
  { code: 'UNNATI_VOL', label: 'Unnati Volume', unit: 'cases',
    scope: { outletTypes: [], programs: ['Unnati'], subPrograms: [] } },
];

function renderForm() {
  render(
    <OfferForm open tile={null} month="2026-11"
      segmentOptions={{ programNames: ['Unnati', 'Pragati'], zones: [], states: [] }}
      outletTypes={[{ code: 'SSS', label: 'RLP' }] as never}
      kpis={KPIS} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
}

describe('offer form — KPI scope warning', () => {
  it('warns for audience values outside the KPI scope (partial vs none), never for an unscoped KPI', async () => {
    renderForm();
    const kpiSelect = await screen.findByLabelText(/Show this outlet.s progress on/);
    const programs = screen.getByTestId('target-programs');

    fireEvent.change(kpiSelect, { target: { value: 'ALL' } });
    fireEvent.click(within(programs).getByRole('checkbox', { name: 'Pragati' }));
    expect(screen.queryByTestId('offer-kpi-scope-warning')).not.toBeInTheDocument();

    fireEvent.change(kpiSelect, { target: { value: 'UNNATI_VOL' } });
    expect(screen.getByTestId('offer-kpi-scope-warning')).toHaveTextContent(/Unnati Volume doesn't apply to program Pragati, so outlets in this audience/);

    fireEvent.click(within(programs).getByRole('checkbox', { name: 'Unnati' }));
    expect(screen.getByTestId('offer-kpi-scope-warning')).toHaveTextContent(/so those outlets get no values for it/);

    fireEvent.click(within(programs).getByRole('checkbox', { name: 'Pragati' })); // only Unnati left → in scope
    expect(screen.queryByTestId('offer-kpi-scope-warning')).not.toBeInTheDocument();
  });
});
