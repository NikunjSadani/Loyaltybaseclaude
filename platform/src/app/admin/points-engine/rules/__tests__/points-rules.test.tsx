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
});
