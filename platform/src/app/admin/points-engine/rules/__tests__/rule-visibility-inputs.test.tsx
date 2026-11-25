/// <reference types="vitest/globals" />
/**
 * Points Engine — VISIBILITY (POSM) inputs in the rule builder (design §3a, owner decision 2026-11-25).
 *  - V1: the input picker offers "Visibility (POSM) this month" with the plain labels; picking it makes a
 *        NUMBER input bound to `visibility:approved` (and can switch to approvedWindows).
 *  - V2: the simulator asks for the visibility test values the rule reads, sends them, and shows the values used.
 *  - V3: draftIssues mirrors validateRule for visibility inputs.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { RuleConfigDraft, RuleInput, SimulateResult } from '@/lib/points-engine/types';

vi.mock('@/lib/points-engine/api', () => ({ simulate: vi.fn() }));

import * as api from '@/lib/points-engine/api';
import { InputsCard } from '../_components/InputsCard';
import { SimulatorPanel } from '../_components/SimulatorPanel';
import { draftIssues } from '../_components/kit';

const simulate = vi.mocked(api.simulate);

const UNNATI: RuleConfigDraft = {
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  evaluationBasis: 'PERIOD_AGGREGATE',
  attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'TOTAL' },
  output: { awardType: 'PAYOUT', fieldId: 'cf_vis' },
  rounding: { mode: 'half_up', scale: 0 },
  inputs: [
    { ref: 'TOTAL', kpiCode: 'TOTAL', type: 'number', nullAs: 'zero' },
    { ref: 'visApproved', source: 'visibility:approved', type: 'number', nullAs: 'reject' },
    { ref: 'metro', source: 'segment:metro', type: 'enum', nullAs: 'reject', values: ['Metro', 'Non Metro'] },
  ],
  pipeline: [
    { type: 'formula', id: 'f1', expr: "if(visApproved == 1 && TOTAL >= 4000, if(metro == 'Metro', 500, 250), 0)", output: 'set' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InputsCard — visibility source', () => {
  it('V1: offers the visibility source with plain labels and binds a NUMBER visibility:approved input', () => {
    let latest: RuleInput[] = [{ ref: 'vis', kpiCode: '', type: 'enum', nullAs: 'reject', values: ['x'] }];
    const onChange = vi.fn((next: RuleInput[]) => {
      latest = next;
    });
    const { rerender } = render(<InputsCard inputs={latest} onChange={onChange} />);

    const source = screen.getByLabelText('Source') as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toContain('Visibility (POSM) this month');
    fireEvent.change(source, { target: { value: 'visibility' } });
    expect(latest[0]).toMatchObject({ ref: 'vis', source: 'visibility:approved', type: 'number' });
    expect(latest[0].kpiCode).toBeUndefined();
    expect(latest[0].values).toBeUndefined();

    rerender(<InputsCard inputs={latest} onChange={onChange} />);
    const which = screen.getByLabelText('Visibility value') as HTMLSelectElement;
    expect([...which.options].map((o) => o.textContent)).toEqual([
      'Visibility approved this month (1/0)',
      'Approved visibility windows this month',
      'Visibility windows in the month',
    ]);
    // Visibility values are always numbers → the type picker is locked.
    expect((screen.getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
    // Help text explains the approval rule in plain words.
    expect(screen.getByText(/A window counts only when its/)).toBeTruthy();

    fireEvent.change(which, { target: { value: 'approvedWindows' } });
    expect(latest[0].source).toBe('visibility:approvedWindows');
  });
});

describe('SimulatorPanel — visibility test values', () => {
  it('V2: asks for the visibility value the rule reads, sends it, and lists the value used', async () => {
    const res: SimulateResult = {
      valid: true,
      errors: [],
      outcome: { status: 'OK', points: 250, trace: [] },
      visibilityUsed: [{ ref: 'visApproved', source: 'visibility:approved', value: 1 }],
    };
    simulate.mockResolvedValue({ success: true, data: res } as never);
    render(<SimulatorPanel draft={UNNATI} />);

    const field = screen.getByLabelText('Visibility approved this month (1/0)');
    // Only the referenced visibility value is asked for.
    expect(screen.queryByLabelText('Approved visibility windows this month')).toBeNull();
    fireEvent.change(field, { target: { value: '1' } });

    await waitFor(() => {
      const last = simulate.mock.calls.at(-1)?.[0];
      expect(last?.context.visibility).toEqual({ approved: 1 });
    });
    expect(await screen.findByTestId('sim-visibility-used')).toBeTruthy();
    expect(screen.getByText(/visApproved \(Visibility approved this month \(1\/0\)\) = 1/)).toBeTruthy();
  });

  it('V2b: a rule without visibility inputs sends no visibility context', async () => {
    simulate.mockResolvedValue({ success: true, data: { valid: true, errors: [], outcome: { status: 'OK', points: 0, trace: [] } } } as never);
    render(<SimulatorPanel draft={{ ...UNNATI, inputs: [UNNATI.inputs[0]], pipeline: [] }} />);
    await waitFor(() => expect(simulate).toHaveBeenCalled());
    expect(simulate.mock.calls[0][0].context.visibility).toBeUndefined();
    expect(screen.queryByLabelText('Visibility approved this month (1/0)')).toBeNull();
  });
});

describe('draftIssues — visibility inputs', () => {
  it('V3: accepts the Unnati rule; blocks an unknown visibility key or a non-number visibility input', () => {
    expect(draftIssues(UNNATI).blocking).toEqual([]);
    const bad = draftIssues({
      ...UNNATI,
      inputs: [
        { ref: 'a', source: 'visibility:approvd', type: 'number', nullAs: 'reject' },
        { ref: 'b', source: 'visibility:approved', type: 'enum', nullAs: 'reject', values: ['1'] },
      ],
      pipeline: [],
    }).blocking.join(' ');
    expect(bad).toMatch(/pick which visibility value/);
    expect(bad).toMatch(/visibility input must be a Number/);
  });
});
