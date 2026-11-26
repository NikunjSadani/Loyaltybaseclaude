/// <reference types="vitest/globals" />
/**
 * Gate / Milestone conditions on an ENUM (text) input — prod bug 2026-11-26: the right-side "Value" box was a
 * number-only field, so "metro = Non Metro" could not be entered.
 *
 *  - EC1: left = enum input → the Value control is a DROPDOWN of that input's allowed values (text, not a number)
 *  - EC2: comparison ops are limited to = / ≠ for a text comparison; an ordering op is switched to =
 *  - EC3: a number literal against an enum is replaced by the first allowed value
 *  - EC4: number inputs keep the number box and all six ops (unchanged)
 *  - EC5: switching Input → Value on an enum comparison starts at the first allowed value (never 0)
 *  - EC6: draftIssues warns on enum comparisons that can never match (ordering op, number, unknown value)
 */

import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { Condition, Predicate, RuleConfigDraft } from '@/lib/points-engine/types';
import { PredicateBuilder } from '../_components/PredicateBuilder';
import { draftIssues, type VarOption } from '../_components/kit';

const VARS: VarOption[] = [
  { ref: 'value', type: 'number' },
  { ref: 'metro', type: 'enum', values: ['Metro', 'Non Metro', 'Yes', 'No'] },
];

function Harness({ initial, onState }: { initial: Predicate; onState: (p: Predicate) => void }) {
  const [p, setP] = useState<Predicate>(initial);
  return (
    <PredicateBuilder
      value={p}
      vars={VARS}
      onChange={(n) => {
        setP(n);
        onState(n);
      }}
    />
  );
}

function setup(initial: Predicate) {
  let last: Predicate = initial;
  render(<Harness initial={initial} onState={(p) => (last = p)} />);
  return () => last as Condition;
}

/** The three comboboxes of the single condition: [left kind, left var, op, right kind, right value]. */
const selects = () => screen.getAllByRole('combobox') as HTMLSelectElement[];

describe('Enum (text) conditions', () => {
  it('EC1 + EC2: an enum left side gets a value DROPDOWN and only = / ≠', () => {
    const state = setup({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Metro' } });
    const valueBox = screen.getByLabelText('Value for metro') as HTMLSelectElement;
    expect(valueBox.tagName).toBe('SELECT');
    expect([...valueBox.options].map((o) => o.value)).toEqual(['Metro', 'Non Metro', 'Yes', 'No']);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument(); // no number box

    fireEvent.change(valueBox, { target: { value: 'Non Metro' } });
    expect(state()).toEqual({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Non Metro' } });

    const opSelect = selects().find((s) => [...s.options].some((o) => o.value === 'neq'))!;
    expect([...opSelect.options].map((o) => o.value)).toEqual(['eq', 'neq']);
    fireEvent.change(opSelect, { target: { value: 'neq' } });
    expect(state().op).toBe('neq');
  });

  it('EC2b + EC3: picking an enum input on a ≥ 0 condition switches to = and the first allowed value', () => {
    const state = setup({ op: 'gte', left: { var: 'value' }, right: { lit: 0 } });
    // Left var select = the one listing input refs.
    const leftVar = selects().find((s) => [...s.options].some((o) => o.value === 'metro'))!;
    fireEvent.change(leftVar, { target: { value: 'metro' } });
    expect(state()).toEqual({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Metro' } });
    expect(screen.getByLabelText('Value for metro')).toHaveValue('Metro');
  });

  it('EC4: a number input keeps the number box and all six ops', () => {
    setup({ op: 'gte', left: { var: 'value' }, right: { lit: 100 } });
    expect(screen.getByRole('spinbutton')).toHaveValue(100);
    const opSelect = selects().find((s) => [...s.options].some((o) => o.value === 'gte'))!;
    expect(opSelect.options).toHaveLength(6);
  });

  it('EC5: switching the right side from Input to Value on an enum comparison starts at the first allowed value', () => {
    const state = setup({ op: 'eq', left: { var: 'metro' }, right: { var: 'value' } });
    const rightKind = selects().filter((s) => [...s.options].some((o) => o.value === 'lit'))[1];
    fireEvent.change(rightKind, { target: { value: 'lit' } });
    expect(state().right).toEqual({ lit: 'Metro' });
  });

  it('EC1b: a stored value outside the allowed list is shown and flagged (never silently replaced)', () => {
    setup({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Urban' } });
    expect(screen.getByLabelText('Value for metro')).toHaveValue('Urban');
    expect(screen.getByText('Urban (not an allowed value of metro)')).toBeInTheDocument();
  });

  it('EC6: draftIssues warns (non-blocking) on enum comparisons that can never match', () => {
    const draft = (when: Predicate): RuleConfigDraft => ({
      effectiveFrom: '2026-07-01',
      effectiveTo: null,
      evaluationBasis: 'PERIOD_AGGREGATE',
      attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'V' },
      output: { awardType: 'POINTS', fieldId: 'cf' },
      rounding: { mode: 'half_up', scale: 0 },
      inputs: [
        { ref: 'value', kpiCode: 'V', type: 'number', nullAs: 'reject' },
        { ref: 'metro', source: 'segment:metro', type: 'enum', values: ['Metro', 'Non Metro'], nullAs: 'reject' },
      ],
      pipeline: [
        { type: 'gate', id: 'g', when, onFail: 'zero' },
        { type: 'rate', id: 'r', measure: { var: 'value' }, rate: 1 },
      ],
    });
    const ok = draftIssues(draft({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Non Metro' } }));
    expect(ok.warnings.join(' ')).not.toMatch(/metro/);
    expect(ok.blocking).toEqual([]);

    const bad = draftIssues(draft({ op: 'gte', left: { var: 'metro' }, right: { lit: 0 } }));
    expect(bad.blocking).toEqual([]);
    expect(bad.warnings.join(' ')).toMatch(/use = or ≠/);
    expect(bad.warnings.join(' ')).toMatch(/compared with the number 0/);

    const unknown = draftIssues(draft({ op: 'eq', left: { var: 'metro' }, right: { lit: 'Urban' } }));
    expect(unknown.warnings.join(' ')).toMatch(/"Urban" is not an allowed value/);
  });
});
