/// <reference types="vitest/globals" />
/**
 * "Cancel payouts — upload file": Apply only ever runs on the preview shown — changing the file or the reason clears
 * the preview; Apply sends previewedEntryIds; a 409 drift refusal (details.added / removed) is shown with its lists
 * and "Preview again", nothing reported as cancelled; onApplied after a successful apply.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CancelPayoutsFileSection from '../CancelPayoutsFileSection';

const ROW = {
  entryId: 'e1', batchId: 'b1', batchCode: 'CB-1', outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1',
  fieldName: 'Volume', period: '2026-10', amountPaise: 10000, status: 'PENDING', kind: 'UNPAID',
  downloadCode: null, failureReason: null, attemptedAt: null, autoInvoiceId: null, rowNum: 2, reason: 'dup',
};
const PREVIEW = {
  applied: false, fileName: 'cancel.xlsx', headerError: null, notMarked: 0, ok: [ROW], blocked: [],
  invoicesToVoid: [], canApply: true,
  totals: { unpaid: { count: 1, paise: 10000 }, failed: { count: 0, paise: 0 }, all: { count: 1, paise: 10000 } },
};
const APPLIED = {
  applied: true, cancellationId: 'c1', cancelled: [ROW], invoicesVoided: [], notCancelled: [],
  totals: PREVIEW.totals,
};

type Answer = { status: number; body: unknown };
function stub(answer: (fd: FormData) => Answer) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const a = answer(init?.body as FormData);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function pickFile() {
  fireEvent.change(screen.getByLabelText('Cancellation file'), {
    target: { files: [new File([new Uint8Array([1])], 'cancel.xlsx')] },
  });
}

async function checkAndConfirm() {
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Check file' }));
  await screen.findByTestId('cancel-file-preview');
  fireEvent.click(screen.getByLabelText('I have checked the rows and amounts above'));
}

describe('CancelPayoutsFileSection', () => {
  it('changing the reason clears the preview (Apply can only run on the preview shown)', async () => {
    stub(() => ({ status: 200, body: { success: true, data: PREVIEW } }));
    render(<CancelPayoutsFileSection />);
    await checkAndConfirm();
    fireEvent.change(screen.getByLabelText('Reason for the whole file'), { target: { value: 'new reason' } });
    expect(screen.queryByTestId('cancel-file-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel 1 payout/ })).toBeNull();
  });

  it('Apply sends previewedEntryIds and calls onApplied on success', async () => {
    const fn = stub((fd) => fd.get('apply') === 'true'
      ? { status: 200, body: { success: true, data: APPLIED } }
      : { status: 200, body: { success: true, data: PREVIEW } });
    const onApplied = vi.fn();
    render(<CancelPayoutsFileSection onApplied={onApplied} />);
    await checkAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel 1 payout/ }));
    expect(await screen.findByTestId('cancel-file-applied')).toBeInTheDocument();
    const applyFd = fn.mock.calls[1][1]?.body as FormData;
    expect(applyFd.get('apply')).toBe('true');
    expect(JSON.parse(String(applyFd.get('previewedEntryIds')))).toEqual(['e1']);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('a 409 drift refusal shows the added / removed rows and "Preview again"; nothing reported as cancelled', async () => {
    stub((fd) => fd.get('apply') === 'true'
      ? { status: 409, body: {
          success: false,
          error: 'The rows to cancel changed since the preview.',
          details: { added: [{ entryId: 'e9', rowNum: 7, outletId: 'O9' }], removed: [{ entryId: 'e1' }] },
        } }
      : { status: 200, body: { success: true, data: PREVIEW } });
    const onApplied = vi.fn();
    render(<CancelPayoutsFileSection onApplied={onApplied} />);
    await checkAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel 1 payout/ }));
    const refused = await screen.findByTestId('cancel-file-refused');
    expect(refused.textContent).toContain('Nothing was cancelled. The rows to cancel changed since the preview.');
    expect(screen.getByTestId('cancel-file-drift-added').textContent).toContain('Row 7 · O9');
    expect(screen.getByTestId('cancel-file-drift-removed').textContent).toContain('e1');
    expect(screen.queryByTestId('cancel-file-applied')).toBeNull();
    expect(screen.queryByTestId('cancel-file-preview')).toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(screen.getByTestId('cancel-file-preview')).toBeInTheDocument());
    expect(screen.queryByTestId('cancel-file-refused')).toBeNull();
  });
});
