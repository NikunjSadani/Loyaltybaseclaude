/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — UI ⇄ server CONTRACT.
 *
 * `fixtures/voucher-dispersal-server-contract.json` is produced by the REAL server code
 * (api/src/voucher-dispersal/voucher-dispersal.contract.spec.ts drives the service and fails when the
 * server's reply shapes drift from this file). Here every UI normaliser runs over that fixture through a
 * recording Proxy: reading a field the server does NOT send fails the test (a renamed / misspelt field
 * would otherwise silently render "—"). The reverse check lists every server field the UI ignores on
 * purpose, so a NEW server field forces a decision here.
 * Run: npx vitest run src/lib/__tests__/voucher-dispersal.contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import contract from './fixtures/voucher-dispersal-server-contract.json';
import {
  normalizeBrand, normalizeCampaign, normalizeCancelResult, normalizeDetail, normalizeListItem, normalizePreview,
  normalizeRetryResult, normalizeRow, normalizeRowsPage, confirmPayload, CAMPAIGN_STATUSES, ROW_STATUSES,
  normalizeBatchPreview, normalizeDiscardResult, BATCH_STATUSES, batchConfirmBlock,
} from '@/lib/voucher-dispersal';

type Rec = { missing: Set<string>; read: Set<string> };

/** Wrap `v` so every property read on a plain object is recorded (path with `[]` for array items). */
function recording(v: unknown, rec: Rec, path = ''): unknown {
  if (Array.isArray(v)) {
    return new Proxy(v, {
      get(t, k, r) {
        const val = Reflect.get(t, k, r);
        if (typeof k === 'string' && /^\d+$/.test(k)) return recording(val, rec, `${path}[]`);
        // Array methods (map / filter / …) must hand out wrapped items too.
        if (typeof val === 'function' && (k === 'map' || k === 'filter' || k === 'forEach' || k === 'some' || k === 'find')) {
          const wrapped = t.map((x) => recording(x, rec, `${path}[]`));
          return (wrapped as unknown as Record<string, (...a: unknown[]) => unknown>)[k].bind(wrapped);
        }
        return val;
      },
    });
  }
  if (v && typeof v === 'object') {
    return new Proxy(v as Record<string, unknown>, {
      get(t, k) {
        if (typeof k !== 'string') return Reflect.get(t, k);
        const p = path ? `${path}.${k}` : k;
        if (!(k in t)) rec.missing.add(p);
        else rec.read.add(p);
        return recording(t[k], rec, p);
      },
    });
  }
  return v;
}

function keyPaths(v: unknown, path = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keyPaths(x, `${path}[]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      out.add(p);
      keyPaths(val, p, out);
    }
  }
  return out;
}

function run<T>(sample: unknown, fn: (x: unknown) => T): { out: T; rec: Rec } {
  const rec: Rec = { missing: new Set(), read: new Set() };
  const out = fn(recording(sample, rec));
  return { out, rec };
}

/**
 * Server fields the UI deliberately does not read (per endpoint). Anything the server sends that is
 * neither read nor listed here fails the "unread" check → decide: show it, or add it here with why.
 */
const CAMPAIGN_IGNORED = ['uploadedAt', 'createdById', 'confirmedById', 'cancelledById', 'updatedAt', 'previewId'];
const PER_BRAND_IGNORED = ['brandKey'];
const ROW_IGNORED = [
  'brandKey', 'note', // shown in the report download, not the grid
  'lastReconcileAt', 'lastReconcileResult', 'boughtAt', 'buyFailureSource', 'hasPin', 'attempts', 'resendCount',
  'whatsapp', // detailed message view — the flat message* fields are the UI contract
];
/** Batch list: the ids are not shown (the server's names are). */
const BATCH_IGNORED = ['uploadedById', 'confirmedById', 'discardedById'];
const UPLOAD_IGNORED = [
  ...CAMPAIGN_IGNORED.map((k) => `campaign.${k}`),
  'rows[].brandKey', 'rows[].note',
  ...PER_BRAND_IGNORED.map((k) => `summary.perBrand[].${k}`),
  'summary.skippedBlankRows', 'summary.skippedFormulaRows', 'summary.hiddenRowsIncluded', // the *Note texts are shown
];
const IGNORED: Record<string, string[]> = {
  brands: [],
  create: CAMPAIGN_IGNORED,
  confirm: CAMPAIGN_IGNORED,
  upload: UPLOAD_IGNORED,
  detail: [
    ...CAMPAIGN_IGNORED.map((k) => `campaign.${k}`),
    'summary.total', 'summary.invalid', 'summary.duplicates', 'summary.totalRupees', 'summary.budgetRupees',
    'summary.overBudget', 'summary.perBrand', 'summary.queued', 'summary.buying', 'summary.pendingReconcile',
    // (summary.committedRupees removed from the server 2026-11-18 — budgetUsage is the one breakdown.)
    ...BATCH_IGNORED.map((k) => `batches[].${k}`),
    'edits[].byId', // the server's name is shown
  ],
  list: [
    ...CAMPAIGN_IGNORED.map((k) => `[].${k}`),
    '[].summary.total', '[].summary.invalid', '[].summary.duplicates', '[].summary.queued',
  ],
  rows: [...ROW_IGNORED.map((k) => `rows[].${k}`)],
  resend: ROW_IGNORED,
  retryBuy: ROW_IGNORED.map((k) => `row.${k}`),
  cancel: CAMPAIGN_IGNORED.map((k) => `campaign.${k}`),
  edit: CAMPAIGN_IGNORED,
  batchConfirm: CAMPAIGN_IGNORED,
  batchUpload: UPLOAD_IGNORED,
  batchPreview: UPLOAD_IGNORED,
  batchDiscard: CAMPAIGN_IGNORED.map((k) => `campaign.${k}`),
  rowsOfBatch: [...ROW_IGNORED.map((k) => `rows[].${k}`)],
  markNotBought: ROW_IGNORED,
};
IGNORED.process = ['pass', ...IGNORED.detail];
IGNORED.detailWithBatches = IGNORED.detail;

const C = contract as Record<string, unknown>;
const NORMALISERS: Record<string, (x: unknown) => unknown> = {
  brands: (d) => (d as unknown[]).map(normalizeBrand),
  create: normalizeCampaign,
  upload: normalizePreview,
  confirm: normalizeCampaign,
  process: normalizeDetail,
  list: (d) => (d as unknown[]).map(normalizeListItem),
  detail: normalizeDetail,
  rows: (d) => normalizeRowsPage(d, 1),
  resend: normalizeRow,
  retryBuy: normalizeRetryResult,
  cancel: normalizeCancelResult,
  edit: normalizeCampaign,
  batchUpload: normalizeBatchPreview,
  batchPreview: normalizeBatchPreview,
  batchDiscard: normalizeDiscardResult,
  batchConfirm: normalizeCampaign,
  detailWithBatches: normalizeDetail,
  rowsOfBatch: (d) => normalizeRowsPage(d, 1),
  markNotBought: normalizeRow,
};

/** A key path counts as covered when it, or a parent of it, was read or is ignored. */
function uncovered(all: Set<string>, rec: Rec, ignored: string[]): string[] {
  const ok = (p: string) => {
    if (rec.read.has(p)) {
      // A read of an object/array parent does not cover its children — those must be read individually.
      return true;
    }
    return ignored.some((i) => p === i || p.startsWith(`${i}.`) || p.startsWith(`${i}[]`));
  };
  return [...all].filter((p) => !ok(p)).sort();
}

describe('voucher-dispersal UI ⇄ server contract (fixture from the real server code)', () => {
  it('the fixture covers every endpoint the UI calls', () => {
    expect(Object.keys(C).sort()).toEqual(Object.keys(NORMALISERS).sort());
  });

  for (const endpoint of Object.keys(NORMALISERS)) {
    it(`${endpoint}: the UI reads no field the server does not send`, () => {
      const { rec } = run(C[endpoint], NORMALISERS[endpoint]);
      expect([...rec.missing]).toEqual([]);
    });

    it(`${endpoint}: every server field is read by the UI or explicitly ignored`, () => {
      const { rec } = run(C[endpoint], NORMALISERS[endpoint]);
      expect(uncovered(keyPaths(C[endpoint]), rec, IGNORED[endpoint] ?? [])).toEqual([]);
    });
  }

  it('statuses in the fixture are all known to the UI', () => {
    const camps = [C.create, C.confirm, (C.process as { campaign: unknown }).campaign, ...(C.list as unknown[])];
    for (const c of camps) expect(CAMPAIGN_STATUSES as readonly string[]).toContain((c as { status: string }).status);
    const rows = [...((C.upload as { rows: unknown[] }).rows), ...((C.rows as { rows: unknown[] }).rows)];
    for (const r of rows) expect(ROW_STATUSES as readonly string[]).toContain((r as { status: string }).status);
  });

  it('normalised values carry the new server data (warning, notes, masked code, message status, billed-to)', () => {
    const p = normalizePreview(C.upload);
    expect(p.previewId).toMatch(/^pv/);
    expect(p.summary.warningCount).toBe(1);
    expect(p.summary.skippedNote).toMatch(/blank/);
    expect(p.rows.find((r) => r.warning)?.warning).toMatch(/^Already got a ₹/);
    expect(p.summary.perBrand.every((b) => b.count !== null && b.rupees !== null)).toBe(true);
    // Confirm body built from what the preview shows (server ConfirmDispersalCampaignDto).
    expect(Object.keys(confirmPayload(p)!).sort()).toEqual(['expectedTotalRupees', 'expectedValidCount', 'previewId']);

    const d = normalizeDetail(C.detail);
    expect(d.campaign.billedToClientName).toBe('Bajaj');
    expect(d.campaign.completedAt).not.toBeNull();
    expect(d.campaign.canCancel).toBe(false);
    expect(d.hubbleConfigured).toBe(true);
    expect(d.summary.messageSent).not.toBeNull();

    const rows = normalizeRowsPage(C.rows, 1);
    const bought = rows.rows.find((r) => r.status === 'BOUGHT')!;
    expect(bought.voucherCodeMasked).toMatch(/^••••/);
    expect(bought.messageStatus).toBe('sent');
    expect(bought.hubbleRef).not.toBeNull();
    expect(rows.rows.find((r) => r.warning)).toBeTruthy();
    expect(rows.total).not.toBeNull();

    const list = (C.list as unknown[]).map(normalizeListItem);
    expect(list.every((i) => i.summary.bought !== null && i.summary.spentRupees !== null)).toBe(true);
    expect(list[0].summary.delivered).toBeNull(); // the list sends no WhatsApp counts → "—"

    expect(normalizeRetryResult(C.retryBuy).message).toBeTruthy();
    expect(normalizeCancelResult(C.cancel).cancelledRows).not.toBeNull();
    expect(normalizeBrand((C.brands as unknown[])[0]).available).toBe(true);
  });

  it('edit + "Add more people" batches: normalised values carry the server data', () => {
    expect(normalizeCampaign(C.edit)).toMatchObject({ name: 'Earlier (Nov)', budgetRupees: 6000, canEdit: true, addPeopleBlockedReason: null });
    const processing = normalizeCampaign(C.confirm);
    expect(processing.addPeopleBlockedReason).toMatch(/still being bought/);

    const b = normalizeBatchPreview(C.batchUpload);
    expect(b.batchNumber).toBe(2);
    expect(b.batchStatus).toBe('PREVIEWED');
    expect(b.previewId).toMatch(/^pv/);
    expect(b.crossBatchDuplicates).toBe(1);
    expect(b.alreadyCommittedRupees).toBe(1000);
    expect(b.remainingBudgetRupees).toBe(5000);
    expect(b.rows.find((r) => r.status === 'DUPLICATE')?.invalidReason).toMatch(/batch 1/);
    expect(batchConfirmBlock(b)).toEqual({ blocked: false });
    expect(confirmPayload(b)).toEqual({ previewId: b.previewId, expectedValidCount: 1, expectedTotalRupees: 300 });
    expect(normalizeBatchPreview(C.batchPreview).previewId).toBe(b.previewId);
    expect(normalizeDiscardResult(C.batchDiscard)).toMatchObject({ batchNumber: 2, discardedRows: 2 });

    const d = normalizeDetail(C.detailWithBatches);
    expect(d.batches.map((x) => [x.batchNumber, x.status])).toEqual([[1, 'CONFIRMED'], [2, 'DISCARDED'], [3, 'CONFIRMED']]);
    for (const x of d.batches) expect(BATCH_STATUSES as readonly string[]).toContain(x.rawStatus);
    expect(d.batches[2]).toMatchObject({ uploadedByName: 'Admin One', bought: 1, total: 1 });
    expect(d.batches[1].discardedByName).toBe('Admin One');
    expect(d.edits[0]).toMatchObject({ byName: 'Admin One' });
    expect(d.edits[0].changes.map((c) => c.field)).toEqual(['name', 'budgetRupees']);
    expect(d.summary.budgetFloorRupees).toBe(1300);
    expect(d.summary.overBudgetRupees).toBe(0);
    expect(d.summary.queuedAtRiskRupees).toBe(0);
    expect(d.summary.lateCompletedRows).toBe(0);
    expect(d.campaign.settleError).toBeNull();
    expect(normalizeBatchPreview(C.batchUpload).overBudgetRupees).toBe(0);
    expect(C.detailWithBatches as { summary: Record<string, unknown> }).not.toHaveProperty('summary.committedRupees');
    expect(d.summary.budgetUsage).toEqual({ spentRupees: 1300, withHubbleRupees: 0, failedMayCompleteRupees: 0, queuedRupees: 0, supersededRupees: 0, floorRupees: 1300 });
    expect(d.summary.supersededRows).toEqual([]);
    expect(d.summary.bought).toBe(2);

    const r = normalizeRowsPage(C.rowsOfBatch, 1);
    expect(r.rows.map((x) => x.batchNumber)).toEqual([3]);
    expect(normalizeCancelResult(C.cancel).discardedPendingBatchRows).toBe(0);
    const marked = normalizeRow(C.markNotBought);
    expect(marked).toMatchObject({ status: 'BUY_FAILED', canMarkNotBought: false, canRetryBuy: true });
    expect(marked.reason).toMatch(/^Marked as not bought by an admin: /);
    expect(d.summary.failedBackWithHubbleRows).toBe(0);
    expect((C.list as unknown[]).map(normalizeListItem).every((i) => i.summary.pendingBatchNumber === null)).toBe(true);
  });
});
