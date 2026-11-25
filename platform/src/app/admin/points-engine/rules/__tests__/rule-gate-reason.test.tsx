/// <reference types="vitest/globals" />
/**
 * Points Engine — opt-in gate failReason / failAs in the builder + the simulator (owner-approved 2026-11-25).
 *  - G1: a gate card offers "Skip the row and flag it for review" and a reason field; both write the opt-in fields,
 *        and switching back to "Pay 0" drops failAs (default behaviour restored).
 *  - G2: the simulator shows the outcome reason under the points.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GateNode, PipelineNode, RuleConfigDraft } from '@/lib/points-engine/types';
import { draftIssues } from '../_components/kit';

vi.mock('@/lib/points-engine/api', () => ({ simulate: vi.fn() }));

import * as api from '@/lib/points-engine/api';
import { NodeCard } from '../_components/NodeCard';
import { SimulatorPanel } from '../_components/SimulatorPanel';

const simulate = vi.mocked(api.simulate);

beforeEach(() => vi.clearAllMocks());

const GATE: GateNode = { type: 'gate', id: 'g', when: { op: 'gt', left: { var: 'target' }, right: { lit: 0 } }, onFail: 'zero' };

describe('Gate card — reason + skip', () => {
  it('G1: writes failReason / failAs opt-in fields; Pay 0 restores the default', () => {
    let latest: PipelineNode = GATE;
    const onChange = vi.fn((n: PipelineNode) => {
      latest = n;
    });
    const props = {
      index: 0, total: 1, onMove: vi.fn(), onRemove: vi.fn(), onChange,
      inputs: [{ ref: 'target', source: 'target:ADHO', type: 'number' as const, nullAs: 'skipRule' as const }],
    };
    const { rerender } = render(<NodeCard node={latest} {...props} />);

    fireEvent.change(screen.getByLabelText('Reason shown when it fails (optional)'), { target: { value: 'Target is 0' } });
    expect(latest).toMatchObject({ failReason: 'Target is 0', onFail: 'zero' });
    rerender(<NodeCard node={latest} {...props} />);

    const sel = screen.getByLabelText('If the check fails') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toContain('Skip the row and flag it for review');
    fireEvent.change(sel, { target: { value: 'skip' } });
    expect(latest).toMatchObject({ failAs: 'skip', onFail: 'zero', failReason: 'Target is 0' });
    rerender(<NodeCard node={latest} {...props} />);

    // Back to Pay 0: the explicit failAs is KEPT ('zero'), never silently dropped; the select shows it.
    fireEvent.change(screen.getByLabelText('If the check fails'), { target: { value: 'zero' } });
    expect(latest).toMatchObject({ failAs: 'zero', onFail: 'zero', failReason: 'Target is 0' });
    rerender(<NodeCard node={latest} {...props} />);
    expect((screen.getByLabelText('If the check fails') as HTMLSelectElement).value).toBe('zero');
    fireEvent.change(screen.getByLabelText('Reason shown when it fails (optional)'), { target: { value: '' } });
    expect((latest as GateNode).failReason).toBeUndefined();
  });

  it('G1b: failAs zero on a legacy soft onFail shows "Pay 0" (the effective choice) and no soft option', () => {
    const node: GateNode = { ...GATE, onFail: 'skipNode', failAs: 'zero', failReason: 'Target is 0' };
    render(<NodeCard node={node} index={0} total={1} onMove={vi.fn()} onRemove={vi.fn()} onChange={vi.fn()} inputs={[]} />);
    const sel = screen.getByLabelText('If the check fails') as HTMLSelectElement;
    expect(sel.value).toBe('zero');
    expect([...sel.options].map((o) => o.value)).toEqual(['zero', 'skip']);
  });

  it('G1c: a soft gate disables the reason field and says why; an over-long reason is kept and flagged (not truncated)', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NodeCard node={{ ...GATE, onFail: 'skipNode' }} index={0} total={1} onMove={vi.fn()} onRemove={vi.fn()} onChange={onChange} inputs={[]} />,
    );
    expect((screen.getByLabelText('Reason shown when it fails (optional)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Only shown when the gate pays 0 or skips the row/)).toBeTruthy();

    const long = 'x'.repeat(205);
    rerender(<NodeCard node={{ ...GATE }} index={0} total={1} onMove={vi.fn()} onRemove={vi.fn()} onChange={onChange} inputs={[]} />);
    fireEvent.change(screen.getByLabelText('Reason shown when it fails (optional)'), { target: { value: long } });
    expect(onChange.mock.calls.at(-1)![0].failReason).toHaveLength(205); // never silently cut
    rerender(<NodeCard node={{ ...GATE, failReason: long }} index={0} total={1} onMove={vi.fn()} onRemove={vi.fn()} onChange={onChange} inputs={[]} />);
    expect(screen.getByTestId('fail-reason-too-long').textContent).toMatch(/205 characters — shorten it to 200/);
  });

  it('G3: draftIssues — failAs zero/skip never warns "won\'t withhold"; length / soft-gate reason / bad failAs block', () => {
    const draft = (g: Partial<GateNode>): RuleConfigDraft => ({
      effectiveFrom: '2026-11-01', effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
      attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'ADHO' },
      output: { awardType: 'POINTS', fieldId: 'cf' }, rounding: { mode: 'half_up', scale: 0 },
      inputs: [{ ref: 'target', source: 'target:ADHO', type: 'number', nullAs: 'skipRule' }],
      pipeline: [{ ...GATE, ...g }],
    });
    expect(draftIssues(draft({ onFail: 'skipNode', failAs: 'zero' })).warnings.join(' ')).not.toMatch(/won't withhold/);
    expect(draftIssues(draft({ onFail: 'skipNode', failAs: 'skip' })).warnings.join(' ')).not.toMatch(/won't withhold/);
    expect(draftIssues(draft({ onFail: 'skipNode' })).warnings.join(' ')).toMatch(/won't withhold/);
    expect(draftIssues(draft({ failReason: 'x'.repeat(201) })).blocking.join(' ')).toMatch(/201 characters — keep it to 200/);
    expect(draftIssues(draft({ onFail: 'skipNode', failReason: 'Target is 0' })).blocking.join(' ')).toMatch(/only shown when the gate pays 0/);
    expect(draftIssues(draft({ failAs: 'nope' as never })).blocking.join(' ')).toMatch(/choose what happens/);
    expect(draftIssues(draft({ failReason: 'Target is 0', failAs: 'zero' })).blocking).toEqual([]);
  });
});

describe('Simulator — reason', () => {
  it('G2: shows the reason of a 0-point outcome', async () => {
    simulate.mockResolvedValue({
      success: true,
      data: { valid: true, errors: [], outcome: { status: 'OK', points: 0, trace: [], reason: 'No ADHO target' } },
    } as never);
    const draft: RuleConfigDraft = {
      effectiveFrom: '2026-11-01', effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
      attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'ADHO' },
      output: { awardType: 'POINTS', fieldId: 'cf' }, rounding: { mode: 'half_up', scale: 0 },
      inputs: [{ ref: 'target', source: 'target:ADHO', type: 'number', nullAs: 'skipRule' }],
      pipeline: [GATE],
    };
    render(<SimulatorPanel draft={draft} />);
    expect((await screen.findByTestId('sim-reason')).textContent).toBe('Reason: No ADHO target');
  });
});
