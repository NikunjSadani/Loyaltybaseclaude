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
  // Memory-safety (2026-11-13): the API echoes only rejected rows + warning rows (capped), not every row.
  problemRows: [], problemRowCount: 0, problemRowsTruncated: false,
  warningRows: [{ rowIndex: 3, outletCode: 'O1', status: 'accepted', remarks: 'Ignored (KPI not applicable): UNNATI_VOL' }],
  warningRowCount: 1, warningRowsTruncated: false, skippedBlankCount: 0,
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
    expect(notice).toHaveTextContent("1 value ignored because the KPI doesn't apply to that outlet.");
    // Honest copy (owner decision): stored values are never deleted by a re-upload.
    expect(notice).toHaveTextContent(
      'Any value already stored for that cell is unchanged (hidden on screens, kept in exports).',
    );
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

  it('older API build that still sends rows → the saved row with the remark is still listed', async () => {
    stub({
      batchId: 'batch-000001', month: '2026-11', monthsInBatch: ['2026-11'], totalRows: 2, acceptedCount: 2, rejectedCount: 0,
      ignoredOutOfScope: 1,
      rows: [
        { rowIndex: 3, outletCode: 'O1', status: 'accepted', remarks: 'Ignored (KPI not applicable): UNNATI_VOL' },
        { rowIndex: 4, outletCode: 'O2', status: 'accepted', remarks: '' },
      ],
    });
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByTestId('ignored-out-of-scope')).toHaveTextContent('Row 3 — O1');
  });

  it('rejected rows: lists every returned row and says when the API capped the list', async () => {
    stub(result({
      rejectedCount: 700, acceptedCount: 0, savedCount: 0,
      problemRows: Array.from({ length: 500 }, (_, i) => ({ rowIndex: i + 3, outletCode: 'X' + i, status: 'rejected_outlet', remarks: 'not found' })),
      problemRowCount: 700, problemRowsTruncated: true,
    }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText('Rejected rows (700)')).toBeInTheDocument();
    expect(screen.getByText(/Row 502 — X499/)).toBeInTheDocument();
    const note = screen.getByText(/Showing the first 500 of 700 rejected rows/);
    // M3: partial save → re-upload only the failed rows (never "re-upload the file").
    expect(note.textContent).toMatch(/re-upload only the failed rows/i);
    // M7: the note sits ABOVE the short scroll box, not inside it.
    const box = screen.getByText('Rejected rows (700)').parentElement as HTMLElement;
    expect(box.contains(note)).toBe(false);
    expect(note.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('L1: a Blank tile makes Total = Accepted + Rejected + Blank visible', async () => {
    stub(result({ totalRows: 10, acceptedCount: 6, savedCount: 6, rejectedCount: 1, skippedBlankCount: 3 }));
    render(<TargetUploadPage />);
    await upload();
    const tile = (label: string) => (screen.getByText(label, { selector: 'p' }).parentElement as HTMLElement).textContent;
    expect(await screen.findByText('Blank', { selector: 'p' })).toBeInTheDocument();
    expect(tile('Total rows')).toMatch(/^10/);
    expect(tile('Accepted')).toMatch(/^6/);
    expect(tile('Rejected')).toMatch(/^1/);
    expect(tile('Blank')).toMatch(/^3/);
  });

  it('L1: older API without skippedBlankCount → Blank = Total − Accepted − Rejected', async () => {
    stub(result({ totalRows: 9, acceptedCount: 5, savedCount: 5, rejectedCount: 2, skippedBlankCount: undefined }));
    render(<TargetUploadPage />);
    await upload();
    await screen.findByText('Blank', { selector: 'p' });
    expect((screen.getByText('Blank', { selector: 'p' }).parentElement as HTMLElement).textContent).toMatch(/^2/);
  });
});
