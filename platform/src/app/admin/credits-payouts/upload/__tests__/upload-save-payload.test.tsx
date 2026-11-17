/// <reference types="vitest/globals" />
/**
 * CUP — Credits upload: the "Confirm & Credit" save → confirm requests (memory-safety, 2026-11-14).
 *
 * Staging bug: the page POSTed EVERY parsed row (one per outlet × field, blanks included as
 * SKIP rows with a long skipReason). A Bajaj file of 6,517 outlets × 7 fields with only 2 values
 * became a ~12.7 MB body, the frontend proxy truncated it at 10 MB, and the admin saw
 * `SyntaxError: Unexpected token 'I', "Internal S"... is not valid JSON`.
 *
 * Covered (real parser + real .xlsx, only fetch / session / settings mocked):
 *  - CUP1: only the OK rows are posted, each row unchanged; totals + period exactly as before
 *  - CUP2: save failures (non-JSON / JSON 5xx, 413, non-JSON 200, network) → true, readable copy;
 *          nothing confirmed; Confirm & Credit stays available (no batch was created by us)
 *  - CUP3: a JSON 4xx save rejection shows the server's own message
 *  - CUP4: every POST-SAVE failure (non-JSON 502, network drop, JSON 4xx) → no way to save a
 *          second batch; "Retry confirm for CB-…" re-POSTs /confirm for the SAME id; Payout Status link
 *  - CUP5: retry answered "Batch is already CONFIRMED" → reported as already confirmed, no retry
 *  - CUP6: Upload Again + a fresh file clears the saved-batch state
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// CUP1 builds + parses a real 6,517-outlet workbook (~4.4 s under full-suite load vs the 5 s default).
vi.setConfig({ testTimeout: 60_000 });
import * as XLSX from 'xlsx';
import type { CreditField } from '@/types';
import type { TemplateOutlet } from '@/lib/credits-payouts-template';
import { parseCreditUpload } from '@/lib/credits-payouts-parser';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/upload',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return {
    ...actual,
    useAdminSession: vi.fn(() => ({ role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Admin', userId: 'u1' })),
  };
});

// Upload window always open (cutoff day 31) and caps high enough for the test values.
const CP = { monthCutoffDay: 31, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] };
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, getGifsySettings: vi.fn(() => ({ creditsPayouts: CP })) };
});

import CreditsPayoutsUploadPage from '../page';

/** The page uploads for the PREVIOUS calendar month — computed relative to now, never hardcoded. */
function expectedPeriod(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Fixture: N outlets × 7 fields, realistic id/name lengths ───────────────────────────────

const FIELD_NAMES = [
  'Visibility Incentive', 'Secondary Sales Bonus', 'Wholesale Payout', 'Display Contest',
  'Festive Scheme Reward', 'Range Selling Bonus', 'Consistency Reward',
];
const FIELDS: CreditField[] = FIELD_NAMES.map((name, i) => ({
  id: `cmhf${String(i).padStart(2, '0')}x9k2l0000abcdefgh`,
  name,
  isActive: true,
  isSeparatePayout: false,
  // WHOLESALER earns POINTS, SSS earns PAYOUT on every field.
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT' },
  createdAt: '2026-01-01T00:00:00.000Z',
  order: i + 1,
}));

function makeOutlets(n: number): TemplateOutlet[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `BJ${String(100000 + i)}`,
    name: `Shree Ganesh General Stores ${i}`,
    type: i % 2 === 0 ? 'WHOLESALER' : 'SSS',
    typeLabel: i % 2 === 0 ? 'Wholesaler' : 'Super Stockist',
  }));
}

/** Template-shaped workbook: row 0 title, row 1 headers, rows 2+ data. `values` = {outletIdx: {fieldIdx: value}}. */
function makeFile(outlets: TemplateOutlet[], values: Record<number, Record<number, number>>): File {
  const headers = ['Outlet ID', 'Outlet Name', ...FIELD_NAMES, ...FIELD_NAMES.map((n) => `${n} Narration`)];
  const aoa: (string | number)[][] = [['Credits & Payouts'], headers];
  outlets.forEach((o, oi) => {
    const vals = FIELD_NAMES.map((_, fi) => values[oi]?.[fi] ?? '');
    const narrs = FIELD_NAMES.map((_, fi) => (values[oi]?.[fi] !== undefined ? 'Scheme credit' : ''));
    aoa.push([o.id, o.name, ...vals, ...narrs]);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Upload');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const file = new File([buf], 'credits.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  // jsdom's File may lack arrayBuffer(); the page reads the file through it.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buf });
  return file;
}

// ─── fetch router ───────────────────────────────────────────────────────────────────────────

type Reply =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; text: string }
  | { kind: 'reject' };
const jsonReply = (body: unknown, status = 200): Reply => ({ kind: 'json', status, body });
/** A non-JSON reply (e.g. the proxy's plain-text "Internal Server Error"). */
const textReply = (status: number, text: string): Reply => ({ kind: 'text', status, text });
/** fetch() itself rejects (network drop / aborted). */
const networkDrop: Reply = { kind: 'reject' };

const CONFIRM_OK = jsonReply({
  success: true, data: { pointsCredited: 1, pointsCreditedTotal: 150, payoutEntriesCreated: 1, skipped: [] },
});
const SAVED = jsonReply({
  success: true,
  data: { id: 'b1', batchCode: 'CB-TEST-001', totalOutlets: 2, totalPoints: 150, totalPayoutPaise: 25000 },
});

let saveBodies: string[] = [];
let confirmUrls: string[] = [];

/** `confirms` are consumed in order, one per /confirm call (the last one repeats). */
function installFetch(outlets: TemplateOutlet[], save: Reply, confirms: Reply[] = [CONFIRM_OK]) {
  saveBodies = [];
  confirmUrls = [];
  const queue = [...confirms];
  const respond = (r: Reply) => {
    if (r.kind === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'Error',
      json: async () => {
        if (r.kind === 'text') {
          throw new SyntaxError(`Unexpected token '${r.text[0]}', "${r.text.slice(0, 10)}"... is not valid JSON`);
        }
        return r.body;
      },
    } as unknown as Response);
  };

  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/credits/fields')) return respond(jsonReply({ success: true, data: FIELDS }));
    if (url.includes('/eligible-outlets')) return respond(jsonReply({ success: true, data: outlets }));
    if (url.endsWith('/confirm')) {
      confirmUrls.push(url);
      return respond(queue.length > 1 ? queue.shift()! : queue[0]);
    }
    if (url.endsWith('/credits/batches') && init?.method === 'POST') {
      saveBodies.push(String(init.body));
      return respond(save);
    }
    return respond(jsonReply({ success: false, error: `unmocked ${url}` }, 404));
  }) as unknown as typeof fetch;
}

async function uploadFile(container: HTMLElement, file: File) {
  await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  return screen.findByRole('button', { name: /Confirm & Credit/ }, { timeout: 15000 });
}

async function uploadAndConfirm(file: File) {
  const utils = render(<CreditsPayoutsUploadPage />);
  fireEvent.click(await uploadFile(utils.container, file));
  return utils;
}

// Two values in the whole file: outlet 0 (WHOLESALER) field 0 = 150 pts; outlet 1 (SSS) field 2 = ₹250.
const TWO_VALUES = { 0: { 0: 150 }, 1: { 2: 250 } };
const NO_RAW_ERROR = /SyntaxError|not valid JSON|Unexpected token|TypeError|Failed to fetch/;

const SAVE_FAILED_GENERIC =
  "Couldn't save the batch — nothing was credited. If an unconfirmed batch from this attempt appears in Payout Status, ignore it and upload again.";
const SAVE_TOO_LARGE =
  'The upload was too large for the server — nothing was credited. Split the file into smaller uploads and try again.';
const CONFIRM_UNKNOWN =
  "Batch CB-TEST-001 was saved but we couldn't confirm whether it was credited. Check Payout Status: if it shows Confirmed, you're done; if it shows Pending Approval, use Retry confirm below. Do not upload this file again.";

describe('CUP — credits upload save request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CUP1: 6,517 outlets × 7 fields with 2 values → posts only the 2 OK rows, unchanged, with identical totals', async () => {
    const outlets = makeOutlets(6517);
    const file = makeFile(outlets, TWO_VALUES);
    installFetch(outlets, SAVED);

    await uploadAndConfirm(file);
    expect(await screen.findByText('Credits confirmed successfully', {}, { timeout: 15000 })).toBeInTheDocument();

    expect(saveBodies).toHaveLength(1);
    const sent = JSON.parse(saveBodies[0]);

    // What the page used to send, built from the same parse (the old `rows: parseResult.rows`).
    const parsed = parseCreditUpload(await file.arrayBuffer(), {
      fields: FIELDS, outlets, month: expectedPeriod(), safetyCapPoints: CP.safetyCapPoints, safetyCapInr: CP.safetyCapInr,
    });
    expect(parsed.rows).toHaveLength(6517 * 7);
    const okRows = parsed.rows.filter((r) => r.status === 'OK');
    const before = JSON.stringify({
      period: expectedPeriod(),
      totalOutlets: new Set(okRows.map((r) => r.outletId)).size,
      totalPoints: parsed.summary.totalPoints,
      totalPayoutPaise: parsed.summary.totalPayoutPaise,
      rows: parsed.rows,
    });

    // Only the OK rows, each byte-identical to the parsed row (stored batch rows unchanged).
    expect(sent.rows).toHaveLength(2);
    expect(sent.rows).toEqual(JSON.parse(JSON.stringify(okRows)));
    expect(sent.rows.map((r: { outletId: string; fieldName: string; awardType: string; amount: number }) =>
      [r.outletId, r.fieldName, r.awardType, r.amount])).toEqual([
      ['BJ100000', 'Visibility Incentive', 'POINTS', 150],
      ['BJ100001', 'Wholesale Payout', 'PAYOUT', 25000],
    ]);

    // Period + totals exactly as before.
    expect(sent.period).toBe(expectedPeriod());
    expect(sent.totalOutlets).toBe(2);
    expect(sent.totalPoints).toBe(150);
    expect(sent.totalPayoutPaise).toBe(25000);
    expect({ ...sent, rows: undefined }).toEqual({ ...JSON.parse(before), rows: undefined });

    // Size: the old body blew through the 10 MB proxy cap; the new one is tiny.
    const beforeBytes = new TextEncoder().encode(before).length;
    const afterBytes = new TextEncoder().encode(saveBodies[0]).length;
    console.info(`[CUP1] save body before=${beforeBytes} bytes, after=${afterBytes} bytes`);
    expect(beforeBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(afterBytes).toBeLessThan(1024);
  }, 60000);

  it.each([
    ['a non-JSON 500 (proxy "Internal Server Error")', textReply(500, 'Internal Server Error'), SAVE_FAILED_GENERIC],
    ['a JSON 500 with an API error', jsonReply({ success: false, error: 'Database unavailable' }, 500),
      "Couldn't save the batch (Database unavailable) — nothing was credited. If an unconfirmed batch from this attempt appears in Payout Status, ignore it and upload again."],
    ['a plain-text 413', textReply(413, 'Payload Too Large'), SAVE_TOO_LARGE],
    ['a JSON 413', jsonReply({ statusCode: 413, message: 'request entity too large' }, 413), SAVE_TOO_LARGE],
    ['a 200 whose body is not JSON', textReply(200, '<html>'), SAVE_FAILED_GENERIC],
    ['a network drop (fetch rejects)', networkDrop, SAVE_FAILED_GENERIC],
  ])('CUP2: save gets %s → true readable message; nothing confirmed; Confirm & Credit still available', async (_l, save, msg) => {
    const outlets = makeOutlets(4);
    installFetch(outlets, save);
    await uploadAndConfirm(makeFile(outlets, TWO_VALUES));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(msg);
    expect(screen.queryByText(NO_RAW_ERROR)).toBeNull();
    expect(confirmUrls).toHaveLength(0);
    // No batch was created by us, so a normal retry is allowed (and there is no Retry-confirm).
    expect(screen.getByRole('button', { name: /Confirm & Credit/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Retry confirm/ })).toBeNull();
  });

  it('CUP3: a JSON 400 save rejection shows the server message (e.g. safety cap)', async () => {
    const outlets = makeOutlets(4);
    installFetch(outlets, jsonReply({ success: false, error: 'Row for X exceeds the safety cap of 50000 points.' }, 400));
    await uploadAndConfirm(makeFile(outlets, TWO_VALUES));
    expect(await screen.findByRole('alert')).toHaveTextContent('Row for X exceeds the safety cap of 50000 points.');
    expect(await screen.findByRole('button', { name: /Confirm & Credit/ })).toBeEnabled();
  });

  it.each([
    ['a non-JSON 502', textReply(502, 'Bad Gateway'), CONFIRM_UNKNOWN],
    ['a network drop (fetch rejects)', networkDrop, CONFIRM_UNKNOWN],
    ['a JSON 400 (upload window closed)',
      jsonReply({ success: false, error: 'The upload window for this period has closed.' }, 400),
      "Batch CB-TEST-001 was saved but not confirmed: The upload window for this period has closed. Nothing has been credited yet. Once that's resolved, use Retry confirm below (or check Payout Status). Do not upload this file again."],
  ])('CUP4: batch saved, confirm gets %s → no second batch possible; Retry confirm re-posts the SAME id', async (_l, firstConfirm, msg) => {
    const outlets = makeOutlets(4);
    installFetch(outlets, SAVED, [firstConfirm, CONFIRM_OK]);
    await uploadAndConfirm(makeFile(outlets, TWO_VALUES));

    expect(await screen.findByRole('alert')).toHaveTextContent(msg);
    expect(screen.queryByText(NO_RAW_ERROR)).toBeNull();

    // Confirm & Credit (which would SAVE again) is gone; Retry confirm + Payout Status replace it.
    expect(screen.queryByRole('button', { name: /Confirm & Credit/ })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry confirm for CB-TEST-001' });
    expect(screen.getByRole('link', { name: /Open Payout Status/ })).toHaveAttribute('href', '/admin/credits-payouts/status');

    fireEvent.click(retry);
    expect(await screen.findByText('Credits confirmed successfully')).toBeInTheDocument();

    expect(saveBodies).toHaveLength(1); // never a second batch
    expect(confirmUrls).toEqual([
      '/api/admin/credits/batches/b1/confirm',
      '/api/admin/credits/batches/b1/confirm',
    ]);
  });

  it('CUP4b: repeated post-save failures keep offering Retry confirm only (still one batch)', async () => {
    const outlets = makeOutlets(4);
    installFetch(outlets, SAVED, [textReply(504, 'Gateway Timeout'), networkDrop, CONFIRM_OK]);
    await uploadAndConfirm(makeFile(outlets, TWO_VALUES));

    fireEvent.click(await screen.findByRole('button', { name: 'Retry confirm for CB-TEST-001' }));
    await waitFor(() => expect(confirmUrls).toHaveLength(2));
    const retry = await screen.findByRole('button', { name: 'Retry confirm for CB-TEST-001' });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFIRM_UNKNOWN);
    expect(screen.queryByRole('button', { name: /Confirm & Credit/ })).toBeNull();

    fireEvent.click(retry);
    expect(await screen.findByText('Credits confirmed successfully')).toBeInTheDocument();
    expect(saveBodies).toHaveLength(1);
    expect(new Set(confirmUrls)).toEqual(new Set(['/api/admin/credits/batches/b1/confirm']));
  });

  it('CUP5: retry answered "Batch is already CONFIRMED" → reported as already confirmed, no more retries', async () => {
    const outlets = makeOutlets(4);
    installFetch(outlets, SAVED, [
      textReply(502, 'Bad Gateway'),
      jsonReply({ success: false, error: 'Batch is already CONFIRMED' }, 400),
    ]);
    await uploadAndConfirm(makeFile(outlets, TWO_VALUES));

    fireEvent.click(await screen.findByRole('button', { name: 'Retry confirm for CB-TEST-001' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Batch CB-TEST-001 is already confirmed — its credits were applied when it was first confirmed. See Payout Status for what was credited. Do not upload this file again.',
    ));
    expect(screen.queryByRole('button', { name: /Retry confirm/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm & Credit/ })).toBeNull();
    expect(await screen.findByRole('link', { name: /Open Payout Status/ })).toBeInTheDocument();
    expect(saveBodies).toHaveLength(1);
  });

  it('CUP6: Upload Again + a fresh file clears the saved batch (Confirm & Credit returns)', async () => {
    const outlets = makeOutlets(4);
    installFetch(outlets, SAVED, [textReply(502, 'Bad Gateway')]);
    const { container } = await uploadAndConfirm(makeFile(outlets, TWO_VALUES));
    await screen.findByRole('button', { name: 'Retry confirm for CB-TEST-001' });

    fireEvent.click(screen.getByRole('button', { name: /Upload Again/ }));
    await uploadFile(container, makeFile(outlets, { 2: { 0: 75 } }));
    expect(screen.queryByRole('button', { name: /Retry confirm/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
