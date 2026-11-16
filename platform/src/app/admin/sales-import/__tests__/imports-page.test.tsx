/// <reference types="vitest/globals" />
/**
 * /admin/sales-import — upload card + imports list (SALES-IMPORT-PIPELINE-PLAN §11 F-3).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/imports-page.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { SalesImportSummary } from '@/lib/sales-import/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const apiMock = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));

const uploadMock = vi.hoisted(() => ({ uploadInParts: vi.fn(), continueUpload: vi.fn(), readImportStatus: vi.fn() }));
vi.mock('@/lib/sales-import/upload', async (orig) => {
  const actual = await orig<typeof import('@/lib/sales-import/upload')>();
  return {
    ...actual,
    uploadInParts: uploadMock.uploadInParts,
    continueUpload: uploadMock.continueUpload,
    readImportStatus: uploadMock.readImportStatus,
  };
});
const perms = vi.hoisted(() => ({ granted: true }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {}, has: () => perms.granted }),
}));

import Page from '../page';
import { __resetUploadStoreForTests, releaseUploadForSessionChange } from '@/lib/sales-import/upload-store';
import type { UploadSession } from '@/lib/sales-import/upload';

function item(over: Partial<SalesImportSummary> = {}): SalesImportSummary {
  return {
    id: 'i1', status: 'READY', originalFilename: 'oct.xlsx', fileKind: 'XLSX', sizeBytes: 2 * 1024 * 1024, partCount: 1,
    partsReceived: 1, bytesRead: 0, rowsRead: 635430, rowsSkipped: 2, progressPct: null, duplicateOfId: null, error: null,
    detectedHeaders: null, createdAt: '2026-11-01T10:00:00.000Z', finishedAt: null, uploadedBy: 'Asha',
    queuedAt: null, heartbeatAt: null, stalled: false, applied: false, purgedAt: null, canReprocess: true, canCancel: false, canDelete: true, reprocessedFromId: null, canReprocessAsNew: false,
    ...over,
  };
}

const ok = <T,>(data: T) => ({ success: true as const, data });

function pick(file: File) {
  fireEvent.change(screen.getByTestId('sales-import-file-input'), { target: { files: [file] } });
}

beforeEach(() => {
  __resetUploadStoreForTests();
  apiMock.list.mockReset();
  apiMock.remove.mockReset();
  uploadMock.uploadInParts.mockReset();
  uploadMock.continueUpload.mockReset();
  uploadMock.readImportStatus.mockReset();
  push.mockReset();
  perms.granted = true;
});
afterEach(() => { vi.restoreAllMocks(); });

/** uploadInParts that creates the import (2 parts), confirms part 0, then fails on part 1. */
function failAfterFirstPart() {
  uploadMock.uploadInParts.mockImplementation(async (_f: File, opts: { onCreated?(id: string, s: UploadSession): void; onProgress(p: number): void }) => {
    const session: UploadSession = { importId: 'half', partSize: 4, partCount: 2, confirmed: new Set([0]) };
    opts.onCreated?.('half', session);
    opts.onProgress(0.5);
    throw new Error('Part 2 failed (HTTP 500).');
  });
}

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
    expect(await screen.findByText('6,35,430')).toBeInTheDocument();
    expect(await screen.findByText('Processing')).toBeInTheDocument();
    expect(await screen.findByText('Repeat file')).toBeInTheDocument();
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

  it('a failed upload KEEPS the import and offers Resume, which re-sends only the missing parts', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    uploadMock.continueUpload.mockResolvedValue('half');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Part 2 failed (HTTP 500). The parts already sent are kept');
    expect(alert.textContent).not.toContain('..');
    expect(apiMock.remove).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Resume upload \(50% sent\)/ })); });
    expect(uploadMock.continueUpload).toHaveBeenCalledTimes(1);
    const session = uploadMock.continueUpload.mock.calls[0][1] as UploadSession;
    expect(session.importId).toBe('half');
    expect([...session.confirmed]).toEqual([0]);
    expect(push).toHaveBeenCalledWith('/admin/sales-import/half');
  });

  it('Resume when the server already completed the import opens it instead of re-uploading', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValueOnce('UPLOADING').mockResolvedValue('QUEUED');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('alert');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Resume upload/ })); });
    expect(uploadMock.continueUpload).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/admin/sales-import/half');
  });

  it('Discard deletes only an import that is still UPLOADING', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValueOnce('UPLOADING').mockResolvedValue('QUEUED'); // completed meanwhile
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('alert');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard this upload' })); });
    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/admin/sales-import/half'); // it had finished — open it, never delete
  });

  it('Discard of a still-UPLOADING import deletes it', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.remove.mockResolvedValue(ok(null));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('alert');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard this upload' })); });
    expect(apiMock.remove).toHaveBeenCalledWith('half');
  });

  it('in-app link clicks ask first during an upload; "Stay" keeps the page', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [item()], nextCursor: null }));
    uploadMock.uploadInParts.mockImplementation(() => new Promise<string>(() => {}));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Page />);
    const link = await screen.findByRole('link', { name: 'oct.xlsx' });
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/keeps uploading in the background/));
    expect(ev.defaultPrevented).toBe(true);
  });

  it('the upload survives leaving the page (no abort on unmount)', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    let signal: AbortSignal | undefined;
    uploadMock.uploadInParts.mockImplementation((_f: File, opts: { signal?: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<string>(() => {});
    });
    const view = render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    view.unmount();
    expect(signal?.aborted).toBe(false);
    render(<Page />);
    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toBeInTheDocument();
  });

  it('an upload that finished while the user was on another page shows a banner on return (no redirect)', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    let finish!: (id: string) => void;
    uploadMock.uploadInParts.mockImplementation(() => new Promise<string>((res) => { finish = res; }));
    const view = render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    view.unmount();
    await act(async () => { finish('bg1'); });
    render(<Page />);
    const banner = await screen.findByTestId('sales-import-upload-finished');
    expect(await within(banner).findByRole('link', { name: 'Open the import' })).toHaveAttribute('href', '/admin/sales-import/bg1');
    expect(push).not.toHaveBeenCalled();
  });

  it('without targets:upload the upload card is replaced by a note', async () => {
    perms.granted = false;
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<Page />);
    expect(await screen.findByTestId('sales-import-upload-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('sales-import-file-input')).not.toBeInTheDocument();
  });

  it('a failed part on an import that was cancelled meanwhile resets honestly (no Resume)', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValue('CANCELLED');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This upload was cancelled or deleted — upload the file again.');
    expect(screen.queryByRole('button', { name: /Resume upload/ })).not.toBeInTheDocument();
    expect(apiMock.remove).not.toHaveBeenCalled();
  });

  it('Resume on an import deleted meanwhile (404) clears the session — no endless Resume', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValueOnce('UPLOADING').mockResolvedValue('GONE');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('button', { name: /Resume upload/ });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Resume upload/ })); });
    expect(uploadMock.continueUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('cancelled or deleted');
    expect(screen.queryByRole('button', { name: /Resume upload/ })).not.toBeInTheDocument();
  });

  it('Discard of an import cancelled meanwhile does not delete and resets', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValueOnce('UPLOADING').mockResolvedValue('CANCELLED');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('button', { name: 'Discard this upload' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard this upload' })); });
    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sales-import-upload-failed-actions')).not.toBeInTheDocument();
  });

  it('a failed upload blocks picking a new file; an invalid pick keeps Resume / Discard visible', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('button', { name: /Resume upload/ });
    expect(await screen.findByTestId('sales-import-dropzone')).toHaveAttribute('aria-disabled', 'true');
    pick(new File(['b'], 'other.csv'));
    expect(uploadMock.uploadInParts).toHaveBeenCalledTimes(1);
    pick(new File(['x'], 'bad.xls'));
    expect(await screen.findByRole('button', { name: /Resume upload/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Discard this upload' })).toBeInTheDocument();
  });

  it('Resume is disabled while a discard is running', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    failAfterFirstPart();
    let release!: (v: unknown) => void;
    uploadMock.readImportStatus.mockResolvedValueOnce('UPLOADING').mockImplementation(() => new Promise((r) => { release = r; }));
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('button', { name: /Resume upload/ });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Discard this upload' })); });
    expect(screen.getByRole('button', { name: /Resume upload/ })).toBeDisabled();
    apiMock.remove.mockResolvedValue(ok(null));
    await act(async () => { release('UPLOADING'); });
    expect(apiMock.remove).toHaveBeenCalledWith('half');
    expect(screen.queryByRole('button', { name: /Resume upload/ })).not.toBeInTheDocument();
  });

  it('cancel removes the import and re-lists the imports', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.remove.mockResolvedValue(ok(null));
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    uploadMock.uploadInParts.mockImplementation((_f: File, opts: { signal?: AbortSignal; onCreated?(id: string, s: UploadSession): void }) => {
      opts.onCreated?.('c1', { importId: 'c1', partSize: 4, partCount: 2, confirmed: new Set() });
      return new Promise<string>((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    render(<Page />);
    await screen.findByText(/No files uploaded yet/);
    const listCalls = apiMock.list.mock.calls.length;
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cancel/ })); });
    expect(apiMock.remove).toHaveBeenCalledWith('c1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload cancelled. Nothing was imported.');
    expect(apiMock.list.mock.calls.length).toBeGreaterThan(listCalls);
  });

  it('logout / brand switch mid-upload: asks; "stay" vetoes; "continue" cancels + deletes with the current session', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.remove.mockResolvedValue(ok(null));
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    uploadMock.uploadInParts.mockImplementation((_f: File, opts: { signal?: AbortSignal; onCreated?(id: string, s: UploadSession): void }) => {
      opts.onCreated?.('s1', { importId: 's1', partSize: 4, partCount: 2, confirmed: new Set() });
      return new Promise<string>((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    let allowed = true;
    await act(async () => { allowed = await releaseUploadForSessionChange('switch-brand'); });
    expect(allowed).toBe(false);
    expect(confirm.mock.calls[0][0]).toMatch(/Switching brand cancels it/);
    expect(apiMock.remove).not.toHaveBeenCalled();
    await act(async () => { allowed = await releaseUploadForSessionChange('logout'); });
    expect(allowed).toBe(true);
    expect(apiMock.remove).toHaveBeenCalledWith('s1');
  });

  it('the upload stops (and deletes nothing) when the user / brand changes mid-upload', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'A', role: 'CLIENT_ADMIN', phone: '' }));
    uploadMock.uploadInParts.mockImplementation(async (_f: File, opts: { guard?(): void; onCreated?(id: string, s: UploadSession): void }) => {
      opts.onCreated?.('t1', { importId: 't1', partSize: 4, partCount: 2, confirmed: new Set() });
      localStorage.setItem('assumedBrand', 'Other brand'); // switched in another tab
      opts.guard?.();
      return 't1';
    });
    try {
      render(<Page />);
      pick(new File(['a'], 'dms.csv'));
      expect(await screen.findByRole('alert')).toHaveTextContent('You signed out or switched brand during the upload');
      expect(apiMock.remove).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    } finally {
      localStorage.removeItem('user');
      localStorage.removeItem('assumedBrand');
    }
  });

  it('a forced session change (logout-all) never prompts and still cleans up', async () => {
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.remove.mockResolvedValue(ok(null));
    uploadMock.readImportStatus.mockResolvedValue('UPLOADING');
    uploadMock.uploadInParts.mockImplementation((_f: File, opts: { signal?: AbortSignal; onCreated?(id: string, s: UploadSession): void }) => {
      opts.onCreated?.('f1', { importId: 'f1', partSize: 4, partCount: 2, confirmed: new Set() });
      return new Promise<string>((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(<Page />);
    pick(new File(['a'], 'dms.csv'));
    await screen.findByRole('progressbar', { name: 'Upload progress' });
    let allowed = false;
    await act(async () => { allowed = await releaseUploadForSessionChange('logout', { force: true }); });
    expect(allowed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(apiMock.remove).toHaveBeenCalledWith('f1');
  });
});
