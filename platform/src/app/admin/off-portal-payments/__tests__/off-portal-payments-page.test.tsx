/// <reference types="vitest/globals" />
/**
 * OFF-PORTAL PAYMENTS — /admin/off-portal-payments (register + upload + void).
 *  O1: preview → one checkbox per warning; Confirm disabled until EVERY one is ticked; confirm sends the same file +
 *      fingerprint + the ticked categories; the server message is shown and the register reloads
 *  O2: a 400 on confirm (e.g. missing tick) shows the server's message text; nothing is claimed as recorded
 *  O3: a preview error (bad file) is shown as-is; no preview / Confirm
 *  O4: Confirm double-click → ONE request (in flight)
 *  O5: Void needs a reason of at least 5 characters; sends { reason }; shows the server message; reloads
 *  O6: read-only (CLIENT_ADMIN: canWrite false, piiMasked) → no upload, no Void, the masked-PII note
 *  O7: a failed register load → error with retry; empty register → empty state
 * Run: npx vitest run src/app/admin/off-portal-payments/__tests__/off-portal-payments-page.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OffPortalPaymentsPage from '../page';

const ROW = {
  id: 'op1', uploadId: 'up1', rowNumber: 2, outletCode: 'BJ-001', outletName: 'Shree Stores', onPortalAtUpload: true, onPortalNow: true,
  phone: '9876543210', panNumber: 'ABCDE1234F', panSource: 'FILE', bankAccountNumber: '123456789012', ifsc: 'HDFC0001234', upiId: null,
  amountPaise: '150000', paymentDate: '2026-11-10', utr: 'UTR123', payoutStream: 'VISIBILITY', paymentMode: 'CASH', period: '2026-10',
  narration: null, tdsSection: '194R', tdsMethodology: 'DEDUCT', flags: ['NO_PAN'], replacesTdsEntry: false, voidedAt: null, voidReason: null,
  createdAt: '2026-11-20T10:00:00.000Z',
};

function list(over: Record<string, unknown> = {}) {
  return {
    page: 1, pageSize: 50, totalRows: 1, totalPages: 1,
    totals: { count: 1, amountPaise: '150000', liveCount: 1, liveAmountPaise: '150000' },
    piiMasked: false, canWrite: true, rows: [ROW], ...over,
  };
}

const PREVIEW = {
  fileSha256: 'a'.repeat(64), rowsInFile: 3, blankRows: 0, recordableCount: 2, recordableTotalPaise: '250000', invalidCount: 1,
  tdsPolicy: { visibilitySection: '194R', methodology: 'DEDUCT' },
  categories: [
    { category: 'INVALID', label: 'Rows with errors — they will NOT be recorded', count: 1 },
    { category: 'NEW_PAYEE', label: 'Outlet IDs not on the portal', count: 1 },
  ],
  requiredAcknowledgements: ['INVALID', 'NEW_PAYEE'],
  invalid: [{ rowNumber: 4, outletCode: 'BJ-X', outletName: 'Bad Row', errors: ['Amount is not a number'] }],
  invalidTruncated: false,
  rows: [
    { rowNumber: 2, outletCode: 'BJ-001', outletName: 'Shree Stores', onPortal: true, portalOutletName: 'Shree Stores', amountPaise: '150000', paymentDate: '2026-11-10', period: '2026-10', payoutStream: 'VISIBILITY', paymentMode: 'CASH', utr: 'UTR123', panNumber: 'ABCDE1234F', panSource: 'FILE', tdsSection: '194R', flags: [], notes: [] },
    { rowNumber: 3, outletCode: 'NEW-9', outletName: 'New Outlet', onPortal: false, portalOutletName: null, amountPaise: '100000', paymentDate: '2026-11-11', period: '2026-10', payoutStream: 'INCENTIVE', paymentMode: 'GIFT', utr: null, panNumber: null, panSource: 'NONE', tdsSection: '194R', tdsMethodology: 'GROSS_UP', tdsKey: 'NOPAN:client:NEW-9', tdsTreatment: "194R · borne by the client (gross-up) · this Outlet ID's no-PAN key", flags: ['NEW_PAYEE'], notes: ['Recorded as an off-portal payee'] },
  ],
  rowsTruncated: false,
};

type Res = { status?: number; body: unknown };
type Handler = (url: string, init?: RequestInit) => Res | Promise<Res | undefined> | undefined;

function stubFetch(over: Handler = () => undefined, reg: unknown = list()) {
  const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const custom = await over(u, init);
    const res: Res = custom ?? (
      u.includes('/off-portal-payments/uploads') ? { body: { success: true, data: [] } }
        : u.includes('/off-portal-payments/preview') ? { body: { success: true, data: PREVIEW } }
        : u.includes('/off-portal-payments?') || u.endsWith('/off-portal-payments') ? { body: { success: true, data: reg } }
        : { body: { success: true, data: {} } }
    );
    const status = res.status ?? 200;
    return { ok: status < 400, status, json: () => Promise.resolve(res.body) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof vi.fn>, path: string) =>
  fn.mock.calls.filter((c) => String(c[0]).includes(path) && (c[1] as RequestInit | undefined)?.method === 'POST');
const listCalls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.filter((c) => /\/off-portal-payments(\?|$)/.test(String(c[0])) && !(c[1] as RequestInit | undefined)?.method);

function chooseFile() {
  const file = new File(['xlsx-bytes'], 'paid.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  fireEvent.change(screen.getByLabelText(/Filled template/), { target: { files: [file] } });
  return file;
}

async function previewFile() {
  render(<OffPortalPaymentsPage />);
  await screen.findByTestId('opp-register-table');
  const file = chooseFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByTestId('opp-preview');
  return file;
}

const confirmBtn = () => screen.getByRole('button', { name: /^Confirm — record 2 payments/ });
const openCat = (c: string) => fireEvent.click(screen.getByTestId(`opp-cat-toggle-${c}`));
function openAndTickAll(cats = ['INVALID', 'NEW_PAYEE']) {
  for (const c of cats) {
    openCat(c);
    fireEvent.click(screen.getByTestId(`opp-ack-${c}`));
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('OFF-PORTAL PAYMENTS — /admin/off-portal-payments', () => {
  it('O1: every warning must be ticked before Confirm; confirm sends file + fingerprint + ticks; message shown', async () => {
    const fn = stubFetch((u) =>
      u.includes('/confirm')
        ? { status: 201, body: { success: true, data: { uploadId: 'up2', recorded: 2, recordedTotalPaise: '250000', skippedInvalid: 1, acknowledged: {}, message: 'Recorded 2 off-portal payments (₹2,500.00); 1 row with errors NOT recorded.' } } }
        : undefined,
    );
    const file = await previewFile();

    // Summary + full row table (flags, notes, TDS treatment + key visible).
    expect(screen.getByTestId('opp-recordable')).toHaveTextContent('2 · ₹2,500.00');
    const prev = screen.getByTestId('opp-preview-table');
    expect(within(prev).getByText('Not on portal')).toBeInTheDocument();
    expect(within(prev).getByText('Recorded as an off-portal payee')).toBeInTheDocument();
    expect(within(prev).getByText(/194R · borne by the client \(gross-up\)/)).toBeInTheDocument();
    expect(within(prev).getByText('NOPAN:client:NEW-9')).toBeInTheDocument();

    // B1: a checkbox is disabled until its category's rows have been opened.
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('opp-ack-INVALID')).toBeDisabled();
    expect(screen.getByTestId('opp-ack-NEW_PAYEE')).toBeDisabled();
    openCat('INVALID');
    expect(within(screen.getByTestId('opp-cat-table-INVALID')).getByText('Amount is not a number')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('opp-ack-INVALID'));
    expect(confirmBtn()).toBeDisabled();
    openCat('NEW_PAYEE');
    expect(within(screen.getByTestId('opp-cat-table-NEW_PAYEE')).getByText('New Outlet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('opp-ack-NEW_PAYEE'));
    expect(confirmBtn()).toBeEnabled();
    // Un-ticking one disables it again.
    fireEvent.click(screen.getByTestId('opp-ack-INVALID'));
    expect(confirmBtn()).toBeDisabled();
    fireEvent.click(screen.getByTestId('opp-ack-INVALID'));

    const before = listCalls(fn).length;
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId('opp-confirm-success')).toHaveTextContent('Recorded 2 off-portal payments (₹2,500.00); 1 row with errors NOT recorded.');
    const [, init] = calls(fn, '/off-portal-payments/confirm')[0];
    const body = (init as RequestInit).body as FormData;
    expect(body.get('file')).toBe(file);
    expect(body.get('fileSha256')).toBe(PREVIEW.fileSha256);
    expect(body.get('acknowledged')).toBe('INVALID,NEW_PAYEE');
    expect(screen.queryByTestId('opp-preview')).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls(fn).length).toBeGreaterThan(before));
  });

  it('O2: a 400 on confirm (no missing-tick details) shows the server message text', async () => {
    stubFetch((u) =>
      u.includes('/confirm')
        ? { status: 400, body: { success: false, error: 'Tick every warning before confirming — not ticked: No PAN (3). Nothing was recorded.' } }
        : undefined,
    );
    await previewFile();
    openAndTickAll();
    fireEvent.click(confirmBtn());
    expect(await screen.findByText(/not ticked: No PAN \(3\)\. Nothing was recorded\./)).toBeInTheDocument();
    expect(screen.queryByTestId('opp-confirm-success')).not.toBeInTheDocument();
    // The preview stays so the admin can fix the ticks and retry.
    expect(screen.getByTestId('opp-preview')).toBeInTheDocument();
  });

  it('O3: a preview error is shown as-is (no preview, no Confirm)', async () => {
    stubFetch((u) => (u.includes('/preview') ? { status: 400, body: { success: false, error: 'Missing column: Amount (₹)' } } : undefined));
    render(<OffPortalPaymentsPage />);
    await screen.findByTestId('opp-register-table');
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Missing column: Amount (₹)')).toBeInTheDocument();
    expect(screen.queryByTestId('opp-preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm/ })).not.toBeInTheDocument();
  });

  it('O4: a double-clicked Confirm sends ONE request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = stubFetch(async (u) => {
      if (!u.includes('/confirm')) return undefined;
      await gate;
      return { status: 201, body: { success: true, data: { uploadId: 'u', recorded: 2, recordedTotalPaise: '250000', skippedInvalid: 0, acknowledged: {}, message: 'Recorded 2.' } } };
    });
    await previewFile();
    openAndTickAll();
    const btn = confirmBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByRole('button', { name: 'Recording…' })).toBeDisabled();
    release();
    await screen.findByTestId('opp-confirm-success');
    expect(calls(fn, '/off-portal-payments/confirm')).toHaveLength(1);
  });

  it('O8 (B1): a category lists EVERY row, paged 50 at a time, with its own filter; the full table filters by category', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...PREVIEW.rows[1], rowNumber: 10 + i, outletCode: `NP-${i + 1}`, outletName: `Payee ${i + 1}`, flags: ['NO_PAN'], notes: [],
    }));
    const big = {
      ...PREVIEW, recordableCount: 122, rows: [PREVIEW.rows[0], PREVIEW.rows[1], ...many],
      categories: [...PREVIEW.categories, { category: 'NO_PAN', label: 'No PAN in the file or on the portal', count: 120 }],
      requiredAcknowledgements: ['INVALID', 'NEW_PAYEE', 'NO_PAN'],
    };
    stubFetch((u) => (u.includes('/preview') ? { body: { success: true, data: big } } : undefined));
    await previewFile();
    openCat('NO_PAN');
    const sec = screen.getByTestId('opp-cat-NO_PAN');
    expect(within(sec).getByText('Rows 1–50 of 120 · page 1 of 3')).toBeInTheDocument();
    expect(within(sec).getByText('Payee 1')).toBeInTheDocument();
    expect(within(sec).queryByText('Payee 51')).not.toBeInTheDocument();
    fireEvent.click(within(sec).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(sec).getByRole('button', { name: 'Next' }));
    expect(within(sec).getByText('Rows 101–120 of 120 · page 3 of 3')).toBeInTheDocument();
    expect(within(sec).getByText('Payee 120')).toBeInTheDocument();
    fireEvent.change(within(sec).getByLabelText('Filter these rows'), { target: { value: 'NP-77' } });
    expect(within(sec).getByText('1 of 120 rows match')).toBeInTheDocument();
    expect(within(sec).getByText('Payee 77')).toBeInTheDocument();

    // Full table: category filter.
    fireEvent.change(screen.getByLabelText('Warning'), { target: { value: '__NONE__' } });
    const all = screen.getByTestId('opp-preview-table');
    expect(within(all).getByText('Shree Stores')).toBeInTheDocument();
    expect(within(all).queryByText('New Outlet')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Warning'), { target: { value: 'NEW_PAYEE' } });
    expect(within(screen.getByTestId('opp-preview-table')).getByText('New Outlet')).toBeInTheDocument();
  });

  it('O9 (B3): a confirm refused for a missing tick re-runs the preview and shows the new warning, Confirm off until ticked', async () => {
    const updated = {
      ...PREVIEW,
      rows: [PREVIEW.rows[0], { ...PREVIEW.rows[1], flags: ['NEW_PAYEE', 'POSSIBLE_DUPLICATE'] }],
      categories: [...PREVIEW.categories, { category: 'POSSIBLE_DUPLICATE', label: 'Possible repeat — same outlet, same amount within 3 days', count: 1 }],
      requiredAcknowledgements: ['INVALID', 'NEW_PAYEE', 'POSSIBLE_DUPLICATE'],
    };
    let previews = 0;
    let confirms = 0;
    const fn = stubFetch((u) => {
      if (u.includes('/preview')) { previews += 1; return { body: { success: true, data: previews === 1 ? PREVIEW : updated } }; }
      if (u.includes('/confirm')) {
        confirms += 1;
        return confirms === 1
          ? { status: 400, body: { success: false, error: 'Tick every warning before confirming — not ticked: Possible repeat (1). Nothing was recorded.', details: { missingAcknowledgements: ['POSSIBLE_DUPLICATE'] } } }
          : { status: 201, body: { success: true, data: { uploadId: 'u2', recorded: 2, recordedTotalPaise: '250000', skippedInvalid: 1, acknowledged: {}, message: 'Recorded 2 off-portal payments.' } } };
      }
      return undefined;
    });
    const file = await previewFile();
    openAndTickAll();
    fireEvent.click(confirmBtn());

    const banner = await screen.findByTestId('opp-preview-updated');
    expect(banner).toHaveTextContent('Preview updated — review the new warning');
    expect(banner).toHaveTextContent('Possible repeat — same outlet, same amount within 3 days');
    expect(previews).toBe(2);
    const secondPreview = calls(fn, '/off-portal-payments/preview')[1];
    expect(((secondPreview[1] as RequestInit).body as FormData).get('file')).toBe(file);
    // Unchanged categories keep their ticks; the new one is unticked, disabled until opened, Confirm off.
    expect(screen.getByTestId('opp-ack-NEW_PAYEE')).toBeChecked();
    expect(screen.getByTestId('opp-ack-POSSIBLE_DUPLICATE')).not.toBeChecked();
    expect(screen.getByTestId('opp-ack-POSSIBLE_DUPLICATE')).toBeDisabled();
    expect(confirmBtn()).toBeDisabled();
    openCat('POSSIBLE_DUPLICATE');
    expect(within(screen.getByTestId('opp-cat-table-POSSIBLE_DUPLICATE')).getByText('New Outlet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('opp-ack-POSSIBLE_DUPLICATE'));
    expect(confirmBtn()).toBeEnabled();
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId('opp-confirm-success')).toHaveTextContent('Recorded 2 off-portal payments.');
    expect(((calls(fn, '/confirm')[1][1] as RequestInit).body as FormData).get('acknowledged')).toBe('INVALID,NEW_PAYEE,POSSIBLE_DUPLICATE');
  });

  it('O10 (B8): upload history says recorded · voided · counting with the counting amount', async () => {
    stubFetch((u) =>
      u.includes('/uploads')
        ? { body: { success: true, data: [{ id: 'up1', fileName: 'oct.xlsx', rowsInFile: 12, recordedCount: 10, skippedCount: 2, totalPaise: '1000000', voidedCount: 3, voidedPaise: '250000', countingCount: 7, countingPaise: '750000', acknowledged: { NO_PAN: 4 }, uploadedBy: 'Ops', createdAt: '2026-11-20T10:00:00.000Z' }] } }
        : undefined,
    );
    render(<OffPortalPaymentsPage />);
    expect(await screen.findByTestId('opp-history-counting')).toHaveTextContent('Recorded 10 · voided 3 · counting 7 (₹7,500.00)');
  });

  it('O5: Void requires a reason (≥ 5 characters), sends it, shows the message and reloads', async () => {
    const fn = stubFetch((u) =>
      u.includes('/op1/void')
        ? { body: { success: true, data: { id: 'op1', voidedAt: '2026-11-26T05:00:00.000Z', message: 'Voided ₹1,500.00 paid on 2026-11-10: it no longer counts in TDS, payout history or the payments report.' } } }
        : undefined,
    );
    render(<OffPortalPaymentsPage />);
    const table = await screen.findByTestId('opp-register-table');
    fireEvent.click(within(table).getByRole('button', { name: /^Void ₹1,500\.00 paid to BJ-001/ }));
    const submit = await screen.findByRole('button', { name: 'Void payment' });
    expect(submit).toBeDisabled();
    const reason = screen.getByLabelText(/Reason \(required/);
    fireEvent.change(reason, { target: { value: '  abc ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'Duplicate of row 7' } });
    expect(submit).toBeEnabled();
    const before = listCalls(fn).length;
    fireEvent.click(submit);
    expect(await screen.findByTestId('opp-notice')).toHaveTextContent(/Voided ₹1,500\.00 paid on 2026-11-10/);
    const [, init] = calls(fn, '/op1/void')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'Duplicate of row 7' });
    await waitFor(() => expect(listCalls(fn).length).toBeGreaterThan(before));
  });

  it('O5b: a void error is shown in the dialog', async () => {
    stubFetch((u) => (u.includes('/void') ? { status: 409, body: { success: false, error: 'This off-portal payment is already void.' } } : undefined));
    render(<OffPortalPaymentsPage />);
    const table = await screen.findByTestId('opp-register-table');
    fireEvent.click(within(table).getByRole('button', { name: /^Void / }));
    fireEvent.change(screen.getByLabelText(/Reason \(required/), { target: { value: 'Entered twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void payment' }));
    expect(await screen.findByText('This off-portal payment is already void.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void payment' })).toBeInTheDocument();
  });

  it('O6: read-only (canWrite false, PII masked) → no upload, no Void, masked note', async () => {
    stubFetch(undefined, list({ canWrite: false, piiMasked: true, rows: [{ ...ROW, phone: '••••••3210', panNumber: 'AB•••••34F' }] }));
    render(<OffPortalPaymentsPage />);
    const table = await screen.findByTestId('opp-register-table');
    expect(screen.getByTestId('opp-pii-masked')).toHaveTextContent(/partly hidden/);
    expect(within(table).getByText('AB•••••34F')).toBeInTheDocument();
    expect(screen.queryByText(/Record payments made outside the portal/)).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /^Void/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only view/)).toBeInTheDocument();
  });

  it('O7: a failed load shows the error; an empty register shows the empty state', async () => {
    stubFetch((u) => (/\/off-portal-payments\?/.test(u) ? { status: 400, body: { success: false, error: 'Open a client first.' } } : undefined));
    const { unmount } = render(<OffPortalPaymentsPage />);
    expect(await screen.findByText('Open a client first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();

    stubFetch(undefined, list({ rows: [], totalRows: 0, totalPages: 0, totals: { count: 0, amountPaise: '0', liveCount: 0, liveAmountPaise: '0' } }));
    render(<OffPortalPaymentsPage />);
    expect(await screen.findByText('No off-portal payments match these filters.')).toBeInTheDocument();
  });
});
