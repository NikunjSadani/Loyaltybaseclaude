/// <reference types="vitest/globals" />
/**
 * Cancel payouts dialog (owner 2026-11-25): the preview lists exactly what will be cancelled + every row that will not
 * (with its reason); Cancel stays disabled until the refused rows are acknowledged, a reason is given and the check
 * box is ticked; the apply sends exactly the previewed rows (status + amount); a whole-request refusal is shown with
 * its list and "Reload preview" — nothing reported as cancelled.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CancelPayoutsDialog from '../CancelPayoutsDialog';

const row = (id: string, paise: number, status = 'PENDING') => ({
  entryId: id, batchId: 'b1', batchCode: 'CB-1', outletId: `O-${id}`, outletName: `Shop ${id}`, fieldId: 'f1', fieldName: 'Volume',
  period: '2026-10', amountPaise: paise, status, kind: status === 'FAILED' ? 'FAILED' : 'UNPAID', downloadCode: null,
  failureReason: null, attemptedAt: null, autoInvoiceId: null,
});
const PREVIEW = {
  kind: 'UNPAID',
  ok: [row('e1', 10000), row('e2', 2500)],
  blocked: [{ entryId: 'e3', code: 'PAID', reason: 'Already paid — a paid payout cannot be cancelled (use a reversal)', row: row('e3', 5000, 'PAID') }],
  invoicesToVoid: [],
  totals: { unpaid: { count: 2, paise: 12500 }, failed: { count: 0, paise: 0 }, all: { count: 2, paise: 12500 } },
};
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

afterEach(() => vi.restoreAllMocks());

function open() {
  const onDone = vi.fn();
  render(
    <CancelPayoutsDialog
      request={{ kind: 'UNPAID', batchId: 'b1', scopeLabel: 'All unpaid rows in this upload' }}
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  return { onDone };
}

describe('CancelPayoutsDialog', () => {
  it('lists what will and will not be cancelled; Cancel waits for acknowledgement + reason + check; sends exactly the previewed rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok(PREVIEW) as never)
      .mockResolvedValueOnce(ok({ cancellationId: 'c1', cancelled: PREVIEW.ok, invoicesVoided: [], totals: PREVIEW.totals }) as never);
    const { onDone } = open();
    expect(await screen.findByTestId('cancel-ok-e1')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-blocked-list').textContent).toMatch(/Already paid/);
    const submit = screen.getByRole('button', { name: /Cancel 2 payouts/ });
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('cancel-submit-hint').textContent).toMatch(/acknowledge.*reason.*checked/);

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand these .* will NOT be cancelled/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Uploaded twice' } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I have checked/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await screen.findByTestId('cancel-done');
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toEqual({
      kind: 'UNPAID',
      reason: 'Uploaded twice',
      items: [
        { id: 'e1', expectedStatus: 'PENDING', expectedAmountPaise: 10000 },
        { id: 'e2', expectedStatus: 'PENDING', expectedAmountPaise: 2500 },
      ],
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a whole-request refusal (409) shows the list and Reload preview — nothing reported as cancelled', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ ...PREVIEW, blocked: [] }) as never)
      .mockResolvedValueOnce({
        ok: false, status: 409,
        json: async () => ({ success: false, error: 'Nothing was cancelled — 1 of 2 rows can’t be cancelled', details: { blocked: [{ entryId: 'e2', code: 'IN_BANK_FILE', reason: 'In a bank file that is with the bank now', row: row('e2', 2500, 'PROCESSING') }] } }),
      } as never);
    const { onDone } = open();
    await screen.findByTestId('cancel-ok-e1');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText(/I have checked/));
    fireEvent.click(screen.getByRole('button', { name: /Cancel 2 payouts/ }));
    const refused = await screen.findByTestId('cancel-refused');
    expect(refused.textContent).toMatch(/Nothing was cancelled/);
    expect(screen.getByTestId('cancel-refused-list').textContent).toMatch(/with the bank now/);
    expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
    await waitFor(() => expect(onDone).not.toHaveBeenCalled());
  });
});
