/// <reference types="vitest/globals" />
/**
 * Version coverage gap (owner trap 2026-11-26): "Edit as new version" defaulted Effective from to TODAY, so the new
 * version of a monthly rule from 01-11 started 26-11 and 1–25 Nov had no rule once v1 was archived on publish.
 *
 *  - VG1: Edit as new version pre-fills effectiveFrom from the SOURCE version (not today)
 *  - VG2: a draft v2 starting after the published v1 shows the gap warning with both dates; same date → no warning
 *  - VG3: publish → 412 VERSION_GAP → confirm → re-publish with confirmGap; cancel → not published, says why
 *  - VG4: Duplicate keeps the source effective dates
 *  - VG5: versionGapWarning picks the PUBLISHED earlier version
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PointsRuleRow } from '@/lib/points-engine/types';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ id: 'r2' }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'CLIENT_ADMIN' }) }));
vi.mock('@/lib/points-engine/api', () => ({
  listRules: vi.fn(),
  getRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  publishRule: vi.fn(),
  archiveRule: vi.fn(),
  renameRule: vi.fn(),
  simulate: vi.fn(),
}));

import * as api from '@/lib/points-engine/api';
import { RuleBuilder } from '../_components/RuleBuilder';
import { duplicateDraft, versionGapWarning } from '../_components/kit';

const listRules = vi.mocked(api.listRules);
const getRule = vi.mocked(api.getRule);
const createRule = vi.mocked(api.createRule);
const publishRule = vi.mocked(api.publishRule);

function makeRow(over: Partial<PointsRuleRow> = {}): PointsRuleRow {
  return {
    id: 'r1', ruleId: 'rule_x', name: 'Unnati – ADHO 2.5%', clientId: 'bajaj', version: 1, status: 'published',
    effectiveFrom: '2026-11-01', effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'UNNATI', programCategory: null, kpiCode: 'ADHO' },
    output: { awardType: 'POINTS', fieldId: 'cf' }, rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'ADHO', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2.5 }],
    kpiCode: 'ADHO', program: 'UNNATI', programCategory: null, createdAt: '2026-11-01', updatedAt: '2026-11-01',
    ...over,
  };
}
const V1 = makeRow();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: [] }) })));
  vi.mocked(api.simulate).mockResolvedValue({ success: true, data: { valid: true, errors: [] } });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Version coverage gap', () => {
  it('VG1: Edit as new version pre-fills effectiveFrom from the source version (not today)', async () => {
    listRules.mockResolvedValue({ success: true, data: [V1] });
    getRule.mockResolvedValue({ success: true, data: V1 });
    createRule.mockResolvedValue({ success: true, data: makeRow({ id: 'r2', version: 2, status: 'draft' }) });
    render(<RuleBuilder ruleId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /edit as new version/i }));
    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(1));
    expect(createRule.mock.calls[0][0]).toMatchObject({ ruleId: 'rule_x', effectiveFrom: '2026-11-01' });
    expect(createRule.mock.calls[0][0].name).toBeUndefined();
  });

  it('VG2: a draft v2 that starts after v1 shows the gap warning; moving it back clears it', async () => {
    const v2 = makeRow({ id: 'r2', version: 2, status: 'draft', effectiveFrom: '2026-11-26' });
    listRules.mockResolvedValue({ success: true, data: [V1, v2] });
    getRule.mockResolvedValue({ success: true, data: v2 });
    render(<RuleBuilder ruleId="r2" />);
    expect(
      await screen.findByText(/Version 1 covered from 01-11-2026; this version starts 26-11-2026 — periods in between will have no rule/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('2026-11-26'), { target: { value: '2026-11-01' } });
    expect(screen.queryByText(/periods in between will have no rule/)).not.toBeInTheDocument();
  });

  it('VG3: publish → 412 VERSION_GAP → confirm → re-published with confirmGap', async () => {
    const v2 = makeRow({ id: 'r2', version: 2, status: 'draft', effectiveFrom: '2026-11-26' });
    listRules.mockResolvedValue({ success: true, data: [V1, v2] });
    getRule.mockResolvedValue({ success: true, data: v2 });
    const gapMsg = 'Version 1 covered from 01-11-2026; this version starts 26-11-2026 — periods in between will have no rule.';
    publishRule
      .mockResolvedValueOnce({ success: false, status: 412, error: gapMsg })
      .mockResolvedValueOnce({ success: true, data: { ...v2, status: 'published' } });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RuleBuilder ruleId="r2" />);
    fireEvent.click(await screen.findByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(publishRule).toHaveBeenCalledTimes(2));
    expect(confirmSpy.mock.calls[0][0]).toContain(gapMsg);
    expect(publishRule.mock.calls[0]).toEqual(['r2']);
    expect(publishRule.mock.calls[1]).toEqual(['r2', { confirmGap: true }]);
  });

  it('VG3b: cancelling the gap confirmation does not publish and says why', async () => {
    const v2 = makeRow({ id: 'r2', version: 2, status: 'draft', effectiveFrom: '2026-11-26' });
    listRules.mockResolvedValue({ success: true, data: [V1, v2] });
    getRule.mockResolvedValue({ success: true, data: v2 });
    publishRule.mockResolvedValueOnce({ success: false, status: 412, error: 'Version 1 covered from 01-11-2026; gap.' });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RuleBuilder ruleId="r2" />);
    fireEvent.click(await screen.findByRole('button', { name: /^publish$/i }));
    expect(await screen.findByText(/Not published — Version 1 covered from 01-11-2026/)).toBeInTheDocument();
    expect(publishRule).toHaveBeenCalledTimes(1);
  });

  it('VG4: Duplicate keeps the source effective dates', () => {
    const d = duplicateDraft(makeRow({ effectiveFrom: '2026-11-01', effectiveTo: '2027-03-31' }));
    expect(d.effectiveFrom).toBe('2026-11-01');
    expect(d.effectiveTo).toBe('2027-03-31');
  });

  it('VG5: versionGapWarning compares with the PUBLISHED earlier version; no warning on the same/earlier date', () => {
    const sibs = [
      { version: 1, status: 'archived' as const, effectiveFrom: '2026-10-01' },
      { version: 2, status: 'published' as const, effectiveFrom: '2026-11-01' },
    ];
    expect(versionGapWarning('2026-11-26', 3, sibs)).toMatch(/^Version 2 covered from 01-11-2026; this version starts 26-11-2026/);
    expect(versionGapWarning('2026-11-01', 3, sibs)).toBeNull();
    expect(versionGapWarning('2026-10-15', 3, sibs)).toBeNull();
    expect(versionGapWarning('2026-11-26', 1, sibs)).toBeNull();
  });
});
