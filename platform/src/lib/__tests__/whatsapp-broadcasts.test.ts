/// <reference types="vitest/globals" />
/**
 * WhatsApp Broadcasts — pure logic tests.
 *
 * Covers (per the build brief):
 *   A — the wizard state machine (audience → template → map → preview → send)
 *   B — template library CRUD validation
 *   C — the confirm-before-send guard (+ preview-invalidation invariant)
 *   D — the variable-contract / cost display helpers
 *   E — the Excel audience parse
 *   F — phone + mapping + test-send + detail-action helpers
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  // wizard
  initialWizardState,
  wizardReducer,
  WIZARD_STEPS,
  stepIndex,
  canLeaveAudience,
  canLeaveTemplate,
  canLeaveMap,
  canSend,
  canAdvance,
  isStepUnlocked,
  buildCreatePayload,
  buildPreviewPayload,
  // templates
  validateTemplateForm,
  emptyTemplateForm,
  // display
  extractVariableIndexes,
  renderTemplateBody,
  contractHint,
  categoryIsPaid,
  categoryCostNote,
  // excel
  parseExcelAudience,
  // helpers
  normalizePhone,
  isValidPhone,
  parseCsvList,
  isMappingComplete,
  serializeVariableMapping,
  validateTestPhones,
  deliveryFunnel,
  funnelSegments,
  shouldPollBroadcast,
  POLL_AFTER_SENT_MS,
  fieldOptionsForScope,
  checkExcelFile,
  EXCEL_MAX_BYTES,
  EXCEL_MAX_ROWS,
  canCancelBroadcast,
  canResendFailed,
  type WhatsappTemplate,
  type WizardState,
  type TemplateFormValues,
  type BroadcastDetail,
} from '@/lib/whatsapp-broadcasts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVE_TPL: WhatsappTemplate = {
  id: 'tpl-1',
  name: 'Diwali greeting',
  msg91TemplateName: 'diwali_v1',
  category: 'MARKETING',
  languageCode: 'en',
  bodyText: 'Hi {{1}}, enjoy {{2}}% off!',
  variableContract: [
    { index: 1, label: 'Outlet name' },
    { index: 2, label: 'Discount' },
  ],
  status: 'ACTIVE',
};

const ARCHIVED_TPL: WhatsappTemplate = {
  ...ACTIVE_TPL,
  id: 'tpl-2',
  name: 'Old promo',
  status: 'ARCHIVED',
};

const TEMPLATES = [ACTIVE_TPL, ARCHIVED_TPL];

function readyToPreviewState(): WizardState {
  // audience valid (filter mode + title), template chosen, both vars mapped.
  let s = initialWizardState();
  s = wizardReducer(s, { type: 'SET_TITLE', title: 'Campaign' });
  s = wizardReducer(s, { type: 'SELECT_TEMPLATE', templateId: 'tpl-1' });
  s = wizardReducer(s, {
    type: 'SET_MAPPING',
    index: 1,
    mapping: { kind: 'FIELD', value: 'outletName' },
  });
  s = wizardReducer(s, {
    type: 'SET_MAPPING',
    index: 2,
    mapping: { kind: 'CONSTANT', value: '20' },
  });
  return s;
}

// ─── A — Wizard state machine ───────────────────────────────────────────────────

describe('A — wizard state machine', () => {
  it('A1: starts on the audience step with FILTER mode', () => {
    const s = initialWizardState();
    expect(s.step).toBe('audience');
    expect(s.audienceMode).toBe('FILTER');
    expect(WIZARD_STEPS).toEqual(['audience', 'template', 'map', 'preview', 'send']);
  });

  it('A2: cannot leave audience without a title', () => {
    const s = initialWizardState();
    expect(canLeaveAudience(s)).toBe(false);
    const s2 = wizardReducer(s, { type: 'SET_TITLE', title: 'X' });
    expect(canLeaveAudience(s2)).toBe(true);
  });

  it('A3: EXCEL audience needs at least one valid phone row', () => {
    let s = wizardReducer(initialWizardState(), { type: 'SET_TITLE', title: 'X' });
    s = wizardReducer(s, { type: 'SET_MODE', mode: 'EXCEL' });
    expect(canLeaveAudience(s)).toBe(false);
    s = wizardReducer(s, {
      type: 'SET_EXCEL',
      excel: {
        columns: ['Discount'],
        rows: [{ phone: '9830011252', rawPhone: '9830011252', vars: { Discount: '20' } }],
        phoneColumn: 'Phone',
        invalidCount: 0,
        duplicateCount: 0,
        totalRows: 1,
      },
    });
    expect(canLeaveAudience(s)).toBe(true);
  });

  it('A4: cannot leave template unless an ACTIVE template is selected', () => {
    let s = wizardReducer(initialWizardState(), { type: 'SET_TITLE', title: 'X' });
    expect(canLeaveTemplate(s, TEMPLATES)).toBe(false);
    // archived template is not allowed
    s = wizardReducer(s, { type: 'SELECT_TEMPLATE', templateId: 'tpl-2' });
    expect(canLeaveTemplate(s, TEMPLATES)).toBe(false);
    s = wizardReducer(s, { type: 'SELECT_TEMPLATE', templateId: 'tpl-1' });
    expect(canLeaveTemplate(s, TEMPLATES)).toBe(true);
  });

  it('A5: cannot leave map until every variable is mapped', () => {
    let s = readyToPreviewState();
    // remove one mapping
    s = { ...s, mapping: { 1: { kind: 'FIELD', value: 'outletName' } } };
    expect(canLeaveMap(s, TEMPLATES)).toBe(false);
    s = wizardReducer(s, {
      type: 'SET_MAPPING',
      index: 2,
      mapping: { kind: 'CONSTANT', value: '20' },
    });
    expect(canLeaveMap(s, TEMPLATES)).toBe(true);
  });

  it('A6: NEXT walks audience→template→map but stops when a gate is unmet', () => {
    let s = initialWizardState();
    // no title → NEXT is a no-op
    s = wizardReducer(s, { type: 'NEXT', templates: TEMPLATES });
    expect(s.step).toBe('audience');
    s = wizardReducer(s, { type: 'SET_TITLE', title: 'X' });
    s = wizardReducer(s, { type: 'NEXT', templates: TEMPLATES });
    expect(s.step).toBe('template');
    // no template → stuck
    s = wizardReducer(s, { type: 'NEXT', templates: TEMPLATES });
    expect(s.step).toBe('template');
    s = wizardReducer(s, { type: 'SELECT_TEMPLATE', templateId: 'tpl-1' });
    s = wizardReducer(s, { type: 'NEXT', templates: TEMPLATES });
    expect(s.step).toBe('map');
  });

  it('A7: BACK never goes below audience; NEXT never past send', () => {
    let s = initialWizardState();
    s = wizardReducer(s, { type: 'BACK' });
    expect(s.step).toBe('audience');
    // force to send
    s = { ...readyToPreviewState(), step: 'send', preview: okPreview() };
    s = wizardReducer(s, { type: 'NEXT', templates: TEMPLATES });
    expect(s.step).toBe('send');
    expect(stepIndex('send')).toBe(WIZARD_STEPS.length - 1);
  });

  it('A8: GO only jumps to an unlocked step', () => {
    const s = initialWizardState(); // only audience unlocked
    const jumped = wizardReducer(s, { type: 'GO', step: 'preview', templates: TEMPLATES });
    expect(jumped.step).toBe('audience'); // blocked
  });

  it('A9: isStepUnlocked reflects cumulative completion', () => {
    const s = { ...readyToPreviewState(), preview: okPreview() };
    expect(isStepUnlocked(s, 'audience', TEMPLATES)).toBe(true);
    expect(isStepUnlocked(s, 'template', TEMPLATES)).toBe(true);
    expect(isStepUnlocked(s, 'map', TEMPLATES)).toBe(true);
    expect(isStepUnlocked(s, 'preview', TEMPLATES)).toBe(true);
    expect(isStepUnlocked(s, 'send', TEMPLATES)).toBe(true);
  });

  it('A10: buildCreatePayload uses filter for FILTER mode and rows for EXCEL', () => {
    const s = { ...readyToPreviewState(), preview: okPreview() };
    const filterPayload = buildCreatePayload(s);
    expect(filterPayload.mode).toBe('FILTER');
    expect(filterPayload.scope).toBe('OUTLETS');
    expect(filterPayload.excelRows).toBeUndefined();
    expect(filterPayload.variableMapping).toEqual([
      { index: 1, kind: 'FIELD', value: 'outletName' },
      { index: 2, kind: 'CONSTANT', value: '20' },
    ]);

    let e = wizardReducer(s, { type: 'SET_MODE', mode: 'EXCEL' });
    e = wizardReducer(e, {
      type: 'SET_EXCEL',
      excel: {
        columns: [],
        rows: [
          { phone: '9830011252', rawPhone: '9830011252', vars: { X: '1' } },
          { phone: '123', rawPhone: '123', vars: {} }, // invalid → dropped
        ],
        phoneColumn: 'Phone',
        invalidCount: 1,
        duplicateCount: 0,
        totalRows: 2,
      },
    });
    const excelPayload = buildCreatePayload(e);
    expect(excelPayload.mode).toBe('EXCEL');
    expect(excelPayload.excelRows).toHaveLength(1);
    expect(excelPayload.filter).toBeUndefined();
  });

  it('A11: buildPreviewPayload omits templateId when none chosen', () => {
    const s = wizardReducer(initialWizardState(), { type: 'SET_TITLE', title: 'X' });
    const body = buildPreviewPayload(s);
    expect(body.templateId).toBeUndefined();
    expect(body.mode).toBe('FILTER');
  });
});

// ─── C — Confirm-before-send guard + preview invalidation ────────────────────────

function okPreview() {
  return {
    recipientCount: 42,
    deduped: 3,
    invalidCount: 1,
    sample: [{ phone: '9830011252', renderedBody: 'Hi Acme, enjoy 20% off!' }],
    estimatedCost: 42,
    costNote: null,
  };
}

describe('C — confirm-before-send guard', () => {
  it('C1: canSend is false without a preview', () => {
    const s = readyToPreviewState();
    expect(canSend(s)).toBe(false);
  });

  it('C2: canSend is true only with a successful preview that has recipients', () => {
    let s = readyToPreviewState();
    s = wizardReducer(s, { type: 'SET_PREVIEW', preview: okPreview() });
    expect(canSend(s)).toBe(true);
  });

  it('C3: a zero-recipient preview cannot send', () => {
    let s = readyToPreviewState();
    s = wizardReducer(s, {
      type: 'SET_PREVIEW',
      preview: { ...okPreview(), recipientCount: 0 },
    });
    expect(canSend(s)).toBe(false);
  });

  it('C4: editing ANY upstream input invalidates the preview (no stale send)', () => {
    const base = wizardReducer(readyToPreviewState(), {
      type: 'SET_PREVIEW',
      preview: okPreview(),
    });
    expect(canSend(base)).toBe(true);

    // each of these must clear the preview
    const edits = [
      wizardReducer(base, { type: 'SET_TITLE', title: 'New' }),
      wizardReducer(base, { type: 'SET_SCOPE', scope: 'BOTH' }),
      wizardReducer(base, { type: 'SET_FILTER', filter: { states: ['Goa'] } }),
      wizardReducer(base, { type: 'SET_MODE', mode: 'EXCEL' }),
      wizardReducer(base, { type: 'SELECT_TEMPLATE', templateId: 'tpl-1' }),
      wizardReducer(base, {
        type: 'SET_MAPPING',
        index: 1,
        mapping: { kind: 'CONSTANT', value: 'Z' },
      }),
    ];
    for (const e of edits) {
      expect(e.preview).toBeNull();
      expect(canSend(e)).toBe(false);
    }
  });

  it('C5: canAdvance on the preview step equals canSend', () => {
    let s: WizardState = { ...readyToPreviewState(), step: 'preview' };
    expect(canAdvance(s, TEMPLATES)).toBe(false);
    s = wizardReducer(s, { type: 'SET_PREVIEW', preview: okPreview() });
    expect(canAdvance(s, TEMPLATES)).toBe(true);
  });

  it('C6: scheduledAt is preserved and does NOT invalidate the preview', () => {
    let s = wizardReducer(readyToPreviewState(), { type: 'SET_PREVIEW', preview: okPreview() });
    s = wizardReducer(s, { type: 'SET_SCHEDULE', scheduledAt: '2026-09-01T10:00:00.000Z' });
    expect(s.scheduledAt).toBe('2026-09-01T10:00:00.000Z');
    expect(canSend(s)).toBe(true);
  });
});

// ─── B — Template library CRUD validation ────────────────────────────────────────

describe('B — template validation', () => {
  function baseForm(): TemplateFormValues {
    return {
      name: 'Greeting',
      msg91TemplateName: 'greeting_v1',
      category: 'UTILITY',
      languageCode: 'en',
      bodyText: 'Hi {{1}}, code {{2}}.',
      variableContract: [
        { index: 1, label: 'Name' },
        { index: 2, label: 'Code' },
      ],
    };
  }

  it('B1: a well-formed template passes', () => {
    expect(validateTemplateForm(baseForm()).ok).toBe(true);
  });

  it('B2: empty required fields fail', () => {
    const r = validateTemplateForm(emptyTemplateForm());
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.msg91TemplateName).toBeTruthy();
    expect(r.errors.bodyText).toBeTruthy();
  });

  it('B3: contract must match body placeholders exactly (extra declared var fails)', () => {
    const f = baseForm();
    f.variableContract = [
      { index: 1, label: 'Name' },
      { index: 2, label: 'Code' },
      { index: 3, label: 'Extra' },
    ];
    expect(validateTemplateForm(f).ok).toBe(false);
  });

  it('B4: missing declared var for a used placeholder fails', () => {
    const f = baseForm();
    f.variableContract = [{ index: 1, label: 'Name' }];
    expect(validateTemplateForm(f).ok).toBe(false);
  });

  it('B5: non-contiguous placeholders ({{1}},{{3}}) fail', () => {
    const f = baseForm();
    f.bodyText = 'Hi {{1}} and {{3}}';
    f.variableContract = [
      { index: 1, label: 'A' },
      { index: 3, label: 'C' },
    ];
    const r = validateTemplateForm(f);
    expect(r.ok).toBe(false);
    expect(r.errors.variableContract).toBeTruthy();
  });

  it('B6: every declared variable needs a label', () => {
    const f = baseForm();
    f.variableContract = [
      { index: 1, label: 'Name' },
      { index: 2, label: '   ' },
    ];
    expect(validateTemplateForm(f).ok).toBe(false);
  });

  it('B7: a body with no variables + no declared vars is valid', () => {
    const f = baseForm();
    f.bodyText = 'Season greetings from our team.';
    f.variableContract = [];
    expect(validateTemplateForm(f).ok).toBe(true);
  });
});

// ─── D — variable-contract / cost display ─────────────────────────────────────────

describe('D — variable-contract & cost display', () => {
  it('D1: extractVariableIndexes returns sorted distinct indexes', () => {
    expect(extractVariableIndexes('a {{2}} b {{1}} c {{2}}')).toEqual([1, 2]);
    expect(extractVariableIndexes('no vars')).toEqual([]);
  });

  it('D2: renderTemplateBody substitutes values and leaves gaps visible', () => {
    const out = renderTemplateBody('Hi {{1}}, {{2}}% off', { 1: 'Acme' });
    expect(out).toBe('Hi Acme, {{2}}% off');
    const full = renderTemplateBody('Hi {{1}}, {{2}}% off', { 1: 'Acme', 2: '20' });
    expect(full).toBe('Hi Acme, 20% off');
  });

  it('D3: contractHint renders {{n}}=label list', () => {
    expect(contractHint(ACTIVE_TPL.variableContract)).toBe(
      '{{1}}=Outlet name, {{2}}=Discount',
    );
    expect(contractHint([])).toBe('No variables');
  });

  it('D4: only MARKETING is a paid category, with an honest cost note', () => {
    expect(categoryIsPaid('MARKETING')).toBe(true);
    expect(categoryIsPaid('UTILITY')).toBe(false);
    expect(categoryIsPaid('AUTHENTICATION')).toBe(false);
    expect(categoryCostNote('MARKETING')).toMatch(/billed/i);
    expect(categoryCostNote('UTILITY')).toMatch(/no per-message/i);
  });
});

// ─── E — Excel audience parse ─────────────────────────────────────────────────────

function xlsxBuffer(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('E — Excel audience parse', () => {
  it('E1: detects the phone column and variable columns', () => {
    const buf = xlsxBuffer([
      ['Phone', 'Outlet name', 'Discount'],
      ['9830011252', 'Acme', '20'],
      ['6289864191', 'Beta', '10'],
    ]);
    const r = parseExcelAudience(buf);
    expect(r.error).toBeUndefined();
    expect(r.phoneColumn).toBe('Phone');
    expect(r.columns).toEqual(['Outlet name', 'Discount']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      phone: '9830011252',
      vars: { 'Outlet name': 'Acme', Discount: '20' },
    });
  });

  it('E2: normalizes numbers, flags invalid, and de-dupes', () => {
    const buf = xlsxBuffer([
      ['Mobile', 'Name'],
      ['+91 98300 11252', 'A'],
      ['9830011252', 'dup'], // duplicate of the normalized first
      ['12345', 'bad'], // invalid
    ]);
    const r = parseExcelAudience(buf);
    expect(r.phoneColumn).toBe('Mobile');
    expect(r.invalidCount).toBe(1);
    expect(r.duplicateCount).toBe(1);
    // one valid unique + one invalid row retained (for reporting), dup dropped
    expect(r.rows.filter((x) => isValidPhone(x.rawPhone))).toHaveLength(1);
  });

  it('E3: errors when no phone column is present', () => {
    const buf = xlsxBuffer([
      ['Name', 'Discount'],
      ['Acme', '20'],
    ]);
    const r = parseExcelAudience(buf);
    expect(r.error).toBeTruthy();
    expect(r.phoneColumn).toBeNull();
  });

  it('E4: errors on a header-only file', () => {
    const buf = xlsxBuffer([['Phone', 'Name']]);
    expect(parseExcelAudience(buf).error).toBeTruthy();
  });
});

// ─── F — helpers ─────────────────────────────────────────────────────────────────

describe('F — helpers', () => {
  it('F1: normalizePhone strips prefixes to bare 10 digits', () => {
    expect(normalizePhone('+91 98300-11252')).toBe('9830011252');
    expect(normalizePhone('919830011252')).toBe('9830011252');
  });

  it('F2: isValidPhone accepts 6-9 leading 10-digit, rejects others', () => {
    expect(isValidPhone('9830011252')).toBe(true);
    expect(isValidPhone('1234567890')).toBe(false);
    expect(isValidPhone('98300')).toBe(false);
  });

  it('F3: parseCsvList trims, splits on comma/newline, de-dupes', () => {
    expect(parseCsvList('Goa, Kerala\nGoa,, Bihar ')).toEqual(['Goa', 'Kerala', 'Bihar']);
  });

  it('F4: isMappingComplete requires a non-empty mapping for each var', () => {
    expect(isMappingComplete(ACTIVE_TPL.variableContract, {})).toBe(false);
    expect(
      isMappingComplete(ACTIVE_TPL.variableContract, {
        1: { kind: 'FIELD', value: 'outletName' },
        2: { kind: 'CONSTANT', value: '' },
      }),
    ).toBe(false);
    expect(
      isMappingComplete(ACTIVE_TPL.variableContract, {
        1: { kind: 'FIELD', value: 'outletName' },
        2: { kind: 'CONSTANT', value: '20' },
      }),
    ).toBe(true);
    expect(isMappingComplete([], {})).toBe(true);
  });

  it('F5: serializeVariableMapping sorts by index', () => {
    expect(
      serializeVariableMapping({
        2: { kind: 'CONSTANT', value: 'b' },
        1: { kind: 'FIELD', value: 'a' },
      }),
    ).toEqual([
      { index: 1, kind: 'FIELD', value: 'a' },
      { index: 2, kind: 'CONSTANT', value: 'b' },
    ]);
  });

  it('F6: validateTestPhones enforces 1–5 valid, de-duped numbers', () => {
    expect(validateTestPhones('').ok).toBe(false);
    expect(validateTestPhones('12345').ok).toBe(false);
    const ok = validateTestPhones('9830011252, +91 6289864191, 9830011252');
    expect(ok.ok).toBe(true);
    expect(ok.phones).toEqual(['9830011252', '6289864191']);
    expect(validateTestPhones('9111111111,9222222222,9333333333,9444444444,9555555555,9666666666').ok).toBe(false);
  });

  it('F7: deliveryFunnel derives Queued honestly (never mislabels)', () => {
    const funnel = deliveryFunnel({
      id: 'b',
      title: 't',
      status: 'SENDING',
      audienceMode: 'FILTER',
      recipientCount: 100,
      sentCount: 30,
      deliveredCount: 20,
      readCount: 10,
      failedCount: 5,
      createdAt: '2026-08-21T00:00:00Z',
    });
    const queued = funnel.find((f) => f.key === 'queued');
    expect(queued?.count).toBe(65); // 100 - 30 - 5
    expect(funnel.map((f) => f.label)).toEqual([
      'Queued',
      'Sent',
      'Delivered',
      'Read',
      'Failed',
    ]);
  });

  it('F7b: zones is carried through the filter into the preview + create payloads', () => {
    // Fix 2 — the UI now exposes a zones input; it must reach the backend both places.
    let s = readyToPreviewState();
    s = wizardReducer(s, { type: 'SET_FILTER', filter: { zones: ['West', 'North'] } });
    const preview = buildPreviewPayload(s) as { filter?: { zones?: string[] } };
    expect(preview.filter?.zones).toEqual(['West', 'North']);
    const create = buildCreatePayload(s);
    expect(create.filter?.zones).toEqual(['West', 'North']);
    // and editing zones invalidates a prior preview (no stale send).
    const withPreview = wizardReducer(
      { ...readyToPreviewState() },
      { type: 'SET_PREVIEW', preview: okPreview() },
    );
    const edited = wizardReducer(withPreview, { type: 'SET_FILTER', filter: { zones: ['East'] } });
    expect(edited.preview).toBeNull();
  });

  it('F8: cancel only while scheduled/sending; resend only when sent with failures', () => {
    expect(canCancelBroadcast('SCHEDULED')).toBe(true);
    expect(canCancelBroadcast('SENDING')).toBe(true);
    expect(canCancelBroadcast('SENT')).toBe(false);
    const sent = {
      id: 'b',
      title: 't',
      status: 'SENT' as const,
      audienceMode: 'FILTER' as const,
      recipientCount: 10,
      sentCount: 10,
      deliveredCount: 8,
      readCount: 4,
      failedCount: 2,
      createdAt: 'x',
    };
    expect(canResendFailed(sent)).toBe(true);
    expect(canResendFailed({ ...sent, failedCount: 0 })).toBe(false);
    expect(canResendFailed({ ...sent, status: 'SENDING' })).toBe(false);
  });
});

// ─── G — audit fixes: scope-filtered fields, funnel widths, polling, excel caps ──

function detail(over: Partial<BroadcastDetail> = {}): BroadcastDetail {
  return {
    id: 'b',
    title: 't',
    status: 'SENT',
    audienceMode: 'FILTER',
    recipientCount: 100,
    sentCount: 80,
    deliveredCount: 60,
    readCount: 40,
    failedCount: 10,
    createdAt: '2026-08-21T00:00:00Z',
    ...over,
  };
}

describe('G3 — variable-field options are scoped to the audience (fix 3)', () => {
  it('OUTLETS never offers "Sales rep name"; SALES offers only rep fields', () => {
    const outlets = fieldOptionsForScope('OUTLETS').map((o) => o.key);
    expect(outlets).toContain('outletName');
    expect(outlets).not.toContain('salesRepName');

    const sales = fieldOptionsForScope('SALES').map((o) => o.key);
    expect(sales).toContain('salesRepName');
    expect(sales).not.toContain('outletName');
    expect(sales).not.toContain('programName');
  });

  it('BOTH offers the full union of fields', () => {
    const both = fieldOptionsForScope('BOTH').map((o) => o.key);
    expect(both).toContain('outletName');
    expect(both).toContain('salesRepName');
  });
});

describe('G4 — funnel bar segments are exclusive and never exceed 100% (fix 4)', () => {
  it('derives mutually-exclusive segments from cumulative counters; Σpct ≤ 100', () => {
    const segs = funnelSegments(detail()); // 100 total, 80 sent, 60 delivered, 40 read, 10 failed
    const by = Object.fromEntries(segs.map((s) => [s.key, s]));
    // exclusive counts: failed 10, queued 100-80-10=10, sent-only 80-60=20, delivered-only 60-40=20, read 40
    expect(by.failed.count).toBe(10);
    expect(by.queued.count).toBe(10);
    expect(by.sent.count).toBe(20);
    expect(by.delivered.count).toBe(20);
    expect(by.read.count).toBe(40);
    const sumPct = segs.reduce((a, s) => a + s.pct, 0);
    expect(sumPct).toBeCloseTo(100, 5);
    expect(sumPct).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('never exceeds 100% even with dirty/over-counting counters', () => {
    // delivered > sent, read > delivered, counts > recipientCount — all nonsense but must not overflow.
    const segs = funnelSegments(
      detail({ recipientCount: 10, sentCount: 50, deliveredCount: 80, readCount: 90, failedCount: 40 }),
    );
    const sumPct = segs.reduce((a, s) => a + s.pct, 0);
    expect(sumPct).toBeLessThanOrEqual(100 + 1e-9);
    for (const s of segs) expect(s.pct).toBeGreaterThanOrEqual(0);
  });

  it('prefers the backend by-state funnel when present', () => {
    const segs = funnelSegments(
      detail({ funnel: { queued: 5, sent: 5, delivered: 5, read: 80, failed: 5 } }),
    );
    const by = Object.fromEntries(segs.map((s) => [s.key, s.count]));
    expect(by).toEqual({ queued: 5, sent: 5, delivered: 5, read: 80, failed: 5 });
    const sumPct = segs.reduce((a, s) => a + s.pct, 0);
    expect(sumPct).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('a zero-recipient campaign yields all-zero widths (no divide-by-zero)', () => {
    const segs = funnelSegments(
      detail({ recipientCount: 0, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0 }),
    );
    for (const s of segs) expect(s.pct).toBe(0);
  });
});

describe('G5 — polling continues after SENT for late webhooks, then stops (fix 5)', () => {
  const now = Date.parse('2026-08-21T12:00:00Z');

  it('polls while SCHEDULED or SENDING regardless of counts', () => {
    expect(shouldPollBroadcast(detail({ status: 'SENDING' }), now)).toBe(true);
    expect(shouldPollBroadcast(detail({ status: 'SCHEDULED' }), now)).toBe(true);
  });

  it('keeps polling after SENT while recipients are non-terminal and within the window', () => {
    const sentAt = new Date(now - 60_000).toISOString(); // 1 min ago
    // 100 recipients, only 40 read + 10 failed = 50 terminal → 50 non-terminal
    expect(shouldPollBroadcast(detail({ status: 'SENT', sentAt }), now)).toBe(true);
  });

  it('stops once every recipient is terminal (read + failed = total)', () => {
    const sentAt = new Date(now - 60_000).toISOString();
    expect(
      shouldPollBroadcast(
        detail({ status: 'SENT', sentAt, recipientCount: 100, readCount: 90, failedCount: 10 }),
        now,
      ),
    ).toBe(false);
  });

  it('stops once the post-send window has elapsed even if some are non-terminal', () => {
    const sentAt = new Date(now - (POLL_AFTER_SENT_MS + 60_000)).toISOString();
    expect(shouldPollBroadcast(detail({ status: 'SENT', sentAt }), now)).toBe(false);
  });

  it('never polls for DRAFT / CANCELLED / null', () => {
    expect(shouldPollBroadcast(detail({ status: 'CANCELLED' }), now)).toBe(false);
    expect(shouldPollBroadcast(detail({ status: 'DRAFT' }), now)).toBe(false);
    expect(shouldPollBroadcast(null, now)).toBe(false);
  });
});

describe('G6 — Excel upload size guard (fix 6)', () => {
  it('rejects a file over the byte cap with a clear message, accepts one under it', () => {
    const tooBig = checkExcelFile({ size: EXCEL_MAX_BYTES + 1 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toMatch(/too large/i);
    expect(checkExcelFile({ size: 1024 }).ok).toBe(true);
    expect(checkExcelFile({ size: EXCEL_MAX_BYTES }).ok).toBe(true);
  });

  it('the row cap matches the backend limit', () => {
    expect(EXCEL_MAX_ROWS).toBe(50_000);
  });
});
