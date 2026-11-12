/// <reference types="vitest/globals" />
/**
 * APPLIES-TO D1 — the target upload result shows `ignoredOutOfScope` (values ignored because the KPI does not apply
 * to that outlet) with the saved rows' remarks; nothing for 0 / absent (unscoped tenants unchanged).
 * Run: npx vitest run src/app/admin/targets/__tests__/upload-ignored-out-of-scope.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import TargetUploadPage from '../upload/page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const result = (extra: Record<string, unknown> = {}) => ({
  batchId: 'batch-000001', month: '2026-11', monthsInBatch: ['2026-11'], totalRows: 2, acceptedCount: 2, rejectedCount: 0,
  savedCount: 2,
  rows: [
    { rowIndex: 3, outletCode: 'O1', status: 'accepted', remarks: 'Ignored (KPI not applicable): UNNATI_VOL' },
    { rowIndex: 4, outletCode: 'O2', status: 'accepted', remarks: '' },
  ],
  ...extra,
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

describe('target upload — ignoredOutOfScope', () => {
  it('shows the count and the saved row that carries the remark', async () => {
    stub(result({ ignoredOutOfScope: 1 }));
    render(<TargetUploadPage />);
    await upload();
    const notice = await screen.findByTestId('ignored-out-of-scope');
    expect(notice).toHaveTextContent('1 value ignored (KPI not applicable to that outlet)');
    expect(notice).toHaveTextContent('Row 3 — O1: Ignored (KPI not applicable): UNNATI_VOL');
    expect(notice).not.toHaveTextContent('Row 4');
  });

  it('absent (older API / unscoped tenant) → no notice', async () => {
    stub(result());
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('ignored-out-of-scope')).not.toBeInTheDocument();
  });
});
