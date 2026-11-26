/// <reference types="vitest/globals" />
/**
 * Points Engine — rule NAMES, credit-field NAMES, Rename and Duplicate (owner-approved 2026-11-26).
 *
 *  - RN1: the list shows the rule name as the title; an unnamed rule shows "Unnamed rule" + its ruleId
 *  - RN2: ruleId is shown small to Gifsy admins for NAMED rules too; a client admin sees only the name
 *  - RN3: OUTPUT FIELD shows the credit field NAME; a missing field is "<id> (field not found)", inactive "(inactive)"
 *  - RN4: Rename from the list calls renameRule for that row and updates every version shown; blank name is refused
 *  - RN5: a NEW rule cannot be saved without a name (clear blocking issue); naming it enables Save draft
 *  - RN6: a published rule's detail shows the name as the title + a Rename action (no "Edit as new version" needed)
 *  - RN7: Duplicate opens a NEW rule pre-filled ("<name> (copy)", fresh step ids, no ruleId); Save → createRule without ruleId
 *  - RN8: duplicate-name warning (allowed, non-blocking)
 *  - RN9: pure helpers (copyRuleName length cap, duplicateDraft deep-clone, creditFieldLabel)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PointsRuleRow } from '@/lib/points-engine/types';

const push = vi.hoisted(() => vi.fn());
const sessionRole = vi.hoisted(() => ({ role: 'CLIENT_ADMIN' as string }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: 'r1' }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: sessionRole.role }) }));
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
import PointsRulesPage from '../page';
import { RuleBuilder } from '../_components/RuleBuilder';
import { copyRuleName, creditFieldLabel, duplicateDraft, duplicateRuleNameWarning, RULE_NAME_MAX } from '../_components/kit';

const listRules = vi.mocked(api.listRules);
const getRule = vi.mocked(api.getRule);
const createRule = vi.mocked(api.createRule);
const renameRule = vi.mocked(api.renameRule);
const simulate = vi.mocked(api.simulate);

const FIELDS = [
  { id: 'cf_q3', name: 'Q3 Points', isActive: true },
  { id: 'cf_old', name: 'Old Bucket', isActive: false },
];

function makeRow(over: Partial<PointsRuleRow> = {}): PointsRuleRow {
  return {
    id: 'r1',
    ruleId: 'rule_b1c5e9fc',
    name: 'Unnati – ADHO 2.5%',
    clientId: 'bajaj',
    version: 1,
    status: 'published',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'UNNATI', programCategory: null, kpiCode: 'ADHO' },
    output: { awardType: 'POINTS', fieldId: 'cf_q3' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'ADHO', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2.5 }],
    kpiCode: 'ADHO',
    program: 'UNNATI',
    programCategory: null,
    createdAt: '2026-07-01',
    updatedAt: '2026-07-02',
    ...over,
  };
}

beforeEach(() => {
  sessionRole.role = 'CLIENT_ADMIN';
  simulate.mockResolvedValue({ success: true, data: { valid: true, errors: [] } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      json: async () =>
        String(url).includes('/credits/fields') ? { success: true, data: FIELDS } : { success: true, data: [] },
    })),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Rules list — names', () => {
  it('RN1: shows the name as the title; an unnamed rule shows "Unnamed rule" + its ruleId', async () => {
    listRules.mockResolvedValue({
      success: true,
      data: [makeRow(), makeRow({ id: 'r2', ruleId: 'rule_nameless', name: null })],
    });
    render(<PointsRulesPage />);
    expect(await screen.findByText('Unnati – ADHO 2.5%')).toBeInTheDocument();
    expect(screen.getByText('Unnamed rule')).toBeInTheDocument();
    expect(screen.getByText('rule_nameless')).toBeInTheDocument();
    // Client admin: a NAMED rule's ruleId is not shown.
    expect(screen.queryByText('rule_b1c5e9fc')).not.toBeInTheDocument();
  });

  it('RN2: a Gifsy admin also sees the ruleId (small) under a named rule', async () => {
    sessionRole.role = 'GIFSY_ADMIN';
    listRules.mockResolvedValue({ success: true, data: [makeRow()] });
    render(<PointsRulesPage />);
    expect(await screen.findByText('Unnati – ADHO 2.5%')).toBeInTheDocument();
    expect(screen.getByTestId('rule-id-small')).toHaveTextContent('rule_b1c5e9fc');
  });

  it('RN3: OUTPUT FIELD shows the credit field NAME; missing / inactive fields are flagged loudly', async () => {
    listRules.mockResolvedValue({
      success: true,
      data: [
        makeRow(),
        makeRow({ id: 'r2', ruleId: 'rule_2', name: 'Missing field rule', output: { awardType: 'POINTS', fieldId: 'cmwdhi9sz' } }),
        makeRow({ id: 'r3', ruleId: 'rule_3', name: 'Inactive field rule', output: { awardType: 'POINTS', fieldId: 'cf_old' } }),
      ],
    });
    render(<PointsRulesPage />);
    await waitFor(() => expect(screen.getByText('Q3 Points')).toBeInTheDocument());
    expect(screen.getByText('cmwdhi9sz (field not found)')).toBeInTheDocument();
    expect(screen.getByText('Old Bucket (inactive)')).toBeInTheDocument();
    // The raw id is never the whole cell for a resolvable field.
    const cells = screen.getAllByTestId('rule-output-field').map((c) => c.textContent);
    expect(cells).not.toContain('cf_q3');
  });

  it('RN4: Rename from the list calls renameRule for that row and updates every version shown', async () => {
    listRules.mockResolvedValue({
      success: true,
      data: [makeRow({ id: 'r1', version: 2, name: null }), makeRow({ id: 'r0', version: 1, status: 'archived', name: null })],
    });
    renameRule.mockResolvedValue({ success: true, data: makeRow({ id: 'r1', version: 2, name: 'Unnati – ADHO 2.5%' }) });
    render(<PointsRulesPage />);
    await screen.findAllByText('Unnamed rule');

    fireEvent.click(screen.getAllByRole('button', { name: /rename rule rule_b1c5e9fc/i })[0]);
    const panel = screen.getByTestId('rename-panel');
    const box = within(panel).getByLabelText('New rule name');

    // Blank → refused client-side, no call.
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(within(panel).getByRole('button', { name: /save name/i }));
    expect(renameRule).not.toHaveBeenCalled();
    expect(within(panel).getByRole('alert')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: '  Unnati –  ADHO 2.5%  ' } });
    fireEvent.click(within(panel).getByRole('button', { name: /save name/i }));
    await waitFor(() => expect(renameRule).toHaveBeenCalledWith('r1', 'Unnati – ADHO 2.5%'));
    // Both versions (same ruleId) now show the name; no navigation happened (row click not triggered).
    await waitFor(() => expect(screen.getAllByText('Unnati – ADHO 2.5%')).toHaveLength(2));
    expect(push.mock.calls).toEqual([]);
  });

  it('RN4b: "Remove name" on the list clears the name (null) for every version', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow({ id: 'r1' })] });
    renameRule.mockResolvedValue({ success: true, data: makeRow({ id: 'r1', name: null }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PointsRulesPage />);
    await screen.findByText('Unnati – ADHO 2.5%');
    fireEvent.click(screen.getByRole('button', { name: /rename rule rule_b1c5e9fc/i }));
    fireEvent.click(within(screen.getByTestId('rename-panel')).getByRole('button', { name: /remove name/i }));
    await waitFor(() => expect(renameRule).toHaveBeenCalledWith('r1', ''));
    expect(await screen.findByText('Unnamed rule')).toBeInTheDocument();
  });

  it('RN7a: Duplicate on the list opens the builder as a new rule from that row', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow()] });
    render(<PointsRulesPage />);
    await screen.findByText('Unnati – ADHO 2.5%');
    fireEvent.click(screen.getByRole('button', { name: /duplicate rule rule_b1c5e9fc/i }));
    expect(push).toHaveBeenCalledWith('/admin/points-engine/rules/new?from=r1');
  });
});

describe('Rules list — Program / Sub-programme / KPI columns', () => {
  const rows = () => [
    makeRow({ id: 'a', ruleId: 'ra', name: 'A', program: 'UNNATI', programCategory: null, kpiCode: 'ADHO', status: 'published' }),
    makeRow({ id: 'b', ruleId: 'rb', name: 'B', program: 'GOLD', programCategory: 'Tier A', kpiCode: 'CASES', status: 'draft' }),
    makeRow({ id: 'c', ruleId: 'rc', name: 'C', program: null, programCategory: 'Tier B', kpiCode: 'BSC', status: 'archived' }),
  ];

  it('RC1: three columns replace "Attachment"; blank program / sub-programme read "All"', async () => {
    listRules.mockResolvedValue({ success: true, data: rows() });
    render(<PointsRulesPage />);
    await screen.findByText('A');
    expect(screen.queryByText('Attachment')).not.toBeInTheDocument();
    for (const h of ['Program', 'Sub-programme', 'KPI', 'Status']) {
      expect(screen.getByRole('button', { name: `Sort by ${h}` })).toBeInTheDocument();
    }
    expect(screen.getAllByTestId('rule-program').map((c) => c.textContent)).toEqual(['UNNATI', 'GOLD', 'All (blank)']);
    expect(screen.getAllByTestId('rule-subprogram').map((c) => c.textContent)).toEqual(['All (blank)', 'Tier A', 'Tier B']);
    expect(screen.getAllByTestId('rule-kpi').map((c) => c.textContent)).toEqual(['ADHO', 'CASES', 'BSC']);
  });

  it('RC2: sort by Program / KPI / Status toggles asc ↔ desc', async () => {
    listRules.mockResolvedValue({ success: true, data: rows() });
    render(<PointsRulesPage />);
    await screen.findByText('A');
    const names = () => screen.getAllByTestId('rule-name').map((c) => c.textContent);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Program' }));
    expect(names()).toEqual(['C', 'B', 'A']); // All (blank), GOLD, UNNATI
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Program' }));
    expect(names()).toEqual(['C', 'A', 'B']); // blanks stay FIRST in descending order too
    fireEvent.click(screen.getByRole('button', { name: 'Sort by KPI' }));
    expect(names()).toEqual(['A', 'C', 'B']); // ADHO, BSC, CASES
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(names()).toEqual(['A', 'B', 'C']); // published, draft, archived
  });

  it('RC3: the sub-programme filter is a dropdown of the actual values + "All (blank)" (exact match, not text search)', async () => {
    listRules.mockResolvedValue({ success: true, data: rows() });
    render(<PointsRulesPage />);
    await screen.findByText('A');
    const sel = screen.getByLabelText('Filter by sub-programme') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Any sub-programme', 'All (blank)', 'Tier A', 'Tier B']);
    fireEvent.change(sel, { target: { value: 'Tier B' } });
    expect(screen.getAllByTestId('rule-name').map((c) => c.textContent)).toEqual(['C']);
    fireEvent.change(sel, { target: { value: '__blank__' } });
    expect(screen.getAllByTestId('rule-name').map((c) => c.textContent)).toEqual(['A']);
    fireEvent.change(sel, { target: { value: '' } });
    expect(screen.getAllByTestId('rule-name')).toHaveLength(3);
  });

  it('RC2b: sort by Sub-programme puts blanks first (labelled "All (blank)")', async () => {
    listRules.mockResolvedValue({ success: true, data: rows() });
    render(<PointsRulesPage />);
    await screen.findByText('A');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Sub-programme' }));
    expect(screen.getAllByTestId('rule-subprogram').map((c) => c.textContent)).toEqual(['All (blank)', 'Tier A', 'Tier B']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Sub-programme' }));
    expect(screen.getAllByTestId('rule-subprogram').map((c) => c.textContent)).toEqual(['All (blank)', 'Tier B', 'Tier A']);
  });

  it('RC4: the rule detail header shows program, sub-programme and KPI', async () => {
    listRules.mockResolvedValue({ success: true, data: [] });
    getRule.mockResolvedValue({
      success: true,
      data: makeRow({ attachsTo: { scope: 'program_kpi', program: 'UNNATI', programCategory: 'Tier A', kpiCode: 'ADHO' } }),
    });
    render(<RuleBuilder ruleId="r1" />);
    expect(await screen.findByTestId('rule-attachment-summary')).toHaveTextContent('Program UNNATI · Sub-programme Tier A · KPI ADHO');
  });
});

describe('Rule builder — names', () => {
  beforeEach(() => {
    listRules.mockResolvedValue({ success: true, data: [] });
  });

  it('RN5: a NEW rule cannot be saved without a name; naming it clears the issue', async () => {
    render(<RuleBuilder ruleId="new" />);
    expect(screen.getByLabelText('Rule name')).toHaveAttribute('placeholder', expect.stringContaining('Unnati'));
    expect(screen.getByText(/give the rule a name/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Unnati – ADHO 2.5%' } });
    expect(screen.queryByText(/give the rule a name/i)).not.toBeInTheDocument();
  });

  it('RN6: a published rule shows its name as the title, the field name, and Rename keeps the version', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow({ version: 3 }) });
    renameRule.mockResolvedValue({ success: true, data: makeRow({ version: 3, name: 'Renamed' }) });
    render(<RuleBuilder ruleId="r1" />);
    expect(await screen.findByTestId('rule-title')).toHaveTextContent('Unnati – ADHO 2.5%');
    await waitFor(() => expect(screen.getByTestId('rule-output-field')).toHaveTextContent('Q3 Points'));
    expect(screen.queryByTestId('rule-id-small')).not.toBeInTheDocument(); // client admin, named rule

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    fireEvent.change(screen.getByLabelText('New rule name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save name/i }));
    await waitFor(() => expect(renameRule).toHaveBeenCalledWith('r1', 'Renamed'));
    expect(await screen.findByTestId('rule-title')).toHaveTextContent('Renamed');
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(createRule).not.toHaveBeenCalled(); // no new version
  });

  it('RN6c: saving a draft sends `name` ONLY when the author changed it (no stale-tab overwrite)', async () => {
    const updateRule = vi.mocked(api.updateRule);
    getRule.mockResolvedValue({ success: true, data: makeRow({ status: 'draft', name: 'Loaded name' }) });
    updateRule.mockImplementation(async (_id, d) => ({ success: true, data: makeRow({ status: 'draft', name: d.name ?? 'Loaded name' }) }));
    render(<RuleBuilder ruleId="r1" />);
    await screen.findByTestId('rule-title');
    expect(screen.getByText(/renames EVERY version of this rule/i)).toBeInTheDocument();

    // Change something else only -> name not sent.
    fireEvent.change(screen.getByDisplayValue('2026-07-01'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRule).toHaveBeenCalledTimes(1));
    expect(updateRule.mock.calls[0][1].name).toBeUndefined();

    // Change the name -> sent.
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRule).toHaveBeenCalledTimes(2));
    expect(updateRule.mock.calls[1][1].name).toBe('New name');
  });

  it('RN6d: "Remove name" on a published rule clears it without a new version', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow({ version: 3 }) });
    renameRule.mockResolvedValue({ success: true, data: makeRow({ version: 3, name: null }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RuleBuilder ruleId="r1" />);
    await screen.findByTestId('rule-title');
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove name/i }));
    await waitFor(() => expect(renameRule).toHaveBeenCalledWith('r1', ''));
    expect(await screen.findByTestId('rule-title')).toHaveTextContent('Unnamed rule');
    expect(createRule).not.toHaveBeenCalled();
  });

  it('RN6b: an unnamed rule shows "Unnamed rule" + its ruleId; a missing output field is flagged', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow({ name: null, output: { awardType: 'POINTS', fieldId: 'cmwdhi9sz' } }) });
    render(<RuleBuilder ruleId="r1" />);
    expect(await screen.findByTestId('rule-title')).toHaveTextContent('Unnamed rule');
    expect(screen.getByTestId('rule-id-small')).toHaveTextContent('rule_b1c5e9fc');
    await waitFor(() => expect(screen.getByTestId('rule-output-field')).toHaveTextContent('cmwdhi9sz (field not found)'));
  });

  it('RN7: Duplicate pre-fills a NEW rule ("(copy)", fresh step ids, no ruleId) and saves via createRule only', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow() });
    createRule.mockResolvedValue({ success: true, data: makeRow({ id: 'r_new', ruleId: 'rule_new', status: 'draft' }) });
    render(<RuleBuilder ruleId="new" duplicateFromId="r1" />);
    expect(await screen.findByTestId('duplicate-banner')).toHaveTextContent(/original is unchanged/i);
    expect(screen.getByLabelText('Rule name')).toHaveValue('Unnati – ADHO 2.5% (copy)');
    expect(getRule).toHaveBeenCalledWith('r1');
    expect(createRule).not.toHaveBeenCalled(); // nothing saved until Save draft

    fireEvent.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(1));
    const sent = createRule.mock.calls[0][0];
    expect(sent.ruleId).toBeUndefined();
    expect(sent.name).toBe('Unnati – ADHO 2.5% (copy)');
    expect(sent.attachsTo).toEqual(makeRow().attachsTo);
    expect(sent.output).toEqual(makeRow().output);
    expect(sent.pipeline).toHaveLength(1);
    expect(sent.pipeline[0].id).not.toBe('n1');
    expect(sent.pipeline[0]).toMatchObject({ type: 'rate', rate: 2.5, measure: { var: 'value' } });
    expect(push).toHaveBeenCalledWith('/admin/points-engine/rules/r_new');
  });

  it('RN7b: Duplicate on a published rule detail navigates to the duplicate route', async () => {
    getRule.mockResolvedValue({ success: true, data: makeRow() });
    render(<RuleBuilder ruleId="r1" />);
    await screen.findByTestId('rule-title');
    fireEvent.click(screen.getByRole('button', { name: /duplicate rule/i }));
    expect(push).toHaveBeenCalledWith('/admin/points-engine/rules/new?from=r1');
  });

  it('RN8: a name already used by another rule warns but does not block', async () => {
    listRules.mockResolvedValue({ success: true, data: [makeRow({ ruleId: 'rule_other', name: 'Unnati – ADHO 2.5%' })] });
    render(<RuleBuilder ruleId="new" />);
    await waitFor(() => expect(listRules).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'unnati – adho 2.5%' } });
    expect(await screen.findByText(/another rule is already named/i)).toBeInTheDocument();
    expect(screen.queryByText(/give the rule a name/i)).not.toBeInTheDocument();
  });
});

describe('RN9: pure helpers', () => {
  it('copyRuleName appends (copy) and stays within the limit; unnamed → blank', () => {
    expect(copyRuleName('A')).toBe('A (copy)');
    expect(copyRuleName(null)).toBe('');
    const long = copyRuleName('x'.repeat(RULE_NAME_MAX));
    expect(long.length).toBeLessThanOrEqual(RULE_NAME_MAX);
    expect(long.endsWith(' (copy)')).toBe(true);
  });

  it('duplicateDraft deep-clones (editing the copy never mutates the source) and drops ruleId', () => {
    const src = makeRow();
    const d = duplicateDraft(src);
    expect(d.ruleId).toBeUndefined();
    (d.inputs[0] as { kpiCode?: string }).kpiCode = 'CHANGED';
    (d.attachsTo as { kpiCode: string }).kpiCode = 'CHANGED';
    expect(src.inputs[0].kpiCode).toBe('ADHO');
    expect(src.attachsTo.kpiCode).toBe('ADHO');
    expect(src.pipeline[0].id).toBe('n1');
  });

  it('creditFieldLabel resolves name / flags missing + inactive', () => {
    expect(creditFieldLabel('cf_q3', FIELDS)).toEqual({ label: 'Q3 Points', problem: null });
    expect(creditFieldLabel('zz', FIELDS)).toEqual({ label: 'zz (field not found)', problem: 'missing' });
    expect(creditFieldLabel('cf_old', FIELDS)).toEqual({ label: 'Old Bucket (inactive)', problem: 'inactive' });
  });

  it('duplicateRuleNameWarning ignores the same logical rule', () => {
    const rules = [{ ruleId: 'a', name: 'X' }];
    expect(duplicateRuleNameWarning('x', 'a', rules)).toBeNull();
    expect(duplicateRuleNameWarning('x', 'b', rules)).not.toBeNull();
  });
});
