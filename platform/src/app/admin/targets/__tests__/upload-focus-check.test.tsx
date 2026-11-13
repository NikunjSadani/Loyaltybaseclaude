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
          blockers: [{ code: 'FOCUS_UNMATCHED', kpiCode: 'FB1', token: 'ADH0500', key: 'ADH0500', outlets: 12, sampleOutletCodes: ['R1', 'R2'], message: 'ADH0500 (Focus Brand 1) is not in the sales data.' }],
        }],
      },
    }));
    render(<TargetUploadPage />);
    await upload();
    const panel = await screen.findByTestId('target-focus-check');
    expect(panel).toHaveTextContent('These focus product names will block applying sales for November 2026 until fixed:');
    expect(panel).toHaveTextContent('ADH0500 (Focus Brand 1) is not in the sales data. (12 outlets)');
    expect(panel).toHaveTextContent('R1, R2');
    expect(screen.getByText('Targets submitted successfully')).toBeInTheDocument();
  });

  it('checked: false (nothing to check yet) → no panel', async () => {
    stub(result({ focusCheck: { checked: false, reason: 'No KPI takes its products from the target file.', months: [] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('target-focus-check')).not.toBeInTheDocument();
  });

  it('checked with no blockers → no panel', async () => {
    stub(result({ focusCheck: { checked: true, months: [{ month: '2026-11', blockers: [] }] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('target-focus-check')).not.toBeInTheDocument();
  });
});
