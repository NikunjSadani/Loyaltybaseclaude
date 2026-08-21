/* ─── WhatsApp Broadcasts — pure types + business logic ───────────────────────
 *
 * Everything here is PURE (no fetch, no DOM, no localStorage) so the wizard state
 * machine, the template-library validation, the confirm-before-send guard, the
 * variable-contract rendering, and the Excel parse are all straightforwardly
 * unit-testable. Side-effectful adapters (fetch, xlsx download) live in the pages
 * and hooks that call these helpers.
 *
 * Contract mirrors platform/docs/plans/WHATSAPP-BROADCASTS-DESIGN.md:
 *   GET/POST/PATCH/DELETE /api/admin/whatsapp-templates
 *   POST  /api/admin/whatsapp-broadcasts/preview
 *   POST  /api/admin/whatsapp-broadcasts
 *   GET   /api/admin/whatsapp-broadcasts        (history)
 *   GET   /api/admin/whatsapp-broadcasts/:id     (detail)
 *   GET   /api/admin/whatsapp-broadcasts/:id/report   (xlsx)
 *   POST  /api/admin/whatsapp-broadcasts/:id/test-send
 *   POST  /api/admin/whatsapp-broadcasts/:id/resend-failed
 *   POST  /api/admin/whatsapp-broadcasts/:id/cancel
 * ─────────────────────────────────────────────────────────────────────────── */

import * as XLSX from 'xlsx';

// ─── Enums / union types ──────────────────────────────────────────────────────

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
export type TemplateStatus = 'ACTIVE' | 'ARCHIVED';

export type AudienceMode = 'FILTER' | 'EXCEL';
export type AudienceScope = 'OUTLETS' | 'SALES' | 'BOTH';

export type BroadcastStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'SENDING'
  | 'SENT'
  | 'CANCELLED';

export type RecipientStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'SKIPPED';

// ─── Template library ─────────────────────────────────────────────────────────

/** One ordered variable in a template's contract: `{{index}}` → a human label. */
export interface TemplateVariable {
  index: number;
  label: string;
}

export interface WhatsappTemplate {
  id: string;
  clientId?: string;
  name: string;
  msg91TemplateName: string;
  category: TemplateCategory;
  languageCode: string;
  bodyText: string;
  variableContract: TemplateVariable[];
  status: TemplateStatus;
  createdAt?: string;
  updatedAt?: string;
}

/** The editable subset used by the template create/edit form. */
export interface TemplateFormValues {
  name: string;
  msg91TemplateName: string;
  category: TemplateCategory;
  languageCode: string;
  bodyText: string;
  variableContract: TemplateVariable[];
}

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
];

export function emptyTemplateForm(): TemplateFormValues {
  return {
    name: '',
    msg91TemplateName: '',
    category: 'UTILITY',
    languageCode: 'en',
    bodyText: '',
    variableContract: [],
  };
}

// ─── Audience filter ──────────────────────────────────────────────────────────

/**
 * FILTER-mode audience config. Superset of the scheme-broadcast filter
 * (`{ outletTypeIds, programNames, programCategories, zones, states, kycApprovedOnly }`)
 * plus `cities` and `groupIds` which the console UI exposes (owner-listed audience
 * fields: state/city/program/category/outlet-type/KYC-status/group). All list
 * fields are optional — an empty filter targets the whole assumed tenant, and the
 * backend does the actual resolution.
 */
export interface AudienceFilter {
  states?: string[];
  cities?: string[];
  zones?: string[];
  programNames?: string[];
  programCategories?: string[];
  outletTypeIds?: string[];
  groupIds?: string[];
  kycApprovedOnly?: boolean;
}

export function emptyFilter(): AudienceFilter {
  return {};
}

/** True when a filter carries no active constraint (targets everyone in scope). */
export function isFilterEmpty(f: AudienceFilter): boolean {
  const lists: (string[] | undefined)[] = [
    f.states,
    f.cities,
    f.zones,
    f.programNames,
    f.programCategories,
    f.outletTypeIds,
    f.groupIds,
  ];
  const anyList = lists.some((l) => Array.isArray(l) && l.length > 0);
  return !anyList && !f.kycApprovedOnly;
}

/** Parse a comma / newline separated free-text field into a trimmed, de-duped list. */
export function parseCsvList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ─── Phone helpers ────────────────────────────────────────────────────────────

/** Strip everything but digits, then drop a country prefix down to the bare 10. */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

/** A valid Indian mobile is 10 digits starting 6-9 after normalization. */
export function isValidPhone(raw: string): boolean {
  const n = normalizePhone(raw);
  return /^[6-9]\d{9}$/.test(n);
}

// ─── Variable contract / body rendering ───────────────────────────────────────

/** Distinct `{{n}}` indexes used in a body, ascending (e.g. "Hi {{1}} {{2}}" → [1,2]). */
export function extractVariableIndexes(bodyText: string): number[] {
  const found = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Render a template body by substituting `{{n}}` with the provided values (1-based).
 * A missing value renders as its own placeholder so the gap is visible, not silent.
 */
export function renderTemplateBody(
  bodyText: string,
  values: Record<number, string>,
): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, digits) => {
    const idx = Number(digits);
    const v = values[idx];
    return v !== undefined && v !== '' ? v : whole;
  });
}

/** "{{1}}=Outlet name, {{2}}=Amount" — human hint of a variable contract. */
export function contractHint(contract: TemplateVariable[]): string {
  if (!contract || contract.length === 0) return 'No variables';
  return contract
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((v) => `{{${v.index}}}=${v.label || 'unlabelled'}`)
    .join(', ');
}

/**
 * WhatsApp/Meta bills MARKETING conversations; UTILITY/AUTHENTICATION ride an
 * open service window and are effectively free per-message here. Surfaced (not
 * hidden) so an operator understands the cost profile before a blast.
 */
export function categoryIsPaid(category: TemplateCategory): boolean {
  return category === 'MARKETING';
}

export function categoryCostNote(category: TemplateCategory): string {
  return categoryIsPaid(category)
    ? 'Marketing template — each message is billed per Meta conversation pricing.'
    : 'Utility / authentication template — no per-message marketing charge.';
}

// ─── Template validation (create / edit form) ─────────────────────────────────

export interface TemplateValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof TemplateFormValues, string>> & { form?: string };
}

/**
 * Validate a template form. The load-bearing rule: the declared variable contract
 * must exactly cover the `{{n}}` placeholders actually used in the body — contiguous
 * 1..n, no gaps, no extras, every label filled. A mismatch here means MSG91 send
 * would fail or render wrong, so it blocks save.
 */
export function validateTemplateForm(
  form: TemplateFormValues,
): TemplateValidationResult {
  const errors: TemplateValidationResult['errors'] = {};

  if (!form.name.trim()) errors.name = 'Display name is required.';
  if (!form.msg91TemplateName.trim())
    errors.msg91TemplateName = 'MSG91 template name is required.';
  if (!form.languageCode.trim()) errors.languageCode = 'Language code is required.';
  if (!TEMPLATE_CATEGORIES.includes(form.category))
    errors.category = 'Pick a valid category.';
  if (!form.bodyText.trim()) errors.bodyText = 'Message body is required.';

  const usedIndexes = extractVariableIndexes(form.bodyText);
  const contractIndexes = form.variableContract
    .map((v) => v.index)
    .sort((a, b) => a - b);

  // Contract must be contiguous 1..n matching the body placeholders exactly.
  const expected = usedIndexes.join(',');
  const declared = contractIndexes.join(',');
  if (expected !== declared) {
    errors.variableContract =
      usedIndexes.length === 0
        ? 'Body has no variables — remove the declared variables.'
        : `Declared variables must match the body placeholders ({{${usedIndexes.join('}}, {{')}}}).`;
  } else {
    // 1..n contiguity check (guards against {{2}} without {{1}}).
    for (let i = 0; i < usedIndexes.length; i++) {
      if (usedIndexes[i] !== i + 1) {
        errors.variableContract =
          'Variables must be numbered contiguously starting at {{1}} (no gaps).';
        break;
      }
    }
  }

  // Every declared variable needs a label.
  if (!errors.variableContract && form.variableContract.some((v) => !v.label.trim())) {
    errors.variableContract = 'Every variable needs a label.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

// ─── Excel audience parse (client-side read) ──────────────────────────────────

export interface ExcelParseResult {
  /** Ordered variable columns (every header that is not the phone column). */
  columns: string[];
  /** One row per data line: normalized phone + a value map keyed by column header. */
  rows: { phone: string; rawPhone: string; vars: Record<string, string> }[];
  phoneColumn: string | null;
  invalidCount: number;
  duplicateCount: number;
  totalRows: number;
  error?: string;
}

const PHONE_HEADER_RE = /phone|mobile|contact|number|msisdn|whatsapp/i;

/**
 * Recipient ceiling — the backend caps a broadcast at 50 000 recipients, so a
 * file with more rows than this will be truncated server-side. We warn before send.
 */
export const EXCEL_MAX_ROWS = 50_000;

/**
 * Byte ceiling for a client-side parse. `XLSX.read` is synchronous and blocks the
 * main thread, so a very large file freezes the tab. We reject oversized files
 * BEFORE reading them into memory. 10 MB comfortably holds a 50 000-row list.
 */
export const EXCEL_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ExcelFileCheck {
  ok: boolean;
  error?: string;
}

/**
 * Guard an uploaded file by size BEFORE parsing it (pure — pass `{ size }` from the
 * File). Rejects anything over `EXCEL_MAX_BYTES` so the synchronous XLSX parse never
 * freezes the tab on a huge upload.
 */
export function checkExcelFile(file: { size: number }): ExcelFileCheck {
  if (file.size > EXCEL_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const capMb = Math.round(EXCEL_MAX_BYTES / (1024 * 1024));
    return {
      ok: false,
      error: `That file is ${mb} MB — too large to open in the browser. Keep it under ${capMb} MB (split very large lists, or remove unused columns). The list can hold up to ${EXCEL_MAX_ROWS.toLocaleString('en-IN')} recipients.`,
    };
  }
  return { ok: true };
}

/**
 * Parse an uploaded Excel/CSV audience file. Expects a header row with a phone
 * column (detected by name) plus zero or more variable columns. Every non-phone
 * column becomes a mappable variable source. Pure w.r.t. the DOM — hand it an
 * ArrayBuffer read from a File.
 */
export function parseExcelAudience(buffer: ArrayBuffer): ExcelParseResult {
  const empty: ExcelParseResult = {
    columns: [],
    rows: [],
    phoneColumn: null,
    invalidCount: 0,
    duplicateCount: 0,
    totalRows: 0,
  };
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch {
    return { ...empty, error: 'Could not read the file. Upload a valid .xlsx or .csv.' };
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { ...empty, error: 'The file has no sheets.' };
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
    blankrows: false,
  });
  if (aoa.length < 2)
    return { ...empty, error: 'The file needs a header row and at least one data row.' };

  const headers = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const phoneIdx = headers.findIndex((h) => PHONE_HEADER_RE.test(h));
  if (phoneIdx < 0)
    return {
      ...empty,
      error: 'No phone column found. Add a column named "Phone" (or Mobile / Number).',
    };

  const phoneColumn = headers[phoneIdx];
  const columns = headers.filter((_, i) => i !== phoneIdx && headers[i] !== '');

  const rows: ExcelParseResult['rows'] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;
  let totalRows = 0;

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] as unknown[];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
    totalRows++;
    const rawPhone = String(row[phoneIdx] ?? '').trim();
    const phone = normalizePhone(rawPhone);
    const vars: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      if (c === phoneIdx || headers[c] === '') continue;
      vars[headers[c]] = String(row[c] ?? '').trim();
    }
    if (!isValidPhone(rawPhone)) {
      invalidCount++;
      rows.push({ phone, rawPhone, vars });
      continue;
    }
    if (seen.has(phone)) {
      duplicateCount++;
      continue;
    }
    seen.add(phone);
    rows.push({ phone, rawPhone, vars });
  }

  return { columns, rows, phoneColumn, invalidCount, duplicateCount, totalRows };
}

// ─── Variable mapping ─────────────────────────────────────────────────────────

/**
 * How each template variable ({{n}}) gets its value:
 *  - FILTER mode: from an outlet/rep FIELD (e.g. "outletName") or a CONSTANT string.
 *  - EXCEL mode:  from an uploaded COLUMN header.
 */
export type VarMappingKind = 'FIELD' | 'CONSTANT' | 'COLUMN';

export interface VarMapping {
  kind: VarMappingKind;
  /** Field key, column header, or the literal constant text — depending on kind. */
  value: string;
}

/**
 * Fields available to map from when the audience is a FILTER (outlet/rep records).
 *
 * Each field is tagged with the audience scope(s) whose records actually carry it:
 * outlet-record fields (name/owner/code/city/state/program) resolve for OUTLETS,
 * the sales-rep name resolves for SALES. Mapping a wrong-scope field would render
 * blank / the raw `{{n}}` in the sent message, so the map step only offers the
 * fields valid for the chosen scope (see `fieldOptionsForScope`).
 */
export interface FilterFieldOption {
  key: string;
  label: string;
  /** Audience scopes whose records expose this field. */
  scopes: AudienceScope[];
}

export const FILTER_FIELD_OPTIONS: readonly FilterFieldOption[] = [
  { key: 'outletName', label: 'Outlet name', scopes: ['OUTLETS'] },
  { key: 'ownerName', label: 'Owner / contact name', scopes: ['OUTLETS'] },
  { key: 'outletCode', label: 'Outlet code', scopes: ['OUTLETS'] },
  { key: 'city', label: 'City', scopes: ['OUTLETS'] },
  { key: 'state', label: 'State', scopes: ['OUTLETS'] },
  { key: 'programName', label: 'Program name', scopes: ['OUTLETS'] },
  { key: 'salesRepName', label: 'Sales rep name', scopes: ['SALES'] },
];

/**
 * The mappable fields valid for a given audience scope. A BOTH blast targets both
 * record types, so it may use any field (each resolves for its applicable subset);
 * an OUTLETS blast never offers "Sales rep name", and a SALES blast never offers
 * outlet-only fields — mapping a wrong-scope field yields a blank/`{{n}}` in the
 * message.
 */
export function fieldOptionsForScope(scope: AudienceScope): FilterFieldOption[] {
  if (scope === 'BOTH') return [...FILTER_FIELD_OPTIONS];
  return FILTER_FIELD_OPTIONS.filter((o) => o.scopes.includes(scope));
}

export type VariableMappingMap = Record<number, VarMapping>;

/** Build a mapping keyed by variable index → the payload the create API expects. */
export function serializeVariableMapping(
  mapping: VariableMappingMap,
): { index: number; kind: VarMappingKind; value: string }[] {
  return Object.entries(mapping)
    .map(([index, m]) => ({ index: Number(index), kind: m.kind, value: m.value }))
    .sort((a, b) => a.index - b.index);
}

/** True when every variable in the contract has a non-empty mapping. */
export function isMappingComplete(
  contract: TemplateVariable[],
  mapping: VariableMappingMap,
): boolean {
  if (!contract || contract.length === 0) return true;
  return contract.every((v) => {
    const m = mapping[v.index];
    return !!m && m.value.trim() !== '';
  });
}

// ─── Wizard state machine ─────────────────────────────────────────────────────

export const WIZARD_STEPS = ['audience', 'template', 'map', 'preview', 'send'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  audience: 'Audience',
  template: 'Template',
  map: 'Map variables',
  preview: 'Preview',
  send: 'Test & send',
};

export interface PreviewResult {
  recipientCount: number;
  deduped: number;
  invalidCount: number;
  sample: { phone: string; renderedBody: string }[];
  estimatedCost?: number | null;
  costNote?: string | null;
}

export interface WizardState {
  step: WizardStep;
  title: string;
  audienceMode: AudienceMode;
  scope: AudienceScope;
  filter: AudienceFilter;
  excel: ExcelParseResult | null;
  templateId: string | null;
  mapping: VariableMappingMap;
  /** The last successful preview. Cleared whenever an upstream input changes. */
  preview: PreviewResult | null;
  scheduledAt: string | null;
}

export function initialWizardState(): WizardState {
  return {
    step: 'audience',
    title: '',
    audienceMode: 'FILTER',
    scope: 'OUTLETS',
    filter: {},
    excel: null,
    templateId: null,
    mapping: {},
    preview: null,
    scheduledAt: null,
  };
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/** Can the user leave the AUDIENCE step? */
export function canLeaveAudience(s: WizardState): boolean {
  if (!s.title.trim()) return false;
  if (s.audienceMode === 'EXCEL') {
    return !!s.excel && s.excel.rows.some((r) => isValidPhone(r.rawPhone));
  }
  // FILTER mode: always allowed to proceed; the real recipient count is enforced
  // at the preview gate (an empty filter legitimately targets the whole tenant).
  return true;
}

/** Can the user leave the TEMPLATE step? Requires an ACTIVE template chosen. */
export function canLeaveTemplate(
  s: WizardState,
  templates: WhatsappTemplate[],
): boolean {
  if (!s.templateId) return false;
  const t = templates.find((x) => x.id === s.templateId);
  return !!t && t.status === 'ACTIVE';
}

/** Can the user leave the MAP step? Every template variable must be mapped. */
export function canLeaveMap(
  s: WizardState,
  templates: WhatsappTemplate[],
): boolean {
  const t = templates.find((x) => x.id === s.templateId);
  if (!t) return false;
  return isMappingComplete(t.variableContract, s.mapping);
}

/**
 * Can the user leave PREVIEW (i.e. is Send unlocked)? The confirm-before-send
 * guard: a preview must have succeeded, it must not be stale (no upstream input
 * changed since), and it must resolve to at least one recipient.
 */
export function canSend(s: WizardState): boolean {
  return !!s.preview && s.preview.recipientCount > 0;
}

/** Whether a given step is currently unlocked given prior-step completion. */
export function isStepUnlocked(
  s: WizardState,
  step: WizardStep,
  templates: WhatsappTemplate[],
): boolean {
  switch (step) {
    case 'audience':
      return true;
    case 'template':
      return canLeaveAudience(s);
    case 'map':
      return canLeaveAudience(s) && canLeaveTemplate(s, templates);
    case 'preview':
      return (
        canLeaveAudience(s) &&
        canLeaveTemplate(s, templates) &&
        canLeaveMap(s, templates)
      );
    case 'send':
      return (
        canLeaveAudience(s) &&
        canLeaveTemplate(s, templates) &&
        canLeaveMap(s, templates) &&
        canSend(s)
      );
    default:
      return false;
  }
}

export function canAdvance(s: WizardState, templates: WhatsappTemplate[]): boolean {
  switch (s.step) {
    case 'audience':
      return canLeaveAudience(s);
    case 'template':
      return canLeaveTemplate(s, templates);
    case 'map':
      return canLeaveMap(s, templates);
    case 'preview':
      return canSend(s);
    case 'send':
      return false; // terminal step
    default:
      return false;
  }
}

// ─── Wizard reducer ───────────────────────────────────────────────────────────

export type WizardAction =
  | { type: 'SET_TITLE'; title: string }
  | { type: 'SET_MODE'; mode: AudienceMode }
  | { type: 'SET_SCOPE'; scope: AudienceScope }
  | { type: 'SET_FILTER'; filter: AudienceFilter }
  | { type: 'SET_EXCEL'; excel: ExcelParseResult | null }
  | { type: 'SELECT_TEMPLATE'; templateId: string | null }
  | { type: 'SET_MAPPING'; index: number; mapping: VarMapping }
  | { type: 'RESET_MAPPING'; mapping: VariableMappingMap }
  | { type: 'SET_PREVIEW'; preview: PreviewResult | null }
  | { type: 'SET_SCHEDULE'; scheduledAt: string | null }
  | { type: 'GO'; step: WizardStep; templates: WhatsappTemplate[] }
  | { type: 'NEXT'; templates: WhatsappTemplate[] }
  | { type: 'BACK' };

/**
 * Any edit to an upstream input (audience, template, mapping) INVALIDATES a prior
 * preview — so Send can never fire against a stale count. This is the core safety
 * invariant of the wizard and is asserted directly by the tests.
 */
function invalidatePreview<T extends WizardState>(s: T): T {
  return s.preview ? { ...s, preview: null } : s;
}

export function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case 'SET_TITLE':
      return invalidatePreview({ ...state, title: action.title });
    case 'SET_MODE':
      // Switching mode clears the other mode's audience data + preview.
      return invalidatePreview({
        ...state,
        audienceMode: action.mode,
        excel: action.mode === 'EXCEL' ? state.excel : null,
        mapping: {},
      });
    case 'SET_SCOPE':
      return invalidatePreview({ ...state, scope: action.scope });
    case 'SET_FILTER':
      return invalidatePreview({ ...state, filter: action.filter });
    case 'SET_EXCEL':
      return invalidatePreview({ ...state, excel: action.excel, mapping: {} });
    case 'SELECT_TEMPLATE':
      // A new template means a new variable contract → drop the old mapping.
      return invalidatePreview({
        ...state,
        templateId: action.templateId,
        mapping: {},
      });
    case 'SET_MAPPING':
      return invalidatePreview({
        ...state,
        mapping: { ...state.mapping, [action.index]: action.mapping },
      });
    case 'RESET_MAPPING':
      return invalidatePreview({ ...state, mapping: action.mapping });
    case 'SET_PREVIEW':
      return { ...state, preview: action.preview };
    case 'SET_SCHEDULE':
      return { ...state, scheduledAt: action.scheduledAt };
    case 'GO':
      return isStepUnlocked(state, action.step, action.templates)
        ? { ...state, step: action.step }
        : state;
    case 'NEXT': {
      if (!canAdvance(state, action.templates)) return state;
      const idx = stepIndex(state.step);
      const next = WIZARD_STEPS[Math.min(idx + 1, WIZARD_STEPS.length - 1)];
      return { ...state, step: next };
    }
    case 'BACK': {
      const idx = stepIndex(state.step);
      const prev = WIZARD_STEPS[Math.max(idx - 1, 0)];
      return { ...state, step: prev };
    }
    default:
      return state;
  }
}

// ─── Create-broadcast payload ─────────────────────────────────────────────────

export interface CreateBroadcastPayload {
  title: string;
  templateId: string;
  mode: AudienceMode;
  scope?: AudienceScope;
  filter?: AudienceFilter;
  excelRows?: { phone: string; vars: Record<string, string> }[];
  variableMapping: { index: number; kind: VarMappingKind; value: string }[];
  scheduledAt?: string | null;
}

/** Build the POST /api/admin/whatsapp-broadcasts body from wizard state. */
export function buildCreatePayload(s: WizardState): CreateBroadcastPayload {
  const base: CreateBroadcastPayload = {
    title: s.title.trim(),
    templateId: s.templateId ?? '',
    mode: s.audienceMode,
    variableMapping: serializeVariableMapping(s.mapping),
    scheduledAt: s.scheduledAt ?? null,
  };
  if (s.audienceMode === 'FILTER') {
    base.scope = s.scope;
    base.filter = s.filter;
  } else {
    base.excelRows = (s.excel?.rows ?? [])
      .filter((r) => isValidPhone(r.rawPhone))
      .map((r) => ({ phone: r.phone, vars: r.vars }));
  }
  return base;
}

/** Build the preview request body (same shape, mapping used to render the sample). */
export function buildPreviewPayload(s: WizardState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: s.audienceMode,
    templateId: s.templateId ?? undefined,
    variableMapping: serializeVariableMapping(s.mapping),
  };
  if (s.audienceMode === 'FILTER') {
    body.scope = s.scope;
    body.filter = s.filter;
  } else {
    body.excelRows = (s.excel?.rows ?? [])
      .filter((r) => isValidPhone(r.rawPhone))
      .map((r) => ({ phone: r.phone, vars: r.vars }));
  }
  return body;
}

// ─── Broadcast history / detail types ─────────────────────────────────────────

export interface BroadcastSummary {
  id: string;
  title: string;
  templateName?: string;
  status: BroadcastStatus;
  audienceMode: AudienceMode;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  scheduledAt?: string | null;
  sentAt?: string | null;
  createdAt: string;
}

export interface FailureReason {
  reason: string;
  count: number;
}

export interface BroadcastDetail extends BroadcastSummary {
  queuedCount?: number;
  failureReasons?: FailureReason[];
  template?: WhatsappTemplate;
  /**
   * Optional backend by-CURRENT-state breakdown (mutually exclusive counts — every
   * recipient falls into exactly one bucket). Preferred by the funnel bar when
   * present; otherwise the bar derives the exclusive segments from the cumulative
   * flat counters (read ⊆ delivered ⊆ sent).
   */
  funnel?: {
    queued?: number;
    sent?: number;
    delivered?: number;
    read?: number;
    failed?: number;
  };
}

// ─── Status → funnel / labels ─────────────────────────────────────────────────

export const BROADCAST_STATUS_LABEL: Record<BroadcastStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  SENDING: 'Sending',
  SENT: 'Sent',
  CANCELLED: 'Cancelled',
};

/**
 * The delivery funnel for a campaign detail. `queued` is what remains un-sent —
 * derived so a queued message is honestly labelled "Queued", never "Sent".
 */
export function deliveryFunnel(b: BroadcastSummary & { queuedCount?: number }): {
  key: string;
  label: string;
  count: number;
}[] {
  const queued =
    b.queuedCount ??
    Math.max(0, b.recipientCount - b.sentCount - b.failedCount);
  return [
    { key: 'queued', label: 'Queued', count: queued },
    { key: 'sent', label: 'Sent', count: b.sentCount },
    { key: 'delivered', label: 'Delivered', count: b.deliveredCount },
    { key: 'read', label: 'Read', count: b.readCount },
    { key: 'failed', label: 'Failed', count: b.failedCount },
  ];
}

/**
 * Mutually-exclusive segments for the stacked delivery-progress BAR. Unlike the
 * headline funnel (cumulative totals), every recipient here lands in EXACTLY one
 * bucket, so the widths can never overlap or sum past 100%:
 *   failed | queued | sent-not-delivered | delivered-not-read | read
 *
 * Prefers the backend's by-current-state `funnel` when present; otherwise it
 * derives the exclusive counts from the cumulative flat counters (read ⊆ delivered
 * ⊆ sent). Widths are normalised against the larger of the recipient total and the
 * summed bucket counts, so dirty/over-counting data still yields Σpct ≤ 100.
 */
export interface FunnelSegment {
  key: string;
  label: string;
  count: number;
  pct: number;
}

export function funnelSegments(b: BroadcastDetail): FunnelSegment[] {
  const nn = (v: number | undefined | null) => Math.max(0, Math.floor(Number(v ?? 0)) || 0);

  let queued: number;
  let sentOnly: number;
  let deliveredOnly: number;
  let read: number;
  let failed: number;

  if (b.funnel) {
    // Backend already reports mutually-exclusive by-current-state counts.
    queued = nn(b.funnel.queued);
    sentOnly = nn(b.funnel.sent);
    deliveredOnly = nn(b.funnel.delivered);
    read = nn(b.funnel.read);
    failed = nn(b.funnel.failed);
  } else {
    // Derive exclusive buckets from cumulative counters (read ⊆ delivered ⊆ sent).
    read = nn(b.readCount);
    deliveredOnly = Math.max(0, nn(b.deliveredCount) - read);
    sentOnly = Math.max(0, nn(b.sentCount) - nn(b.deliveredCount));
    failed = nn(b.failedCount);
    queued =
      b.queuedCount != null
        ? nn(b.queuedCount)
        : Math.max(0, nn(b.recipientCount) - nn(b.sentCount) - failed);
  }

  const segs = [
    { key: 'failed', label: 'Failed', count: failed },
    { key: 'queued', label: 'Queued', count: queued },
    { key: 'sent', label: 'Sent', count: sentOnly },
    { key: 'delivered', label: 'Delivered', count: deliveredOnly },
    { key: 'read', label: 'Read', count: read },
  ];

  const sum = segs.reduce((a, s) => a + s.count, 0);
  // Normalise against the larger of the recipient total and the summed buckets so
  // the widths are honest AND never exceed 100% even if counters over-count.
  const denom = Math.max(1, nn(b.recipientCount), sum);
  return segs.map((s) => ({ ...s, pct: (s.count / denom) * 100 }));
}

/** How long after `sentAt` we keep polling for late delivery/read webhooks. */
export const POLL_AFTER_SENT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Whether the campaign-detail view should keep auto-refreshing. It must keep the
 * funnel live not only while SENDING, but AFTER status flips to SENT too — delivery
 * and read receipts arrive by webhook for a while afterwards. Polls while:
 *   - the campaign is SCHEDULED or still SENDING (actively draining); or
 *   - it is SENT but some recipient is still non-terminal (not yet read/failed) AND
 *     we are within a bounded window after `sentAt` (so a permanently-undelivered
 *     recipient can't make us poll forever).
 * Stops for DRAFT/CANCELLED, once every recipient is terminal, or once the window
 * after `sentAt` has elapsed.
 */
export function shouldPollBroadcast(
  b: BroadcastDetail | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!b) return false;
  if (b.status === 'SCHEDULED' || b.status === 'SENDING') return true;
  if (b.status !== 'SENT') return false; // DRAFT / CANCELLED → nothing to poll

  const nonTerminal = Math.max(
    0,
    Math.floor(b.recipientCount) - Math.floor(b.readCount) - Math.floor(b.failedCount),
  );
  if (nonTerminal <= 0) return false; // everyone read or failed → terminal
  if (!b.sentAt) return true; // sent but no timestamp yet → keep polling this cycle
  return now - new Date(b.sentAt).getTime() < POLL_AFTER_SENT_MS;
}

/** A campaign can be cancelled only while it is scheduled or still draining. */
export function canCancelBroadcast(status: BroadcastStatus): boolean {
  return status === 'SCHEDULED' || status === 'SENDING';
}

/** Resend-to-failed is meaningful only once a campaign has finished with failures. */
export function canResendFailed(b: BroadcastSummary): boolean {
  return b.status === 'SENT' && b.failedCount > 0;
}

// ─── Test-send validation ─────────────────────────────────────────────────────

export interface TestSendValidation {
  ok: boolean;
  phones: string[];
  error?: string;
}

/** 1–5 valid test numbers, de-duplicated. */
export function validateTestPhones(raw: string): TestSendValidation {
  const list = parseCsvList(raw).map(normalizePhone);
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (isValidPhone(p) && !seen.has(p)) {
      seen.add(p);
      valid.push(p);
    }
  }
  if (valid.length === 0)
    return { ok: false, phones: [], error: 'Enter at least one valid 10-digit number.' };
  if (valid.length > 5)
    return { ok: false, phones: valid, error: 'Test-send is limited to 5 numbers.' };
  return { ok: true, phones: valid };
}
