/// <reference types="vitest/globals" />
/**
 * Points Engine — rule list + builder + simulator tests.
 *
 * The api module is fully mocked (no network). Coverage:
 *  - PR1: the list renders rows from listRules()
 *  - PR2: a status filter re-queries listRules with that status
 *  - PR3: the builder renders its cards and "Add step" adds a Rate node
 *  - PR4: the simulator renders the points from a mocked OK outcome
 *  - PR5: the simulator lists config errors from a valid:false result
 *  - PR6: Publish surfaces a 409 conflict inline
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PointsRuleRow, RuleConfigDraft, SimulateResult } from '@/lib/points-engine/types';

// ── mocks ─────────────────────────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ id: 'rule_1' }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/points-engine/api', () => ({
  listRules: vi.fn(),
  getRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  publishRule: vi.fn(),
  archiveRule: vi.fn(),
  simulate: vi.fn(),
}));

import * as api from '@/lib/points-engine/api';
import PointsRulesPage from '../page';
import { RuleBuilder } from '../_components/RuleBuilder';
import { SimulatorPanel } from '../_components/SimulatorPanel';
import { draftIssues, formulaVarRefs } from '../_components/kit';

const listRules = vi.mocked(api.listRules);
const getRule = vi.mocked(api.getRule);
const publishRule = vi.mocked(api.publishRule);
const simulate = vi.mocked(api.simulate);

function makeRow(over: Partial<PointsRuleRow> = {}): PointsRuleRow {
  return {
    id: 'r1',
    ruleId: 'rule_cases',
    clientId: 'deoleo',
    version: 1,
    status: 'draft',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' },
    output: { awardType: 'POINTS', fieldId: 'cf_q3' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
    pipeline: [],
    kpiCode: 'CASES_SOLD',
    program: 'GOLD',
    programCategory: null,
    createdAt: '2026-07-01',
    updatedAt: '2026-07-02',
    ...over,
  };
}

const OK_SIM: SimulateResult = {
  valid: true,
  errors: [],
  outcome: {
    status: 'OK',
    points: 1300,
    trace: [{ nodeId: 'n1', type: 'rate', detail: 'rate "n1": 650 × 2 → +1300', pointsBefore: 0, delta: 1300, pointsAfter: 1300 }],
  },
};

const SAMPLE_DRAFT: RuleConfigDraft = {
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  evaluationBasis: 'PERIOD_AGGREGATE',
  attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'CASES_SOLD' },
  output: { awardType: 'POINTS', fieldId: 'cf_q3' },
  rounding: { mode: 'half_up', scale: 0 },
  inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
  pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }],
};

beforeEach(() => {
  simulate.mockResolvedValue({ success: true, data: OK_SIM });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('Points rule list', () => {
  it('PR1: renders rows from listRules()', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow(), makeRow({ id: 'r2', ruleId: 'rule_litres', status: 'published' })] });
    render(<PointsRulesPage />);
    expect(await screen.findByText('rule_cases')).toBeInTheDocument();
    expect(screen.getByText('rule_litres')).toBeInTheDocument();
  });

  it('PR2: a status filter re-queries listRules with that status', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow({ status: 'published' })] });
    render(<PointsRulesPage />);
    await screen.findByText('rule_cases');

    fireEvent.click(screen.getByRole('button', { name: /published/i }));

    await waitFor(() =>
      expect(listRules).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'published' })),
    );
  });
});

describe('Rule builder', () => {
  it('PR3: renders its cards and "Add step" adds a Rate node', async () => {
    render(<RuleBuilder ruleId="new" />);

    expect(screen.getByText('Attachment')).toBeInTheDocument();
    expect(screen.getByText('Point pipeline')).toBeInTheDocument();
    expect(screen.getByText('No steps yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByText('Rate')); // the menu item

    expect(await screen.findByText('1. Rate')).toBeInTheDocument();
    expect(screen.queryByText('No steps yet')).not.toBeInTheDocument();
  });
});

describe('Live simulator', () => {
  it('PR4: renders the points from a mocked OK outcome', async () => {
    simulate.mockResolvedValue({ success: true, data: OK_SIM });
    render(<SimulatorPanel draft={SAMPLE_DRAFT} />);
    // "Points awarded" + the trace detail are locale-independent (the big number uses toLocaleString).
    expect(await screen.findByText('Points awarded')).toBeInTheDocument();
    expect(screen.getByText(/650 × 2/)).toBeInTheDocument();
  });

  it('PR5: lists config errors from a valid:false result', async () => {
    simulate.mockResolvedValue({
      success: true,
      data: { valid: false, errors: ['pipeline[0]: rate must be a finite number.'], outcome: undefined },
    });
    render(<SimulatorPanel draft={SAMPLE_DRAFT} />);
    expect(await screen.findByText(/rate must be a finite number/)).toBeInTheDocument();
    expect(screen.getByText(/not yet valid/i)).toBeInTheDocument();
  });
});

describe('Publish lifecycle', () => {
  it('PR6: surfaces a 409 conflict inline', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow({ id: 'rule_1', status: 'draft' }) });
    publishRule.mockResolvedValue({ success: false, error: 'overlaps rule_litres v2', status: 409 });

    render(<RuleBuilder ruleId="rule_1" />);

    // Wait for the draft to load (the Publish button only renders for an existing draft).
    const publishBtn = await screen.findByRole('button', { name: /publish/i });
    fireEvent.click(publishBtn);

    expect(await screen.findByText(/conflicting published rule/i)).toBeInTheDocument();
    expect(screen.getByText(/overlaps rule_litres v2/)).toBeInTheDocument();
  });

  it('PR7: editing a loaded draft blocks Publish until the changes are saved', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow({ id: 'rule_1', status: 'draft' }) });
    render(<RuleBuilder ruleId="rule_1" />);

    // Freshly loaded, unmodified → Publish is enabled, no "save first" hint.
    const publishBtn = await screen.findByRole('button', { name: /publish/i });
    expect(publishBtn).not.toBeDisabled();
    expect(screen.queryByText(/save your changes before publishing/i)).not.toBeInTheDocument();

    // Edit a field → dirty → Publish disabled + hint.
    fireEvent.change(screen.getByDisplayValue('cf_q3'), { target: { value: 'cf_q4' } });
    expect(await screen.findByText(/save your changes before publishing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /publish/i })).toBeDisabled();
  });
});

describe('Rule list tab counts', () => {
  it('PR8: a status-filtered view shows no misleading "(0)" on inactive tabs', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow({ status: 'published' })] });
    render(<PointsRulesPage />);
    await screen.findByText('rule_cases');

    fireEvent.click(screen.getByRole('button', { name: /^published/i }));
    await waitFor(() =>
      expect(listRules).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'published' })),
    );

    // The active (published) tab shows its real count; the inactive tabs show no "(0)".
    expect(screen.getByRole('button', { name: /published \(1\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /draft \(0\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archived \(0\)/i })).not.toBeInTheDocument();
  });
});

describe('draftIssues — audit validation parity with the backend', () => {
  const base = (over: Partial<RuleConfigDraft> = {}): RuleConfigDraft => ({
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'CASES_SOLD' },
    output: { awardType: 'POINTS', fieldId: 'cf' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
    pipeline: [],
    ...over,
  });

  it('blocks a duplicate input ref', () => {
    const { blocking } = draftIssues(
      base({
        inputs: [
          { ref: 'value', kpiCode: 'A', type: 'number', nullAs: 'reject' },
          { ref: 'value', kpiCode: 'B', type: 'number', nullAs: 'reject' },
        ],
      }),
    );
    expect(blocking.some((m) => /duplicate reference name/i.test(m))).toBe(true);
  });

  it('blocks an input with neither a KPI code nor a source', () => {
    const { blocking } = draftIssues(
      base({ inputs: [{ ref: 'x', type: 'number', nullAs: 'reject' }] }),
    );
    expect(blocking.some((m) => /exactly one source/i.test(m))).toBe(true);
  });

  it('blocks an enum/segment input with no allowed values', () => {
    const { blocking } = draftIssues(
      base({ inputs: [{ ref: 'seg', source: 'segment:program', type: 'enum', nullAs: 'reject' }] }),
    );
    expect(blocking.some((m) => /at least one allowed value/i.test(m))).toBe(true);
  });

  it('accepts an enum/segment input that lists values', () => {
    const { blocking } = draftIssues(
      base({ inputs: [{ ref: 'seg', source: 'segment:program', type: 'enum', nullAs: 'reject', values: ['GOLD'] }] }),
    );
    expect(blocking).toHaveLength(0);
  });

  it('blocks an inverted effective window', () => {
    const { blocking } = draftIssues(base({ effectiveFrom: '2026-07-01', effectiveTo: '2026-06-01' }));
    expect(blocking.some((m) => /on or after effective-from/i.test(m))).toBe(true);
  });

  it('blocks a formula that references an undeclared input', () => {
    const { blocking } = draftIssues(
      base({ pipeline: [{ type: 'formula', id: 'n1', expr: 'value + bonus', output: 'add' }] }),
    );
    expect(blocking.some((m) => /unknown input "bonus"/i.test(m))).toBe(true);
  });

  it('does not flag a formula whose vars are declared (functions are not vars)', () => {
    const { blocking } = draftIssues(
      base({ pipeline: [{ type: 'formula', id: 'n1', expr: 'max(value, 10)', output: 'add' }] }),
    );
    expect(blocking.some((m) => /unknown input/i.test(m))).toBe(false);
  });

  it('warns (not blocks) on a zero rate', () => {
    const { blocking, warnings } = draftIssues(
      base({ pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 0 }] }),
    );
    expect(blocking).toHaveLength(0);
    expect(warnings.some((m) => /rate of 0/i.test(m))).toBe(true);
  });

  it('warns when a gate\'s onFail would not withhold points', () => {
    const { warnings } = draftIssues(
      base({
        pipeline: [
          { type: 'gate', id: 'n1', when: { op: 'gte', left: { var: 'value' }, right: { lit: 0 } }, onFail: 'skipNode' },
        ],
      }),
    );
    expect(warnings.some((m) => /won't withhold/i.test(m))).toBe(true);
  });
});

describe('formulaVarRefs', () => {
  it('returns variable refs but not function names or string literals', () => {
    expect(formulaVarRefs("if(a > 2, b, 'c')")).toEqual(['a', 'b']);
    expect(formulaVarRefs('max(value, 10) + bonus')).toEqual(['value', 'bonus']);
  });
});
