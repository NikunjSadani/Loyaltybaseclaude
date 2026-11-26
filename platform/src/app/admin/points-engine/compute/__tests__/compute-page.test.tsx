/// <reference types="vitest/globals" />
/**
 * Points Engine — COMPUTE → PREVIEW → EXPORT / COMMIT screen.
 *  - PE-C1: running a preview renders the summary cards + an OK row + an ERROR row.
 *  - PE-C2: engineDisabled shows the amber "engine is disabled" banner.
 *  - PE-C3: the direct-credit block is hidden when the preview has no OK rows.
 *  - PE-C4: clicking "Credit in portal" calls commitCompute and renders the returned
 *           batchCode + the "review & confirm in Credits & Payouts" link.
 *  - PE-C11..C13: the Program + KPI filters are searchable dropdowns (options from
 *           outletPrograms + /api/admin/kpis); a selection drives the preview param; empty = no filter.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import ComputePage from '../page';
import {
  previewCompute,
  commitCompute,
  downloadExport,
  downloadPreviewReport,
  downloadPayoutReport,
} from '@/lib/points-engine/api';
import type { ComputePreview, ComputeCommitResult, ComputePreviewRow } from '@/lib/points-engine/types';
import { latestEndedQuarterKey } from '@/lib/points-engine/types';

vi.mock('@/lib/points-engine/api', () => ({
  previewCompute: vi.fn(),
  commitCompute: vi.fn(),
  downloadExport: vi.fn(),
  downloadPreviewReport: vi.fn(),
  downloadPayoutReport: vi.fn(),
}));

// next/link → a plain anchor so href is assertable.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

// Session role (the imported-months confirmation is Gifsy-admin only). Default: Gifsy admin.
const sessionRole = vi.hoisted(() => ({ role: 'GIFSY_ADMIN' as string }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: sessionRole.role }) }));

// Program options come from the tenant's configured programs (same source as the rule builder).
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => ({ outletPrograms: ['BSC', 'Unnati', 'SAMT'] }),
}));

const previewMock = previewCompute as unknown as ReturnType<typeof vi.fn>;
const commitMock = commitCompute as unknown as ReturnType<typeof vi.fn>;
const exportMock = downloadExport as unknown as ReturnType<typeof vi.fn>;
const reportMock = downloadPreviewReport as unknown as ReturnType<typeof vi.fn>;
const payoutReportMock = downloadPayoutReport as unknown as ReturnType<typeof vi.fn>;

/** A preview.visibility block (§3a) — defaults: available, nothing pending, no exceptions. */
function vis(over: Partial<NonNullable<ComputePreview['visibility']>> = {}): NonNullable<ComputePreview['visibility']> {
  return {
    month: '2026-10', mode: 'PHOTO_APPROVAL', available: true, windows: 2, openWindowsInMonth: 0,
    outletsApproved: 3, outletsWithData: 5, outletsWaitingReview: 0, outletsOpenWindow: 0, outletsPending: 0,
    countedOutsideDatedScope: 0, excluded: { olderFrequency: 0, notInProgramme: 0, notLive: 0 },
    waitingOutletCodes: [], openOutletCodes: [], pendingKey: '',
    ...over,
  };
}

function makePreview(over: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'deoleo',
    period: '2026-09',
    counts: { total: 2, ok: 1, skip: 0, error: 1, noRule: 0 },
    totalPoints: 1300,
    totalPayoutRupees: 0,
    engineDisabled: false,
    directCreditEnabled: true,
    sourceKey: 'deoleo|2026-09|cf_x|v7',
    payoutKey: 'pp_x',
    ruleVersionsUsed: [{ ruleId: 'rule_cases_q3', version: 7 }],
    rows: [
      {
        outletCode: 'OUT-001',
        outletName: 'Alpha Store',
        kpiCode: 'CASES_SOLD',
        status: 'OK',
        points: 1300,
        achievement: 120,
        target: 100,
        explanation: 'Gate passed → slab 100%+ → milestone +1000',
      },
      {
        outletCode: 'OUT-002',
        outletName: 'Beta Store',
        kpiCode: 'CASES_SOLD',
        status: 'ERROR',
        reason: 'Missing target value',
      },
    ],
    ...over,
  };
}

const COMMIT_RESULT: ComputeCommitResult = {
  batchId: 'b1',
  batchCode: 'PEB-2026-09-001',
  status: 'PENDING_CONFIRM',
  period: '2026-09',
  totalPoints: 1300,
  totalOutlets: 1,
  counts: { total: 2, ok: 1, skip: 0, error: 1, noRule: 0 },
  sourceKey: 'deoleo|2026-09|cf_x|v7',
  idempotentHit: false,
  priorBatchesThisPeriod: 0,
};

// KPI options are fetched from GET /api/admin/kpis (same source as the rule builder); one disabled KPI
// is included to prove `enabled === false` codes are filtered out.
const KPI_RESPONSE = {
  success: true,
  data: [
    { code: 'CASES_SOLD', enabled: true },
    { code: 'LITRES_SOLD', enabled: true },
    { code: 'DISABLED_KPI', enabled: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  previewMock.mockResolvedValue({ success: true, data: makePreview() });
  commitMock.mockResolvedValue({ success: true, data: COMMIT_RESULT });
  exportMock.mockResolvedValue({ kind: 'downloaded', fileName: 'points-credit-upload.xlsx' });
  reportMock.mockResolvedValue({ kind: 'downloaded', fileName: 'points-preview.xlsx' });
  payoutReportMock.mockResolvedValue({ kind: 'downloaded', fileName: 'points-payout-report.xlsx' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        typeof url === 'string' && url.includes('/api/admin/kpis')
          ? KPI_RESPONSE
          : { success: true, data: [] },
    })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A preview that mixes a POINTS OK row, a PAYOUT OK row, and (optionally) nothing else.
const PAYOUT_ROW: ComputePreviewRow = {
  outletCode: 'OUT-003',
  outletName: 'Gamma Store',
  kpiCode: 'CASES_SOLD',
  status: 'OK',
  awardType: 'PAYOUT',
  payoutRupees: 2500,
  achievement: 150,
  target: 100,
  explanation: 'Gate passed → slab 100%+ → ₹2,500',
};
const POINTS_ROW: ComputePreviewRow = {
  outletCode: 'OUT-001',
  outletName: 'Alpha Store',
  kpiCode: 'CASES_SOLD',
  status: 'OK',
  awardType: 'POINTS',
  points: 1300,
  achievement: 120,
  target: 100,
  explanation: 'Gate passed → slab 100%+ → milestone +1000',
};

async function runPreview() {
  fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
  await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(1));
}

describe('Points Engine compute page', () => {
  it('PE-C1: a preview renders the summary cards + an OK row + an ERROR row', async () => {
    render(<ComputePage />);
    await runPreview();

    // Summary cards (labels).
    expect(await screen.findByText('Total points')).toBeInTheDocument();
    expect(await screen.findByText('No rule')).toBeInTheDocument();
    // 1,300 appears in both the Total-points card and the OK row's points cell — assert presence, not uniqueness.
    expect((await screen.findAllByText('1,300')).length).toBeGreaterThan(0);

    // OK row (table) + ERROR row (panel).
    expect(await screen.findByTestId('group-OK')).toBeInTheDocument();
    expect(await screen.findByText('OUT-001')).toBeInTheDocument();
    expect(await screen.findByTestId('group-ERROR')).toBeInTheDocument();
    expect(await screen.findByText('OUT-002')).toBeInTheDocument();
    expect(await screen.findByText(/missing target value/i)).toBeInTheDocument();

    // Rule versions chip.
    expect(await screen.findByText('rule_cases_q3@7')).toBeInTheDocument();
  });

  it('PE-C1n: a NAMED rule shows its name on the rule-versions chip (ruleId on hover; small for Gifsy admins)', async () => {
    previewMock.mockResolvedValue({ success: true, data: makePreview({ ruleNames: { rule_cases_q3: 'Unnati – ADHO 2.5%' } }) });
    render(<ComputePage />);
    await runPreview();
    const chip = await screen.findByTestId('rule-version-chip');
    expect(chip).toHaveTextContent('Unnati – ADHO 2.5% v7');
    expect(chip).toHaveAttribute('title', 'rule_cases_q3@7');
    expect(chip).toHaveTextContent('rule_cases_q3'); // GIFSY_ADMIN session in this suite
  });

  it('PE-C2: engineDisabled shows the amber banner', async () => {
    previewMock.mockResolvedValue({ success: true, data: makePreview({ engineDisabled: true }) });
    render(<ComputePage />);
    await runPreview();

    expect(await screen.findByTestId('engine-disabled')).toBeInTheDocument();
    expect(await screen.findByText(/points engine is disabled for this tenant/i)).toBeInTheDocument();
    // No direct-credit affordance when the engine is disabled.
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
  });

  it('PE-C2b: visibility summary when a rule read visibility', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        visibility: vis({ countedOutsideDatedScope: 2, excluded: { olderFrequency: 1, notInProgramme: 0, notLive: 3 } }),
      }),
    });
    render(<ComputePage />);
    await runPreview();
    expect((await screen.findByTestId('visibility-summary')).textContent).toMatch(/3 outlets with approved visibility/);
    const exc = (await screen.findByTestId('visibility-exceptions')).textContent ?? '';
    expect(exc).toMatch(/2 approved capture\(s\) counted for outlets added or KYC-approved after their window/);
    expect(exc).toMatch(/1 approved capture\(s\) NOT counted — taken under an older capture frequency/);
    expect(exc).toMatch(/3 approved capture\(s\) NOT counted — the outlet is removed, deactivated/);
    expect(screen.queryByTestId('visibility-pending')).not.toBeInTheDocument();
  });

  it('PE-C2b2: amber banner + the reason when a rule reads visibility but there is no visibility result', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        visibility: vis({
          available: false, windows: 0, outletsApproved: 0, outletsWithData: 0,
          unavailableReason: 'Visibility is switched off for this tenant, so there is no visibility result to read.',
        }),
      }),
    });
    render(<ComputePage />);
    await runPreview();
    expect(await screen.findByTestId('visibility-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Visibility is switched off for this tenant/)).toBeInTheDocument();
  });

  it('PE-C2d: pending visibility blocks Export / Credit until the admin ticks "I accept N", then sends N', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        visibility: vis({
          outletsWaitingReview: 2, outletsOpenWindow: 3, outletsPending: 4, openWindowsInMonth: 1,
          waitingOutletCodes: ['A', 'B'], openOutletCodes: ['B', 'C', 'D'], pendingKey: 'vp_set1',
        }),
      }),
    });
    render(<ComputePage />);
    await runPreview();
    const box = await screen.findByTestId('visibility-pending');
    expect(box.textContent).toMatch(/4 outlets will read visibility = NOT approved/);
    expect(box.textContent).toMatch(/2 with a capture still waiting for review · 3 with a window still open/);
    const creditBtn = await screen.findByRole('button', { name: /credit in portal/i });
    expect(creditBtn).toBeDisabled();
    fireEvent.click(creditBtn);
    expect(commitMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('visibility-accept'));
    expect(creditBtn).not.toBeDisabled();
    fireEvent.click(creditBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ acceptVisibilityPendingKey: 'vp_set1' }));
    expect(screen.getByTestId('visibility-pending-codes').textContent).toBe('Outlets: A, B, C, D');
  });

  it('PE-C2e: an OK row that paid 0 shows its reason', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        rows: [{ outletCode: 'OUT-009', kpiCode: 'ADHO', status: 'OK', points: 0, reason: 'Target is 0', explanation: '0 pts' }],
      }),
    });
    render(<ComputePage />);
    await runPreview();
    expect((await screen.findByTestId('row-reason')).textContent).toMatch(/Target is 0/);
  });

  it('PE-C2c: no visibility block when no rule read visibility', async () => {
    previewMock.mockResolvedValue({ success: true, data: makePreview() });
    render(<ComputePage />);
    await runPreview();
    await screen.findByText('Total points');
    expect(screen.queryByTestId('visibility-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('visibility-unavailable')).not.toBeInTheDocument();
  });

  it('PE-C3: the direct-credit block is hidden when there are no OK rows', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 1, ok: 0, skip: 0, error: 1, noRule: 0 },
        totalPoints: 0,
        rows: [
          {
            outletCode: 'OUT-002',
            outletName: 'Beta Store',
            kpiCode: 'CASES_SOLD',
            status: 'ERROR',
            reason: 'Missing target value',
          },
        ],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    expect(await screen.findByTestId('group-ERROR')).toBeInTheDocument();
    // Export is still available, direct credit is not.
    expect(await screen.findByRole('button', { name: /download credit-upload file/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
  });

  it('PE-C4: Credit in portal calls commitCompute and renders the batch + confirm link', async () => {
    render(<ComputePage />);
    await runPreview();

    const creditBtn = await screen.findByRole('button', { name: /credit in portal/i });
    fireEvent.click(creditBtn);

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    // TOCTOU: the previewed run's sourceKey is passed back as expectedKey so a stale run 409s.
    expect(commitMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: expect.any(String), expectedKey: 'deoleo|2026-09|cf_x|v7' }),
    );

    expect(await screen.findByTestId('commit-result')).toBeInTheDocument();
    expect(await screen.findByText('PEB-2026-09-001')).toBeInTheDocument();

    const link = await screen.findByRole('link', { name: /review .* confirm this batch in credits/i });
    expect(link).toHaveAttribute('href', '/admin/credits-payouts/status');
  });

  it('PE-C5: a commit returning a 409 surfaces the "computation changed" message', async () => {
    commitMock.mockResolvedValue({
      success: false,
      status: 409,
      error: 'The computation changed since you last previewed it. Re-preview and review the new result.',
    });
    render(<ComputePage />);
    await runPreview();

    const creditBtn = await screen.findByRole('button', { name: /credit in portal/i });
    fireEvent.click(creditBtn);

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/computation changed since you last previewed/i)).toBeInTheDocument();
    // No success batch panel on a rejected commit.
    expect(screen.queryByTestId('commit-result')).not.toBeInTheDocument();
  });

  it('PE-C6: the prior-batches warning counts ANY credit batch for the period', async () => {
    commitMock.mockResolvedValue({
      success: true,
      data: { ...COMMIT_RESULT, priorBatchesThisPeriod: 2 },
    });
    render(<ComputePage />);
    await runPreview();

    fireEvent.click(await screen.findByRole('button', { name: /credit in portal/i }));
    expect(await screen.findByTestId('commit-result')).toBeInTheDocument();
    expect(await screen.findByText(/already 2 credit batches for this period/i)).toBeInTheDocument();
  });

  it('PE-C7: engineDisabled OK-group footer omits the credit-upload file reference', async () => {
    // >25 OK rows so the "showing the first N" footer renders, with the engine disabled.
    const okRows = Array.from({ length: 30 }, (_, i) => ({
      outletCode: `OUT-${i}`,
      kpiCode: 'CASES_SOLD',
      status: 'OK' as const,
      points: 100,
      achievement: 10,
      target: 10,
      explanation: 'ok',
    }));
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        engineDisabled: true,
        counts: { total: 30, ok: 30, skip: 0, error: 0, noRule: 0 },
        rows: okRows,
      }),
    });
    render(<ComputePage />);
    await runPreview();

    expect(await screen.findByTestId('group-OK')).toBeInTheDocument();
    const footer = await screen.findByText(/showing the first/i);
    expect(footer.textContent).toMatch(/review report/i);
    expect(footer.textContent).not.toMatch(/credit-upload file/i);
  });

  it('PE-C8: a payout preview renders the "Total payout" card + the payout group with ₹ amounts', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 2, ok: 2, skip: 0, error: 0, noRule: 0 },
        totalPoints: 1300,
        totalPayoutRupees: 2500,
        rows: [POINTS_ROW, PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    // Total payout card. ₹2,500 shows in both the card and the payout row — assert presence, not uniqueness.
    expect(await screen.findByText('Total payout')).toBeInTheDocument();
    expect((await screen.findAllByText('₹2,500')).length).toBeGreaterThan(0);

    // The payout group renders its rows with ₹ amounts.
    const payoutGroup = await screen.findByTestId('group-PAYOUT');
    expect(payoutGroup).toBeInTheDocument();
    expect(await screen.findByText('OUT-003')).toBeInTheDocument();
    expect(payoutGroup.textContent).toMatch(/to pay out/i);
  });

  it('PE-C9: Download payout report calls downloadPayoutReport with the applied filter', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        filter: { program: 'TRADE', kpiCode: 'CASES_SOLD' },
        counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 },
        totalPoints: 0,
        totalPayoutRupees: 2500,
        rows: [PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    const payoutBtn = await screen.findByRole('button', { name: /download payout report/i });
    fireEvent.click(payoutBtn);

    await waitFor(() => expect(payoutReportMock).toHaveBeenCalledTimes(1));
    // Period defaults to the previous calendar month — mirror getPreviousMonth() in page.tsx and
    // compute it relative to now, so this never breaks on a month rollover (date-relative-tests rule).
    const _now = new Date();
    const _py = _now.getMonth() === 0 ? _now.getFullYear() - 1 : _now.getFullYear();
    const _pm = _now.getMonth() === 0 ? 12 : _now.getMonth();
    const expectedPeriod = `${_py}-${String(_pm).padStart(2, '0')}`;
    expect(payoutReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: expectedPeriod }),
    );
    expect(await screen.findByText(/payout report downloaded/i)).toBeInTheDocument();
  });

  it('PE-C9b: a big payout report (202) says it is being prepared and links to Downloads', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        filter: { program: 'TRADE', kpiCode: 'CASES_SOLD' },
        counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 },
        totalPoints: 0,
        totalPayoutRupees: 2500,
        rows: [PAYOUT_ROW],
      }),
    });
    payoutReportMock.mockResolvedValueOnce({ kind: 'queued', message: "We're preparing your file.", exportRequestId: 'exp-1' });
    render(<ComputePage />);
    await runPreview();
    fireEvent.click(await screen.findByRole('button', { name: /download payout report/i }));
    const note = await screen.findByTestId('download-queued');
    expect(note).toHaveTextContent("We're preparing your file.");
    expect(await screen.findByRole('link', { name: /open downloads/i })).toHaveAttribute('href', '/admin/downloads');
    expect(screen.queryByText(/payout report downloaded/i)).not.toBeInTheDocument();
  });

  it('PE-C10: a PAYOUT-only preview disables the credit-upload file + offers no in-portal credit', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 },
        totalPoints: 0,
        totalPayoutRupees: 2500,
        rows: [PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    expect(await screen.findByTestId('group-PAYOUT')).toBeInTheDocument();
    // No points rows → the credit-upload file is disabled and in-portal crediting is not offered.
    expect(await screen.findByRole('button', { name: /download credit-upload file/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
    // The payout report is still available.
    expect(await screen.findByRole('button', { name: /download payout report/i })).toBeInTheDocument();
  });

  it('PE-C11: the Program filter is a searchable dropdown listing the tenant\'s configured programs', async () => {
    render(<ComputePage />);
    // The free-text input is gone; the searchable combobox input is present.
    const programInput = screen.getByTestId('pe-program-input');
    expect(programInput).toHaveAttribute('role', 'combobox');

    // Open the list → the configured programs (from outletPrograms) are the options.
    fireEvent.click(programInput);
    expect(await screen.findByTestId('pe-program-option-Unnati')).toBeInTheDocument();
    expect(await screen.findByTestId('pe-program-option-BSC')).toBeInTheDocument();
    expect(await screen.findByTestId('pe-program-option-SAMT')).toBeInTheDocument();
  });

  it('PE-C12: the KPI filter dropdown lists the enabled codes from /api/admin/kpis and omits disabled ones', async () => {
    render(<ComputePage />);
    // Wait for the KPI fetch to populate options.
    const kpiInput = screen.getByTestId('pe-kpi-input');
    expect(kpiInput).toHaveAttribute('role', 'combobox');
    fireEvent.click(kpiInput);

    expect(await screen.findByTestId('pe-kpi-option-CASES_SOLD')).toBeInTheDocument();
    expect(await screen.findByTestId('pe-kpi-option-LITRES_SOLD')).toBeInTheDocument();
    // enabled:false is filtered out (parity with the rule builder).
    expect(screen.queryByTestId('pe-kpi-option-DISABLED_KPI')).not.toBeInTheDocument();
  });

  it('PE-C13: selecting a Program + KPI drives the preview request params', async () => {
    render(<ComputePage />);

    // Pick a program from the dropdown.
    fireEvent.click(screen.getByTestId('pe-program-input'));
    fireEvent.mouseDown(await screen.findByTestId('pe-program-option-Unnati'));

    // Pick a KPI from the dropdown.
    fireEvent.click(screen.getByTestId('pe-kpi-input'));
    fireEvent.mouseDown(await screen.findByTestId('pe-kpi-option-LITRES_SOLD'));

    await runPreview();
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'Unnati', kpiCode: 'LITRES_SOLD' }),
    );
  });

  it('PE-C14: leaving both filters empty previews with no program/KPI filter (null)', async () => {
    render(<ComputePage />);
    await runPreview();
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: null, kpiCode: null }),
    );
  });

  it('PE-C15 (APPLIES-TO D5): a KPI-scope SKIP row shows its reason and the SKIP group counts scope skips', async () => {
    const scopeSkip = (code: string): ComputePreviewRow => ({
      outletCode: code, outletName: 'Store', kpiCode: 'UNNATI_VOL', status: 'SKIP',
      reason: 'KPI not applicable to this outlet (KPI scope)', skipKind: 'KPI_SCOPE',
    });
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 4, ok: 0, skip: 4, error: 0, noRule: 0 },
        rows: [
          scopeSkip('OUT-7'),
          scopeSkip('OUT-8'),
          { outletCode: 'OUT-9', kpiCode: 'CASES_SOLD', status: 'SKIP', reason: 'Target is zero' },
          // A gate failReason that merely SAYS "(KPI scope)" is NOT a KPI-scope skip (structured flag only).
          { outletCode: 'OUT-10', kpiCode: 'CASES_SOLD', status: 'SKIP', reason: 'Not eligible (KPI scope) per Bajaj' },
        ],
      }),
    });
    render(<ComputePage />);
    await runPreview();
    const group = await screen.findByTestId('group-SKIP');
    expect(await within(group).findAllByText(/KPI not applicable to this outlet \(KPI scope\)/)).toHaveLength(2);
    expect(await within(group).findByTestId('skip-kpi-scope-count')).toHaveTextContent("2 because the KPI doesn't apply to that outlet (KPI scope)");
  });

  it('PE-C16: no scope-skip line when no SKIP row is a KPI-scope skip', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 1, ok: 0, skip: 1, error: 0, noRule: 0 },
        rows: [{ outletCode: 'OUT-9', kpiCode: 'CASES_SOLD', status: 'SKIP', reason: 'Target is zero' }],
      }),
    });
    render(<ComputePage />);
    await runPreview();
    await screen.findByTestId('group-SKIP');
    expect(screen.queryByTestId('skip-kpi-scope-count')).not.toBeInTheDocument();
  });
});

describe('PE-Q: quarter run (owner-approved 2026-11-25)', () => {
  it('PE-Q1: picking a quarter runs the preview with period YYYY-Qn and shows the quarter banner + credit month', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        period: '2026-Q3',
        quarter: { key: '2026-Q3', label: 'Oct–Dec 2026', fyLabel: 'Q3 FY2026-27', months: ['2026-10', '2026-11', '2026-12'], monthLabels: ['Oct 2026', 'Nov 2026', 'Dec 2026'], creditPeriod: '2026-12', openMonths: [] },
      }),
    });
    render(<ComputePage />);
    fireEvent.click(screen.getByLabelText('Quarter run (quarterly rules only)'));
    const pick = screen.getByLabelText('Quarter *') as HTMLSelectElement;
    expect(pick.options[0].value).toMatch(/^\d{4}-Q[1-4]$/);
    expect(pick.options[0].textContent).toMatch(/^[A-Z][a-z]{2}–[A-Z][a-z]{2} \d{4} \(Q[1-4] FY\d{4}-\d{2}\)$/);
    fireEvent.change(pick, { target: { value: pick.options[0].value } });
    fireEvent.click(screen.getByRole('button', { name: /Run preview/ }));
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith(expect.objectContaining({ period: pick.options[0].value })));
    const banner = await screen.findByTestId('quarter-run');
    expect(within(banner).getByText(/Quarter run — Oct–Dec 2026 \(Q3 FY2026-27\)/)).toBeTruthy();
    expect(banner.textContent).toMatch(/Oct 2026, Nov 2026, Dec 2026/);
    expect(banner.textContent).toMatch(/December 2026/);
  });
});
describe('PE-Q: quarter run audit fixes (2026-11-26)', () => {
  const Q = { key: '2026-Q3', label: 'Oct–Dec 2026', fyLabel: 'Q3 FY2026-27', months: ['2026-10', '2026-11', '2026-12'], monthLabels: ['Oct 2026', 'Nov 2026', 'Dec 2026'], creditPeriod: '2026-12' };
  const nowYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  it('PE-Q2: the quarter picker defaults to the latest FULLY ENDED quarter', () => {
    render(<ComputePage />);
    fireEvent.click(screen.getByLabelText('Quarter run (quarterly rules only)'));
    expect((screen.getByLabelText('Quarter *') as HTMLSelectElement).value).toBe(latestEndedQuarterKey(nowYm()));
  });

  async function runQuarter(over: Partial<ComputePreview>) {
    previewMock.mockResolvedValue({ success: true, data: makePreview({ period: '2026-Q3', quarter: { ...Q, openMonths: [] }, ...over }) });
    render(<ComputePage />);
    fireEvent.click(screen.getByLabelText('Quarter run (quarterly rules only)'));
    fireEvent.click(screen.getByRole('button', { name: /Run preview/ }));
    await screen.findByTestId('quarter-run');
  }

  it('PE-Q3: months not ended → red banner names them up front; export + credit blocked', async () => {
    await runQuarter({ quarter: { ...Q, openMonths: ['Nov 2026', 'Dec 2026'] } });
    expect(screen.getByTestId('quarter-open-months').textContent).toMatch(/Oct–Dec 2026 is not finished — Nov 2026, Dec 2026 have not ended yet/);
    expect((screen.getByRole('button', { name: /Download credit-upload file/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Credit in portal/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('PE-Q4: imported months → red banner; actions blocked until the Gifsy tick; the confirm key is sent', async () => {
    await runQuarter({ importedMonths: { firstLiveMonth: '2026-11', months: ['2026-10'], monthLabels: ['Oct 2026'], confirmKey: 'im_k' } });
    expect(screen.getByTestId('imported-months').textContent).toMatch(/Oct 2026 is before this programme.s first live month/);
    const credit = screen.getByRole('button', { name: /Credit in portal/ }) as HTMLButtonElement;
    expect(credit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('imported-months-confirm'));
    expect(credit.disabled).toBe(false);
    fireEvent.click(credit);
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ period: latestEndedQuarterKey(nowYm()), confirmImportedMonthsKey: 'im_k' })));
  });

  it('PE-Q5: an OK quarter row shows its narration; an empty quarter run shows why', async () => {
    const okRow: ComputePreviewRow = { outletCode: 'W1', kpiCode: 'BSC_CASES', status: 'OK', points: 275, narration: 'Consistency bonus Oct–Dec 2026', explanation: 'x' };
    await runQuarter({ rows: [okRow], counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 } });
    expect(screen.getByTestId('row-narration').textContent).toBe('Credit narration: Consistency bonus Oct–Dec 2026');
  });

  it('PE-Q6: prior-batch warning names a likely duplicate (same quarter + same field) in red', async () => {
    commitMock.mockResolvedValue({
      success: true,
      data: {
        ...COMMIT_RESULT, period: '2026-12', priorBatchesThisPeriod: 2, quarter: { key: '2026-Q3', label: 'Oct–Dec 2026' },
        priorBatches: [
          { batchCode: 'CB-2026-12-001', kind: 'MONTHLY_ENGINE', likelyDuplicate: false },
          { batchCode: 'CB-2026-12-002', kind: 'QUARTER_ENGINE', quarter: 'Oct–Dec 2026', likelyDuplicate: true },
        ],
      },
    });
    await runQuarter({});
    fireEvent.click(screen.getByRole('button', { name: /Credit in portal/ }));
    const w = await screen.findByTestId('prior-batches');
    expect(w.textContent).toMatch(/Possible double credit: CB-2026-12-002 \(quarterly bonus Oct–Dec 2026\).*same quarter \(Oct–Dec 2026\)/);
    expect(w.textContent).not.toMatch(/CB-2026-12-001/);
  });
});

describe('PE-Q: empty quarter run reason', () => {
  it('PE-Q7: shows the emptyReason', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({ period: '2026-Q3', rows: [], counts: { total: 0, ok: 0, skip: 0, error: 0, noRule: 0 }, emptyReason: 'No published quarterly rule is effective during Oct–Dec 2026.' }),
    });
    render(<ComputePage />);
    fireEvent.click(screen.getByLabelText('Quarter run (quarterly rules only)'));
    fireEvent.click(screen.getByRole('button', { name: /Run preview/ }));
    expect((await screen.findByTestId('empty-reason')).textContent).toMatch(/No published quarterly rule is effective/);
  });
});
describe('PE-Q: imported months — non-Gifsy admins', () => {
  afterEach(() => { sessionRole.role = 'GIFSY_ADMIN'; });
  it('PE-Q8: a client admin sees the confirmation DISABLED with an explanation; actions stay blocked', async () => {
    sessionRole.role = 'CLIENT_ADMIN';
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({ importedMonths: { firstLiveMonth: '2026-11', months: ['2026-09'], monthLabels: ['Sep 2026'], confirmKey: 'im_k' } }),
    });
    render(<ComputePage />);
    fireEvent.click(screen.getByRole('button', { name: /Run preview/ }));
    const box = (await screen.findByTestId('imported-months-confirm')) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId('imported-months-gifsy-only').textContent).toMatch(/Only a Gifsy admin can confirm imported months/);
    expect((screen.getByRole('button', { name: /Credit in portal/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});