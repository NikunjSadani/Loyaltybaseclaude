/// <reference types="vitest/globals" />
/**
 * /admin/sales-import — upload card + imports list (SALES-IMPORT-PIPELINE-PLAN §11 F-3).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/imports-page.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SalesImportSummary } from '@/lib/sales-import/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const apiMock = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));

const uploadMock = vi.hoisted(() => ({ uploadInParts: vi.fn() }));
vi.mock('@/lib/sales-import/upload', async (orig) => {
  const actual = await orig<typeof import('@/lib/sales-import/upload')>();
  return { ...actual, uploadInParts: uploadMock.uploadInParts };
});

import Page from '../page';

function item(over: Partial<SalesImportSummary> = {}): SalesImportSummary {
  return {
    id: 'i1', status: 'READY', originalFilename: 'oct.xlsx', fileKind: 'XLSX', sizeBytes: 2 * 1024 * 1024, partCount: 1,
    partsReceived: 1, bytesRead: 0, rowsRead: 635430, rowsSkipped: 2, progressPct: null, duplicateOfId: null, error: null,
    detectedHeaders: null, createdAt: '2026-11-01T10:00:00.000Z', finishedAt: null, uploadedBy: 'Asha', ...over,
  };
}

const ok = <T,>(data: T) => ({ success: true as const, data });

function pick(file: File) {
  fireEvent.change(screen.getByTestId('sales-import-file-input'), { target: { files: [file] } });
}

beforeEach(() => {
  apiMock.list.mockReset();
  apiMock.remove.mockReset();
  uploadMock.uploadInParts.mockReset();
  push.mockReset();
});

describe('imports page', () => {
  it('states the one-row-per-invoice-line limit', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<Page />);
    expect(screen.getByText(/one row per invoice line/)).toBeInTheDocument();
    expect(await screen.findByText(/No files uploaded yet/)).toBeInTheDocument();
  });

  it('lists imports with status, rows, uploader and a repeat-file badge', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [item(), item({ id: 'i2', status: 'PROCESSING', duplicateOfId: 'i1', originalFilename: 'oct-again.xlsx', rowsRead: 0 })], nextCursor: null }));
    render(<Page />);
    const link = await screen.findByRole('link', { name: 'oct.xlsx' });
    expect(link).toHaveAttribute('href', '/admin/sales-import/i1');
    expect(screen.getByText('6,35,430')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Repeat file')).toBeInTheDocument();
  });

  it('list error → retry', async () => {
    apiMock.list.mockResolvedValueOnce({ success: false, error: 'HTTP 500' }).mockResolvedValue(ok({ items: [item()], nextCursor: null }));
    render(<Page />);
    expect(await screen.findByText(/Couldn't load imports: HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'oct.xlsx' })).toBeInTheDocument();
  });

  it('rejects a wrong file type without uploading', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<Page />);
    pick(new File(['x'], 'pivot.xls'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only .xlsx or .csv');
    expect(uploadMock.uploadInParts).not.toHaveBeenCalled();
  });

  it('uploads with progress, guards double submit, then opens the import', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    let finish!: (id: string) => void;
    uploadMock.uploadInParts.mockImplementation((_f: File, opts: { onProgress(p: number): void }) => {
      opts.onProgress(0.5);
      return new Promise<string>((res) => { finish = res; });
    });
    render(<Page />);
    pick(new File(['a,b\n1,2'], 'dms.csv'));
    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '50');
    pick(new File(['a,b\n1,2'], 'dms2.csv')); // second pick while uploading is ignored
    expect(uploadMock.uploadInParts).toHaveBeenCalledTimes(1);
    await act(async () => { finish('newImp'); });
    expect(push).toHaveBeenCalledWith('/admin/sales-import/newImp');
  });

  it('warns before leaving the page during an upload', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    uploadMock.uploadInParts.mockImplementation(() => new Promise<string>(() => {}));
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a failed upload shows the error and cleans up the half-created import', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.remove.mockResolvedValue(ok(null));
    uploadMock.uploadInParts.mockImplementation(async (_f: File, opts: { onCreated?(id: string): void }) => {
      opts.onCreated?.('half');
      throw new Error('Part 3 failed (HTTP 500)');
    });
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Part 3 failed');
    expect(apiMock.remove).toHaveBeenCalledWith('half');
    expect(push).not.toHaveBeenCalled();
  });
});
