/// <reference types="vitest/globals" />
/**
 * Target upload = PREVIEW then CONFIRM (owner decision 2026-11-25) + NO SILENT FAILURE (owner rule 2026-11-25):
 *  - picking a file only previews (?preview=1) — "nothing has been saved yet", overwrite count prominent;
 *  - one required "I understand…" box per not-applied category; Confirm stays disabled until all are ticked;
 *  - Confirm posts the same file with ?confirmToken=…&ack=…, once (double-click safe); the done screen lists
 *    what was not applied; Cancel discards; server errors are shown; nothing-valid disables Confirm with a reason.
 * Run: npx vitest run src/app/admin/targets/upload/__tests__/targets-upload-preview-confirm.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/targets/upload',
  useSearchParams: () => new URLSearchParams(),
}));

import TargetUploadPage from '../page';

const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(32)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const base = {
  month: '2026-12', monthsInBatch: ['2026-12'], writableMonths: ['2026-12'], skippedLockedMonths: [],
  totalRows: 4, acceptedCount: 3, rejectedCount: 1,
  problemRows: [{ rowIndex: 6, outletCode: 'GHOST', status: 'rejected_outlet', remarks: 'Outlet not found' }],
  problemRowCount: 1, problemRowsTruncated: false,
  warningRows: [], warningRowCount: 0, warningRowsTruncated: false, skippedBlankCount: 0,
};

const previewBody = (extra: Record<string, unknown> = {}) => ({
  ...base, preview: true, previewToken: TOKEN, willSaveCount: 3, newCount: 1, overwriteCount: 2,
  perMonth: [{ month: '2026-12', newCount: 1, overwriteCount: 2 }],
  overwriteExamples: [{ outletCode: 'O1', outletName: 'Alpha', month: '2026-12',
    changes: [{ kpiCode: 'MONTH_TGT', label: 'Month Target', from: 10, to: 12 }, { kpiCode: 'FP1', label: 'Focus Pack', from: 5, to: null }] }],
  overwriteExamplesSampled: 2,
  notApplied: [{ category: 'REJECTED_ROWS', count: 1 }, { category: 'OVERWRITE', count: 2 }],
  ...extra,
});

const appliedBody = (extra: Record<string, unknown> = {}) => ({
  ...base, batchId: 'tgtup_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', savedCount: 3, newCount: 1, overwriteCount: 2,
  perMonth: [{ month: '2026-12', newCount: 1, overwriteCount: 2 }],
  notApplied: [{ category: 'REJECTED_ROWS', count: 1 }, { category: 'OVERWRITE', count: 2 }],
  acknowledged: ['REJECTED_ROWS', 'OVERWRITE'],
  ...extra,
});

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let calls: { url: string; body?: BodyInit | null }[] = [];
let historyLoads = 0;

function stub(onUpload: Handler) {
  calls = [];
  historyLoads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
    if (url.startsWith('/api/admin/targets/batches')) {
      historyLoads++;
      return json({ success: true, data: [] });
    }
    if (url.startsWith('/api/admin/targets/upload')) {
      calls.push({ url, body: init?.body });
      return onUpload(url, init);
    }
    return json({ success: false, error: 'unexpected' }, 404);
  }));
}

const uploadCalls = () => calls.filter(c => c.url.startsWith('/api/admin/targets/upload'));

async function pick(name = 'targets.xlsx') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['xlsx-bytes'], name)] } }); });
}

const confirmBtn = () => screen.getByRole('button', { name: /Confirm & apply|Applying/ });
const tick = async (label: RegExp) => { await act(async () => { fireEvent.click(screen.getByLabelText(label)); }); };

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('target upload — preview', () => {
  it('picking a file only PREVIEWS: ?preview=1, "nothing has been saved yet", overwrite count + examples prominent', async () => {
    stub(async () => json({ success: true, data: previewBody() }));
    render(<TargetUploadPage />);
    await pick();

    const panel = await screen.findByTestId('target-upload-preview');
    expect(uploadCalls()).toHaveLength(1);
    expect(uploadCalls()[0].url).toBe('/api/admin/targets/upload?preview=1');
    expect(panel).toHaveTextContent('Preview — nothing has been saved yet');
    expect(panel).toHaveTextContent('If you confirm, 3 outlet-month targets will be saved (1 new, 2 replacing existing targets)');
    const ow = screen.getByTestId('target-upload-overwrite');
    expect(ow).toHaveTextContent('2 outlet-months will be overwritten');
    expect(ow).toHaveTextContent("Dec '26: 1 new · 2 overwritten");
    expect(ow).toHaveTextContent('O1 (Alpha)');
    expect(ow).toHaveTextContent('Month Target 10 → 12; Focus Pack 5 → removed');
    // rejected rows listed with the reason; no success banner
    expect(screen.getByText('Rejected rows (1)')).toBeInTheDocument();
    expect(screen.getByText(/Row 6 — GHOST/).parentElement).toHaveTextContent('Outlet not found');
    expect(screen.queryByText('Targets submitted successfully')).not.toBeInTheDocument();
  });

  it('shows the "checking" state while the preview is in flight and blocks a second pick', async () => {
    let release!: (r: Response) => void;
    stub(() => new Promise<Response>(r => { release = r; }));
    render(<TargetUploadPage />);
    await pick();
    expect(screen.getByText(/Checking the file… nothing is saved at this step/)).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeDisabled();
    await act(async () => { release(json({ success: true, data: previewBody() })); });
    expect(await screen.findByTestId('target-upload-preview')).toBeInTheDocument();
  });

  it('a server error on the preview is shown as-is (e.g. a corrupt file) — no preview panel', async () => {
    stub(async () => json({ success: false, error: 'Invalid or corrupted xlsx file' }, 400));
    render(<TargetUploadPage />);
    await pick();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or corrupted xlsx file');
    expect(screen.queryByTestId('target-upload-preview')).not.toBeInTheDocument();
  });

  it('nothing valid → Confirm disabled with the reason, no acknowledgement boxes', async () => {
    stub(async () => json({ success: true, data: previewBody({
      acceptedCount: 0, rejectedCount: 4, willSaveCount: 0, newCount: 0, overwriteCount: 0, perMonth: [],
      overwriteExamples: [], notApplied: [{ category: 'REJECTED_ROWS', count: 4 }],
    }) }));
    render(<TargetUploadPage />);
    await pick();
    await screen.findByTestId('target-upload-preview');
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('confirm-disabled-reason')).toHaveTextContent(/Nothing to apply — no row in this file was accepted/);
    expect(screen.queryByTestId('target-upload-acks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('target-upload-overwrite')).not.toBeInTheDocument();
  });

  it('every month locked → Confirm disabled with the locked-months reason', async () => {
    stub(async () => json({ success: true, data: previewBody({
      rejectedCount: 0, problemRows: [], problemRowCount: 0, writableMonths: [], skippedLockedMonths: ['2020-01'],
      monthsInBatch: ['2020-01'], willSaveCount: 0, newCount: 0, overwriteCount: 0, perMonth: [], overwriteExamples: [],
      notApplied: [{ category: 'LOCKED_MONTHS', count: 3 }],
    }) }));
    render(<TargetUploadPage />);
    await pick();
    await screen.findByTestId('target-upload-preview');
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('confirm-disabled-reason')).toHaveTextContent(/every month in this file is in the past/);
  });
});

describe('target upload — acknowledge what will not be applied (no silent failure)', () => {
  it('one required box per category present; Confirm enabled only when ALL are ticked', async () => {
    stub(async () => json({ success: true, data: previewBody() }));
    render(<TargetUploadPage />);
    await pick();
    const acks = await screen.findByTestId('target-upload-acks');
    expect(acks.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(acks).toHaveTextContent('I understand 1 rejected row will not be saved');
    expect(acks).toHaveTextContent('I understand 2 existing outlet-month targets will be replaced');
    // absent categories do not appear
    expect(acks).not.toHaveTextContent(/blank|locked|ignored/i);

    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('confirm-disabled-reason')).toHaveTextContent('Tick the 2 remaining boxes above');
    await tick(/1 rejected row will not be saved/);
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('confirm-disabled-reason')).toHaveTextContent('Tick the remaining box above');
    await tick(/2 existing outlet-month targets will be replaced/);
    expect(confirmBtn()).toBeEnabled();
    // un-ticking disables it again
    await tick(/1 rejected row will not be saved/);
    expect(confirmBtn()).toBeDisabled();
  });

  it('all five categories render with their own copy', async () => {
    stub(async () => json({ success: true, data: previewBody({ notApplied: [
      { category: 'REJECTED_ROWS', count: 2 }, { category: 'OVERWRITE', count: 1200 }, { category: 'LOCKED_MONTHS', count: 3 },
      { category: 'BLANK_ROWS', count: 40 }, { category: 'IGNORED_VALUES', count: 5 },
    ] }) }));
    render(<TargetUploadPage />);
    await pick();
    const acks = await screen.findByTestId('target-upload-acks');
    expect(acks).toHaveTextContent('I understand 2 rejected rows will not be saved');
    expect(acks).toHaveTextContent('I understand 1,200 existing outlet-month targets will be replaced');
    expect(acks).toHaveTextContent('I understand 3 outlet-month targets in past (locked) months will not be saved');
    expect(acks).toHaveTextContent('I understand 40 blank rows will not be saved');
    expect(acks).toHaveTextContent("I understand 5 values for KPIs that don't apply to the outlet will be ignored");
  });

  it('a clean file (nothing to acknowledge) → no boxes, Confirm enabled straight away', async () => {
    stub(async () => json({ success: true, data: previewBody({
      rejectedCount: 0, problemRows: [], problemRowCount: 0, overwriteCount: 0, newCount: 3,
      perMonth: [{ month: '2026-12', newCount: 3, overwriteCount: 0 }], overwriteExamples: [], notApplied: [],
    }) }));
    render(<TargetUploadPage />);
    await pick();
    await screen.findByTestId('target-upload-preview');
    expect(screen.queryByTestId('target-upload-acks')).not.toBeInTheDocument();
    expect(confirmBtn()).toBeEnabled();
  });
});

describe('target upload — confirm & apply', () => {
  async function previewAndTickAll() {
    render(<TargetUploadPage />);
    await pick();
    await screen.findByTestId('target-upload-acks');
    await tick(/rejected row will not be saved/);
    await tick(/existing outlet-month targets will be replaced/);
  }

  it('Confirm re-posts the same file with the token + the acknowledged categories, then shows the done screen', async () => {
    stub(async (url) => json({ success: true, data: url.includes('preview=1') ? previewBody() : appliedBody() }));
    await previewAndTickAll();
    await act(async () => { fireEvent.click(confirmBtn()); });

    expect(await screen.findByText('Targets submitted successfully')).toBeInTheDocument();
    const [p, c] = uploadCalls();
    expect(c.url).toBe(`/api/admin/targets/upload?confirmToken=${encodeURIComponent(TOKEN)}&ack=${encodeURIComponent('REJECTED_ROWS,OVERWRITE')}`);
    // the SAME file is posted again (multipart field "file", same name and bytes)
    const f1 = (p.body as FormData).get('file') as File;
    const f2 = (c.body as FormData).get('file') as File;
    expect(f2.name).toBe('targets.xlsx');
    expect(f2.size).toBe(f1.size);
    expect(screen.getByText(/3 outlet-month targets saved to the system across 1 month \(1 new, 2 overwritten\)/)).toBeInTheDocument();
    expect(screen.getByText('Download Final Targets', { selector: 'span' })).toBeInTheDocument();
    // done screen lists what was not applied
    const na = screen.getByTestId('target-upload-not-applied');
    expect(na).toHaveTextContent('1 rejected row was not saved');
    expect(na).toHaveTextContent('2 existing outlet-month targets were replaced');
    expect(screen.queryByTestId('target-upload-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('target-upload-differs')).not.toBeInTheDocument();
    // the Upload history reloads after the apply (mount + after apply)
    expect(historyLoads).toBe(2);
  });

  it('a double-click on Confirm sends ONE apply request', async () => {
    let release!: (r: Response) => void;
    stub((url) => url.includes('preview=1')
      ? Promise.resolve(json({ success: true, data: previewBody() }))
      : new Promise<Response>(r => { release = r; }));
    await previewAndTickAll();
    const btn = confirmBtn();
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(uploadCalls().filter(c => c.url.includes('confirmToken'))).toHaveLength(1);
    expect(confirmBtn()).toBeDisabled();
    expect(confirmBtn()).toHaveTextContent('Applying…');
    await act(async () => { release(json({ success: true, data: appliedBody() })); });
    expect(await screen.findByText('Targets submitted successfully')).toBeInTheDocument();
    expect(uploadCalls().filter(c => c.url.includes('confirmToken'))).toHaveLength(1);
  });

  it('a server refusal on confirm (e.g. missing acknowledgement / already applied) is shown and nothing is claimed saved', async () => {
    stub(async (url) => url.includes('preview=1')
      ? json({ success: true, data: previewBody() })
      : json({ success: false, error: 'Please confirm what will not be applied before applying: 2 existing outlet-month targets that will be replaced (OVERWRITE). Nothing was saved.' }, 400));
    await previewAndTickAll();
    await act(async () => { fireEvent.click(confirmBtn()); });
    expect(await screen.findByRole('alert')).toHaveTextContent(/\(OVERWRITE\)\. Nothing was saved/);
    expect(screen.queryByText('Targets submitted successfully')).not.toBeInTheDocument();
    expect(screen.getByTestId('target-upload-preview')).toBeInTheDocument();
  });

  it('when the applied result differs from the preview it says so (re-validated against current data)', async () => {
    stub(async (url) => json({ success: true, data: url.includes('preview=1')
      ? previewBody()
      : appliedBody({ savedCount: 3, newCount: 0, overwriteCount: 3 }) }));
    await previewAndTickAll();
    await act(async () => { fireEvent.click(confirmBtn()); });
    const note = await screen.findByTestId('target-upload-differs');
    expect(note).toHaveTextContent('Preview: 3 to save (1 new, 2 overwritten). Saved: 3 (0 new, 3 overwritten).');
  });

  it('Cancel discards the preview: no apply request, the panel and the file name are cleared', async () => {
    stub(async () => json({ success: true, data: previewBody() }));
    render(<TargetUploadPage />);
    await pick('mine.xlsx');
    await screen.findByTestId('target-upload-preview');
    expect(screen.getByText('mine.xlsx')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByTestId('target-upload-preview')).not.toBeInTheDocument();
    expect(screen.queryByText('mine.xlsx')).not.toBeInTheDocument();
    expect(uploadCalls()).toHaveLength(1);
    expect(uploadCalls()[0].url).toContain('preview=1');
  });

  it('a new pick resets the acknowledgements (they belong to one preview)', async () => {
    stub(async () => json({ success: true, data: previewBody() }));
    await previewAndTickAll();
    expect(confirmBtn()).toBeEnabled();
    await pick('second.xlsx');
    expect(await screen.findByText('second.xlsx')).toBeInTheDocument();
    await screen.findByTestId('target-upload-acks');
    expect(confirmBtn()).toBeDisabled();
  });

  it('an older API that ignores ?preview and applies → shown as the applied result, never as a preview', async () => {
    stub(async () => json({ success: true, data: appliedBody({ notApplied: undefined, acknowledged: undefined }) }));
    render(<TargetUploadPage />);
    await pick();
    expect(await screen.findByText('Targets submitted successfully')).toBeInTheDocument();
    expect(screen.queryByTestId('target-upload-preview')).not.toBeInTheDocument();
  });
});
