/// <reference types="vitest/globals" />
/**
 * Points Engine — QUARTERLY rules in the builder (owner-approved 2026-11-25).
 *  - Q1: a quarterly rule's inputs offer "Which month of the quarter" (quarter total / month 1–3); no visibility source.
 *  - Q2: the simulator asks for 3 months per KPI and sends evaluationBasis QUARTER + context.months.
 *  - Q3: a monthly rule is unchanged (no month picker, no months sent, no evaluationBasis sent).
 *  - Q4: draftIssues — month on a monthly rule / visibility on a quarterly rule are blocked.
 *  - Q5: FY-quarter key helpers.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { RuleConfigDraft, RuleInput } from '@/lib/points-engine/types';
import { parseQuarterKey, quarterKeyForMonth } from '@/lib/points-engine/types';

vi.mock('@/lib/points-engine/api', () => ({ simulate: vi.fn() }));

import * as api from '@/lib/points-engine/api';
import { InputsCard } from '../_components/InputsCard';
import { SimulatorPanel } from '../_components/SimulatorPanel';
import { draftIssues } from '../_components/kit';

const simulate = vi.mocked(api.simulate);

const BSC: RuleConfigDraft = {
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
  evaluationBasis: 'QUARTER',
  attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'BSC_CASES' },
  output: { awardType: 'POINTS', fieldId: 'cf', narration: 'Consistency bonus' },
  rounding: { mode: 'half_up', scale: 0 },
  inputs: [
    { ref: 'tot_ach_m1', source: 'achievement:TOTAL', month: 1, type: 'number', nullAs: 'reject' },
    { ref: 'tot_tgt_m1', source: 'target:TOTAL', month: 1, type: 'number', nullAs: 'reject' },
    { ref: 'cases_q', source: 'achievement:BSC_CASES', type: 'number', nullAs: 'reject' },
  ],
  pipeline: [{ type: 'formula', id: 'f', output: 'add', expr: '5 * cases_q * min(1, 1.2 * tot_tgt_m1 / tot_ach_m1)' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  simulate.mockResolvedValue({ success: true, data: { valid: true, errors: [], outcome: { status: 'OK', points: 0, trace: [] } } } as never);
});

describe('InputsCard — quarterly', () => {
  it('Q1: month picker (quarter total / month 1–3); visibility not offered', () => {
    let latest: RuleInput[] = [{ ref: 'a', source: 'achievement:TOTAL', type: 'number', nullAs: 'reject' }];
    const onChange = vi.fn((n: RuleInput[]) => { latest = n; });
    render(<InputsCard inputs={latest} onChange={onChange} quarterly />);
    const pick = screen.getByLabelText('Which month of the quarter') as HTMLSelectElement;
    expect(pick.value).toBe('Q');
    expect([...pick.options].map((o) => o.textContent)).toEqual([
      'Quarter total (sum of 3 months)', 'Month 1 of the quarter', 'Month 2 of the quarter', 'Month 3 of the quarter',
    ]);
    fireEvent.change(pick, { target: { value: '2' } });
    expect(latest[0].month).toBe(2);
    const source = screen.getByLabelText('Source') as HTMLSelectElement;
    expect([...source.options].map((o) => o.value)).not.toContain('visibility');
    expect(screen.getByTestId('quarter-inputs-help')).toBeTruthy();
  });

  it('Q3a: a monthly rule shows no month picker', () => {
    render(<InputsCard inputs={[{ ref: 'a', kpiCode: 'TOTAL', type: 'number', nullAs: 'reject' }]} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Which month of the quarter')).toBeNull();
  });
});

describe('SimulatorPanel — quarterly', () => {
  it('Q2: asks for 3 months per KPI and sends evaluationBasis QUARTER + months', async () => {
    render(<SimulatorPanel draft={BSC} />);
    expect(screen.getByTestId('sim-quarter-months')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Achievement · TOTAL · Month 2'), { target: { value: '1600' } });
    fireEvent.change(screen.getByLabelText('Achievement · BSC_CASES · Month 3'), { target: { value: '30' } });
    await waitFor(() => {
      const last = simulate.mock.calls.at(-1)?.[0];
      expect(last?.evaluationBasis).toBe('QUARTER');
      expect(last?.context.months).toHaveLength(3);
      expect(last?.context.months?.[1].achievements).toEqual({ TOTAL: 1600, BSC_CASES: null });
      expect(last?.context.months?.[2].achievements).toEqual({ TOTAL: null, BSC_CASES: 30 });
      expect(last?.context.months?.[0].targets).toEqual({ TOTAL: null });
    });
  });

  it('Q3b: a monthly rule sends no months and no evaluationBasis (unchanged request)', async () => {
    render(<SimulatorPanel draft={{ ...BSC, evaluationBasis: 'PERIOD_AGGREGATE', inputs: [{ ref: 'v', kpiCode: 'TOTAL', type: 'number', nullAs: 'reject' }], pipeline: [] }} />);
    await waitFor(() => expect(simulate).toHaveBeenCalled());
    const body = simulate.mock.calls[0][0];
    expect(body.evaluationBasis).toBeUndefined();
    expect(body.context.months).toBeUndefined();
    expect(screen.queryByTestId('sim-quarter-months')).toBeNull();
  });
});

describe('draftIssues + helpers — quarterly', () => {
  it('Q4: month on a monthly rule and visibility on a quarterly rule are blocked; the BSC draft is clean', () => {
    expect(draftIssues(BSC).blocking).toEqual([]);
    expect(draftIssues({ ...BSC, evaluationBasis: 'PERIOD_AGGREGATE' }).blocking.join(' ')).toMatch(/only for quarterly rules/);
    expect(
      draftIssues({ ...BSC, inputs: [...BSC.inputs, { ref: 'vis', source: 'visibility:approved', type: 'number', nullAs: 'reject' }] }).blocking.join(' '),
    ).toMatch(/visibility is monthly/);
  });

  it('Q5: FY quarter keys name the real months', () => {
    expect(parseQuarterKey('2026-Q3')).toMatchObject({ label: 'Oct–Dec 2026', fyLabel: 'Q3 FY2026-27', months: ['2026-10', '2026-11', '2026-12'] });
    expect(parseQuarterKey('2026-Q4')?.label).toBe('Jan–Mar 2027');
    expect(parseQuarterKey('2026-11')).toBeNull();
    expect(quarterKeyForMonth('2027-01')).toBe('2026-Q4');
    expect(quarterKeyForMonth('2026-07')).toBe('2026-Q2');
  });
});
