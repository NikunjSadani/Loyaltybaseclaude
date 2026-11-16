/// <reference types="vitest/globals" />
/**
 * Achievements page tweak (SALES-IMPORT-PIPELINE-PLAN §11 F-7): the skippedImporterOwnedKpis notice after upload,
 * and no Delete action on Sales Import batches. Both render nothing for tenants without such data (Deoleo).
 * Run: npx vitest run src/app/admin/sales/__tests__/sales-import-ownership.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import SalesUploadPage from '../page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(opts: { batches: unknown[]; upload?: unknown }) {
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith('/api/admin/achievements/batches')) return json({ success: true, data: opts.batches });
    if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
    if (url.startsWith('/api/admin/achievements/upload')) return json({ success: true, data: opts.upload });
    return json({ success: false, error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const batch = (over: Record<string, unknown>) => ({
  id: 'b1', month: '2026-10', totalRows: 3, acceptedCount: 3, rejectedCount: 0, status: 'COMPLETED',
  createdAt: '2026-11-01T10:00:00.000Z', ...over,
});

const uploadResult = (extra: Record<string, unknown> = {}) => ({
  batchId: 'batch-000001', month: '2026-10', monthsInBatch: ['2026-10'], totalRows: 1, acceptedCount: 1, rejectedCount: 0,
  rows: [{ rowIndex: 3, outletCode: 'O1', status: 'accepted', remarks: '' }], ...extra,
});

async function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'ach.xlsx')] } }); });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('achievements page — Sales Import ownership', () => {
  it('a manual batch keeps its Delete; a Sales Import batch has none and is labelled', async () => {
    stubFetch({ batches: [batch({ id: 'manual' }), batch({ id: 'si', status: 'SALES_IMPORT', month: '2026-09' })] });
    render(<SalesUploadPage />);
    expect(await screen.findByText('Sales Import')).toBeInTheDocument();
    expect(await screen.findAllByRole('button', { name: /Delete/ })).toHaveLength(1);
    expect(await screen.findByText('Managed in Sales Import')).toBeInTheDocument();
  });

  it('shows the skipped-importer-owned notice after an upload that had owned columns', async () => {
    stubFetch({ batches: [], upload: uploadResult({ skippedImporterOwnedKpis: ['KPI_X', 'KPI_Y'] }) });
    render(<SalesUploadPage />);
    await upload();
    const notice = await screen.findByTestId('skipped-importer-owned-kpis');
    expect(notice).toHaveTextContent('KPI_X, KPI_Y');
    expect(notice).toHaveTextContent(/come from Sales Import/);
  });

  it('no notice and no label for a tenant without Sales Import data (byte-identical UX)', async () => {
    stubFetch({ batches: [batch({})], upload: uploadResult() });
    render(<SalesUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('skipped-importer-owned-kpis')).not.toBeInTheDocument();
    // an all-unscoped tenant's response has NO ignoredOutOfScope key → no notice
    expect(screen.queryByTestId('ignored-out-of-scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Sales Import')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('APPLIES-TO D1: shows "N values ignored because the KPI doesn\'t apply…" with the saved rows remarks', async () => {
    stubFetch({ batches: [], upload: uploadResult({
      ignoredOutOfScope: 2,
      rows: [{ rowIndex: 3, outletCode: 'O1', status: 'accepted', remarks: 'Ignored (KPI not applicable): KPI_A, KPI_B' }],
    }) });
    render(<SalesUploadPage />);
    await upload();
    const notice = await screen.findByTestId('ignored-out-of-scope');
    expect(notice).toHaveTextContent("2 values ignored because the KPI doesn't apply to that outlet.");
    expect(notice).toHaveTextContent('Any value already stored for those cells is unchanged (hidden on screens, kept in exports).');
    expect(notice).toHaveTextContent('Row 3 — O1: Ignored (KPI not applicable): KPI_A, KPI_B');
  });

  it('APPLIES-TO D1: no notice for ignoredOutOfScope 0', async () => {
    stubFetch({ batches: [], upload: uploadResult({ ignoredOutOfScope: 0 }) });
    render(<SalesUploadPage />);
    await upload();
    expect(await screen.findByText('Upload Result')).toBeInTheDocument();
    expect(screen.queryByTestId('ignored-out-of-scope')).not.toBeInTheDocument();
  });
  it('batch delete refused with 409 → the server reason is shown verbatim (not "try again")', async () => {
    const reason = 'This upload batch is the only one left holding values for KPIs that do not apply to some of its outlets.';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({ success: false, error: reason }, 409);
      if (url.startsWith('/api/admin/achievements/batches')) return json({ success: true, data: [batch({})] });
      return json({ success: true, data: [] });
    }));
    render(<SalesUploadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' })); });
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/please try again/)).not.toBeInTheDocument();
  });

  it('batch delete failing with a non-409 keeps the generic retry message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({ success: false, error: 'boom' }, 500);
      if (url.startsWith('/api/admin/achievements/batches')) return json({ success: true, data: [batch({})] });
      return json({ success: true, data: [] });
    }));
    render(<SalesUploadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' })); });
    expect(await screen.findByText('Could not delete this upload — please try again.')).toBeInTheDocument();
  });
});
