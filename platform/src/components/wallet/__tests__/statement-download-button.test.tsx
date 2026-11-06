/// <reference types="vitest/globals" />
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { StatementDoc } from '@/lib/wallet-statement/statement-model';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));
const statementToXlsxBlob = vi.fn(() => new Blob(['x']));
vi.mock('@/lib/wallet-statement/statement-xlsx', () => ({
  statementToXlsxBlob: (...a: unknown[]) => statementToXlsxBlob(...(a as [])),
}));
const statementToPdfBlob = vi.fn(async () => new Blob(['p']));
vi.mock('@/lib/wallet-statement/statement-pdf', () => ({
  statementToPdfBlob: (...a: unknown[]) => statementToPdfBlob(...(a as [])),
}));

import { StatementDownloadButton } from '../statement-download-button';

const DOC = { title: 'Wallet Statement', lines: [] } as unknown as StatementDoc;

function setup(props: Partial<React.ComponentProps<typeof StatementDownloadButton>> = {}) {
  const loadDoc = props.loadDoc ?? vi.fn(async () => DOC);
  render(<StatementDownloadButton disabled={false} fileBase="x" {...props} loadDoc={loadDoc} />);
  return { loadDoc, button: screen.getByTestId('statement-download-btn') };
}

describe('StatementDownloadButton', () => {
  beforeEach(() => {
    downloadBlob.mockReset();
    statementToXlsxBlob.mockClear();
    statementToPdfBlob.mockClear();
  });

  it('is disabled when `disabled` and the menu cannot open', () => {
    const { button } = setup({ disabled: true });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a menu with Excel and PDF menuitems; Escape closes it', () => {
    const { button } = setup();
    expect(button).toHaveTextContent('Download');
    fireEvent.click(button);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Excel (.xlsx)', 'PDF']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('an outside click closes the menu', () => {
    const { button } = setup();
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Excel loads the doc, renders xlsx and saves x.xlsx', async () => {
    const { button, loadDoc } = setup();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(loadDoc).toHaveBeenCalledTimes(1);
    expect(statementToXlsxBlob).toHaveBeenCalledWith(DOC);
    expect(downloadBlob.mock.calls[0][1]).toBe('x.xlsx');
    expect(statementToPdfBlob).not.toHaveBeenCalled();
  });

  it('sanitises the file name (outlet codes may carry /, spaces etc.)', async () => {
    const { button } = setup({ fileBase: 'wallet-statement-OUT/12 A.B-2026-04_2026-05' });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob.mock.calls[0][1]).toBe('wallet-statement-OUT-12-A-B-2026-04_2026-05.xlsx');
  });

  it('PDF loads the doc, renders pdf and saves x.pdf', async () => {
    const { button } = setup();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'PDF' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(statementToPdfBlob).toHaveBeenCalledWith(DOC);
    expect(downloadBlob.mock.calls[0][1]).toBe('x.pdf');
  });

  it('while loading the button is busy/disabled, so a second click triggers no second download', async () => {
    let resolve!: (d: StatementDoc) => void;
    const loadDoc = vi.fn(() => new Promise<StatementDoc>((r) => { resolve = r; }));
    const { button } = setup({ loadDoc });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    expect(button).toBeDisabled();
    fireEvent.click(button); // menu can't reopen while busy
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => resolve(DOC));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(loadDoc).toHaveBeenCalledTimes(1);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("a failed load shows \"Couldn't download. Try again.\" and re-enables the button", async () => {
    const { button } = setup({ loadDoc: vi.fn(async () => { throw new Error('boom'); }) });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'PDF' }));
    expect(await screen.findByText("Couldn't download. Try again.")).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
