/// <reference types="vitest/globals" />
/**
 * FOCUS-NAMES-FROM-KPI (owner 2026-11-25): a month with no focus names is NOT blocked; the borrowing cases KPI is left
 * empty behind a red warning the admin must tick (Apply / Recalculate).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/not-calculated-ack.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotCalculatedAck, notCalculatedMonths } from '../_components/not-calculated-ack';
import { reconciliationNeedsAttention } from '../_components/month-reconciliation-panel';
import { applyBlockers } from '@/lib/sales-import/format';
import { EMPTY_MONTH_RECONCILIATION, type MonthPreview } from '@/lib/sales-import/types';

afterEach(() => { cleanup(); });

const NC = [{ kpiCode: 'FB1 CASES', namesFromKpi: 'FOCUS BRAND', message: "No focus names in this month's target file — FB1 CASES not calculated." }];

describe('not-calculated KPIs (no focus names this month)', () => {
  it('shows the red warning and an explicit tick', () => {
    const onChange = vi.fn();
    render(<NotCalculatedAck month="2026-11" label="November 2026" items={NC} checked={false} onChange={onChange} />);
    const box = screen.getByTestId('not-calculated-2026-11');
    expect(box).toHaveAttribute('role', 'alert');
    expect(box).toHaveTextContent("No focus names in this month's target file — FB1 CASES not calculated.");
    expect(box).toHaveTextContent('left empty for November 2026 (no value, not 0)');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept that FB1 CASES is not calculated for November 2026' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders nothing without items; no tick for a viewer who cannot act', () => {
    const { container } = render(<NotCalculatedAck month="2026-11" label="November 2026" items={undefined} checked={false} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    render(<NotCalculatedAck month="2026-11" label="November 2026" items={NC} checked={false} onChange={vi.fn()} canAct={false} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('Apply is held until the tick; the month is listed for acknowledgeNotCalculatedMonths; it opens the month detail', () => {
    const m = {
      month: '2026-11', canApply: true, warnings: [], firstDate: '2026-11-01', lastDate: '2026-11-30',
      reconciliation: { ...EMPTY_MONTH_RECONCILIATION, notCalculated: NC },
    } as unknown as MonthPreview;
    const sel = new Set(['2026-11']);
    expect(applyBlockers([m], sel, new Set(), false)).toEqual(['Accept that FB1 CASES is not calculated for November 2026.']);
    expect(applyBlockers([m], sel, new Set(), false, new Set(['2026-11']))).toEqual([]);
    expect(notCalculatedMonths([m], sel)).toEqual(['2026-11']);
    expect(notCalculatedMonths([m], new Set())).toEqual([]);
    expect(reconciliationNeedsAttention(m.reconciliation)).toBe(true);
    expect(reconciliationNeedsAttention(EMPTY_MONTH_RECONCILIATION)).toBe(false);
  });
});
