/// <reference types="vitest/globals" />
/**
 * FOCUS-FROM-TARGETS §7 — the target upload result shows `focusCheck` blockers as a non-blocking amber panel; nothing
 * when the check did not run (checked: false) or found nothing.
 * Run: npx vitest run src/app/admin/targets/__tests__/upload-focus-check.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import TargetUploadPage from '../upload/page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const result = (extra: Record<string, unknown> = {}) => ({
  batchId: 'batch-000001', month: '2026-11', monthsInBatch: ['2026-11'], totalRows: 2, acceptedCount: 2, rejectedCount: 0,
  savedCount: 2, rows: [{ rowIndex: 3, outletCode: 'O1', status: 'accepted' }], ...extra,
});

function stub(upload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
    if (url.startsWith('/api/admin/targets/upload')) return json({ success: true, data: upload });
    return json({ success: false, error: 'unexpected' }, 404);
  }));
}

async function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 't.xlsx')] } }); });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('target upload — focusCheck', () => {
  it('shows blockers per month, with the upload still reported as saved', async () => {
    stub(result({
      focusCheck: {
        checked: true,
        months: [{
          month: '2026-11',
          blockers: [{ code: 'FOCUS_UNMATCHED', kpiCode: 'FB1', token: 'ADH0500', key: 'ADH0500', outlets: 12, sampleOutletCodes: ['R1', 'R2'], message: '"ADH0500" in Focus Brand 1 is not a product in the sales data (12 outlets). Fix the target file, or accept it as not sold yet.' }],
        }],
      },
    }));
    render(<TargetUploadPage />);
    await upload();
    const panel = await screen.findByTestId('target-focus-check');
    expect(panel).toHaveTextContent('These focus product names will block applying sales for November 2026 until fixed:');
    expect(panel).toHaveTextContent('"ADH0500" in Focus Brand 1 is not a product in the sales data (12 outlets). Fix the target file, or accept it as not sold yet.');
    // M5: the server message already carries the count — nothing appended.
    expect(panel.textContent).not.toContain('yet. (12 outlets)');
    expect(panel.textContent!.match(/12 outlets/g)).toHaveLength(1);
    expect(panel).toHaveTextContent('R1, R2');
    expect(await screen.findByText('Targets submitted successfully')).toBeInTheDocument();
  });

  it('checked: false because no KPI takes names from the target file → silent', async () => {
    stub(result({ focusCheck: { checked: false, reasonCode: 'NO_TARGET_NAMES_KPI', reason: 'No KPI takes its products from the target file.', months: [] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('target-focus-check')).not.toBeInTheDocument();
    expect(screen.queryByTestId('target-focus-check-skipped')).not.toBeInTheDocument();
  });

  it('M4: checked: false because there is no product list yet → grey note with the reason (never silent)', async () => {
    stub(result({ focusCheck: { checked: false, reasonCode: 'NO_PRODUCT_LIST', reason: 'No sales month has been applied yet.', months: [] } }));
    render(<TargetUploadPage />);
    await upload();
    const note = await screen.findByTestId('target-focus-check-skipped');
    expect(note).toHaveTextContent(
      "Focus product names weren't checked yet: no sales month has been applied yet, so there is no product list to check them against. They will be checked on the Sales Import month screen before anything is applied.",
    );
    expect(screen.queryByTestId('target-focus-check')).not.toBeInTheDocument();
  });

  it('M4: checked: false because the check failed → grey note with the reason', async () => {
    stub(result({ focusCheck: { checked: false, reasonCode: 'CHECK_FAILED', reason: 'The focus product check could not run.', months: [] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByTestId('target-focus-check-skipped')).toHaveTextContent(
      "Focus product names weren't checked yet: the check could not run this time. They will be checked on the Sales Import month screen before anything is applied.",
    );
  });

  it('checked with no blockers → no panel', async () => {
    stub(result({ focusCheck: { checked: true, months: [{ month: '2026-11', blockers: [] }] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('target-focus-check')).not.toBeInTheDocument();
  });
});
