'use client';

/**
 * SchemeFormBuilder — full-palette enrollment-form authoring for the Scheme
 * Data-Collection feature (SCHEME-DATA-COLLECTION-DESIGN.md §2 / §13.1).
 *
 * Authors the shared `EnrollmentFormSchema` (from `@/lib/scheme-types`) — the
 * EXACT contract the shared `SchemeFormRenderer` and the backend enforce. It is
 * controlled: the parent owns the schema + campaignType and persists via
 * `schemeApi.upsertEnrollmentForm` (versioned).
 *
 * Supersedes the reward-era `EnrollmentFormBuilder` (which was bound to the old
 * `@/lib/campaign` FormField shape and could not express the net-new palette /
 * per-field prefill-lock / conditional-required / LOOKUP / PHONE_OTP-otpRequired /
 * GPS captureTrigger). Renders every §13.1 field type.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Type, Hash, List,
  Calendar, FileText, Camera, MapPin, Smartphone, Info, AlertCircle, QrCode,
  Eye, Calculator, Mail, CheckSquare, ToggleRight, Phone, Heading1,
  PenLine, Lock, Sparkles,
} from 'lucide-react';
import {
  DISPLAY_ONLY_FIELD_TYPES,
  GPS_CAPTURE_TRIGGERS,
  OUTLET_FIELD_KEYS,
  evaluateFormula,
  type EnrollmentFormSchema,
  type FormField,
  type FormFieldType,
  type GpsCaptureTrigger,
  type VisibleWhen,
  type VisibleWhenOp,
} from '@/lib/scheme-types';
import type { CampaignType } from '@/lib/scheme-types';
import { schemeApi } from '@/lib/schemes';

// ── Field-type metadata ─────────────────────────────────────────────────────

interface FieldMeta {
  type: FormFieldType;
  label: string;
  icon: React.ReactNode;
  desc: string;
  group: 'Input' | 'Choice' | 'Capture' | 'Structure';
}

const FIELD_META: FieldMeta[] = [
  { type: 'TEXT',        label: 'Text',         icon: <Type className="w-4 h-4" />,        desc: 'Single-line text',           group: 'Input' },
  { type: 'EMAIL',       label: 'Email',        icon: <Mail className="w-4 h-4" />,        desc: 'Validated email address',    group: 'Input' },
  { type: 'NUMBER',      label: 'Number',       icon: <Hash className="w-4 h-4" />,        desc: 'Numeric / decimal value',    group: 'Input' },
  { type: 'DATE',        label: 'Date',         icon: <Calendar className="w-4 h-4" />,    desc: 'Date picker',                group: 'Input' },
  { type: 'PHONE_OTP',   label: 'Phone (OTP)',  icon: <Phone className="w-4 h-4" />,       desc: 'OTP-validated mobile',       group: 'Input' },
  { type: 'DROPDOWN',    label: 'Dropdown',     icon: <List className="w-4 h-4" />,        desc: 'Single select',              group: 'Choice' },
  { type: 'MULTI_SELECT',label: 'Multi-select', icon: <CheckSquare className="w-4 h-4" />, desc: 'Choose many',                group: 'Choice' },
  { type: 'TOGGLE',      label: 'Yes / No',     icon: <ToggleRight className="w-4 h-4" />, desc: 'Boolean toggle',             group: 'Choice' },
  { type: 'LOOKUP',      label: 'Lookup',       icon: <Sparkles className="w-4 h-4" />,    desc: 'Map a choice → value',       group: 'Choice' },
  { type: 'DOCUMENT',    label: 'Document',     icon: <FileText className="w-4 h-4" />,    desc: 'File / PDF upload',          group: 'Capture' },
  { type: 'IMAGE',       label: 'Photo',        icon: <Camera className="w-4 h-4" />,      desc: 'Gallery photo + GPS',        group: 'Capture' },
  { type: 'CAMERA',      label: 'Camera',       icon: <Camera className="w-4 h-4" />,      desc: 'Rear-camera capture',        group: 'Capture' },
  { type: 'UPI_QR_SCAN', label: 'UPI QR',       icon: <QrCode className="w-4 h-4" />,      desc: 'Scan QR → UPI id',           group: 'Capture' },
  { type: 'SIGNATURE',   label: 'Signature',    icon: <PenLine className="w-4 h-4" />,     desc: 'Draw a signature',           group: 'Capture' },
  { type: 'GPS_POINT',   label: 'GPS Location', icon: <MapPin className="w-4 h-4" />,      desc: 'Capture coordinates',        group: 'Capture' },
  { type: 'SECTION',     label: 'Section',      icon: <Heading1 className="w-4 h-4" />,    desc: 'Heading / instruction',      group: 'Structure' },
  { type: 'DATA_DISPLAY',label: 'Data Display', icon: <Eye className="w-4 h-4" />,         desc: 'Read-only Excel value',      group: 'Structure' },
  { type: 'CALCULATED',  label: 'Calculation',  icon: <Calculator className="w-4 h-4" />,  desc: 'Auto-computed value',        group: 'Structure' },
];

// Every FORM_FIELD_TYPES member must have metadata (compile-time-ish guard).
const META_BY_TYPE: Record<FormFieldType, FieldMeta> = FIELD_META.reduce(
  (acc, m) => { acc[m.type] = m; return acc; },
  {} as Record<FormFieldType, FieldMeta>,
);

const GROUPS: FieldMeta['group'][] = ['Input', 'Choice', 'Capture', 'Structure'];

/** Fields the filler never edits directly (read-only value or structural). */
const NON_REQUIRABLE: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  'SECTION', 'DATA_DISPLAY', 'CALCULATED', 'LOOKUP',
]);

const CHOICE_TYPES: ReadonlySet<FormFieldType> = new Set<FormFieldType>(['DROPDOWN', 'MULTI_SELECT']);

/**
 * Value fields that can be prefilled from an Excel/roster column. Media
 * (IMAGE/CAMERA/DOCUMENT/UPI_QR_SCAN/SIGNATURE), GPS_POINT, CALCULATED, LOOKUP,
 * SECTION and DATA_DISPLAY are excluded — a photo/GPS/signature/computed value
 * cannot come from an Excel cell.
 */
const PREFILLABLE_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  'TEXT', 'NUMBER', 'EMAIL', 'DATE', 'DROPDOWN', 'MULTI_SELECT', 'TOGGLE', 'PHONE_OTP',
]);

function uid() { return Math.random().toString(36).slice(2, 9); }

function defaultField(type: FormFieldType, order: number): FormField {
  return {
    id: uid(),
    type,
    label: '',
    required: false,
    placeholder: '',
    helpText: '',
    options: CHOICE_TYPES.has(type) ? [''] : undefined,
    formula: type === 'CALCULATED' ? '' : undefined,
    lookupMap: type === 'LOOKUP' ? {} : undefined,
    captureTrigger: type === 'GPS_POINT' ? 'MANUAL' : undefined,
    otpRequired: type === 'PHONE_OTP' ? true : undefined,
    order,
  };
}

// ── Client-side validation (mirrors the backend validateFormSchema subset) ────

export function validateSchemeFormSchema(schema: EnrollmentFormSchema): string[] {
  const errors: string[] = [];
  const fields = schema.fields ?? [];
  if (fields.length === 0) errors.push('Add at least one field.');
  const ids = new Set(fields.map((f) => f.id));

  fields.forEach((f, i) => {
    const pos = `Field ${i + 1}`;
    const name = f.label || META_BY_TYPE[f.type]?.label || f.type;
    if (f.type !== 'SECTION' && !f.label.trim()) errors.push(`${pos}: label cannot be empty.`);
    if (f.type === 'SECTION' && !f.label.trim()) errors.push(`${pos}: section heading cannot be empty.`);

    if (CHOICE_TYPES.has(f.type)) {
      const opts = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length === 0) errors.push(`${pos} ("${name}"): add at least one option.`);
      else if (new Set(opts).size !== opts.length) errors.push(`${pos} ("${name}"): options must be unique — remove the duplicate.`);
    }
    if (f.type === 'CALCULATED') {
      if (!(f.formula ?? '').trim()) errors.push(`${pos} ("${name}"): formula cannot be empty.`);
      else {
        for (const ref of Array.from((f.formula ?? '').matchAll(/\{([^}]+)\}/g)).map((m) => m[1])) {
          if (!ids.has(ref)) errors.push(`${pos} ("${name}"): formula references an unknown field.`);
        }
      }
    }
    if (f.type === 'LOOKUP') {
      if (!f.lookupSourceFieldId) errors.push(`${pos} ("${name}"): pick a source dropdown.`);
      else if (!ids.has(f.lookupSourceFieldId)) errors.push(`${pos} ("${name}"): lookup source no longer exists.`);
      const mapped = Object.values(f.lookupMap ?? {}).filter((v) => (v ?? '').trim());
      if (mapped.length === 0) errors.push(`${pos} ("${name}"): add at least one lookup mapping.`);
    }
    for (const [key, clause] of [['visibleWhen', f.visibleWhen], ['requiredWhen', f.requiredWhen]] as const) {
      if (!clause) continue;
      if (clause.fieldId === f.id) errors.push(`${pos} ("${name}"): ${key} cannot depend on itself.`);
      else if (!ids.has(clause.fieldId)) errors.push(`${pos} ("${name}"): ${key} references an unknown field.`);
    }

    // Dual-source prefill: an outletField binding must be a recognised Outlet-master key.
    if (f.outletField !== undefined && f.outletField !== '' && !OUTLET_FIELD_KEYS.has(f.outletField)) {
      errors.push(`${pos} ("${name}"): outlet-field prefill is not a recognised outlet field.`);
    }
    // GPS accuracy cap (D15): when set, must be a positive number.
    if (f.gpsMaxAccuracy !== undefined && f.gpsMaxAccuracy !== null && !(Number(f.gpsMaxAccuracy) > 0)) {
      errors.push(`${pos} ("${name}"): GPS accuracy cap must be a positive number.`);
    }
    // A locked, Excel-prefilled phone field must verify consent via OTP (D16).
    if (f.type === 'PHONE_OTP' && f.locked && (f.prefillKey ?? '').trim() && !f.otpRequired) {
      errors.push(`${pos} ("${name}"): a locked, Excel-prefilled phone field must have otpRequired enabled.`);
    }
  });

  if (schema.requireOtp && !fields.some((f) => f.type === 'PHONE_OTP')) {
    errors.push('OTP is required but no Phone (OTP) field exists — add one or turn OTP off.');
  }
  if (schema.captureGpsOnSubmit && !fields.some((f) => f.type === 'GPS_POINT')) {
    errors.push('Capture GPS on submit is on but no GPS Location field exists — add one or turn it off.');
  }
  return errors;
}

// ── Condition editor (shared by visibleWhen + requiredWhen) ───────────────────

const OP_LABELS: { value: VisibleWhenOp; label: string }[] = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
];

function ConditionEditor({
  title, clause, otherFields, allFields, onChange,
}: {
  title: string;
  clause: VisibleWhen | undefined;
  otherFields: FormField[];
  allFields: FormField[];
  onChange: (c: VisibleWhen | undefined) => void;
}) {
  const enabled = !!clause;
  const dep = clause ? allFields.find((f) => f.id === clause.fieldId) : undefined;
  return (
    <div className="pt-1 border-t border-gray-100 space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (!e.target.checked) onChange(undefined);
            else if (otherFields.length > 0) onChange({ fieldId: otherFields[0].id, op: 'eq', value: '' });
          }}
          className="w-3.5 h-3.5 accent-[var(--brand-primary)]"
        />
        <span className="text-[11px] text-gray-600 font-medium">{title}</span>
      </label>
      {enabled && clause && (
        <div className="flex flex-wrap items-center gap-2 pl-5">
          <select
            value={clause.fieldId}
            onChange={(e) => onChange({ ...clause, fieldId: e.target.value })}
            className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
          >
            {otherFields.map((f) => <option key={f.id} value={f.id}>{f.label || '(Untitled)'}</option>)}
          </select>
          <select
            value={clause.op}
            onChange={(e) => onChange({ ...clause, op: e.target.value as VisibleWhenOp })}
            className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
          >
            {OP_LABELS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
          {CHOICE_TYPES.has(dep?.type ?? 'TEXT') ? (
            <select
              value={clause.value}
              onChange={(e) => onChange({ ...clause, value: e.target.value })}
              className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
            >
              <option value="">Select…</option>
              {(dep?.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={clause.value}
              onChange={(e) => onChange({ ...clause, value: e.target.value })}
              placeholder="value"
              className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 w-24"
            />
          )}
        </div>
      )}
      {enabled && otherFields.length === 0 && (
        <p className="text-[10px] text-gray-400 pl-5">Add more fields to build a condition.</p>
      )}
    </div>
  );
}

// ── Mobile preview cell ───────────────────────────────────────────────────────

function PreviewField({ field }: { field: FormField }) {
  const label = field.label || <span className="text-gray-300 italic">Untitled field</span>;
  const star = field.required ? <span className="text-red-500 ml-0.5">*</span> : null;
  if (field.type === 'SECTION') {
    return (
      <div className="mb-3 pt-1">
        <p className="text-[12px] font-bold text-gray-800">{label}</p>
        {field.helpText && <p className="text-[10px] text-gray-400">{field.helpText}</p>}
      </div>
    );
  }
  const box = (inner: React.ReactNode) => (
    <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400">{inner}</div>
  );
  return (
    <div className="mb-3">
      <p className="text-[11px] font-semibold text-gray-700 mb-1 flex items-center gap-1">
        {label}{star}
        {field.locked && <Lock className="w-2.5 h-2.5 text-gray-400" />}
      </p>
      {field.type === 'TEXT' && box(field.placeholder || 'Enter text…')}
      {field.type === 'EMAIL' && box(field.placeholder || 'name@email.com')}
      {field.type === 'NUMBER' && box(field.placeholder || '0')}
      {field.type === 'DATE' && box('DD / MM / YYYY')}
      {field.type === 'DROPDOWN' && (
        <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400 flex items-center justify-between">
          <span>{field.options?.[0] || 'Select…'}</span><ChevronRight className="w-3 h-3 rotate-90" />
        </div>
      )}
      {field.type === 'MULTI_SELECT' && (
        <div className="space-y-1">
          {(field.options ?? ['Option']).slice(0, 3).map((o, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-gray-500"><span className="w-3 h-3 border border-gray-300 rounded-sm" />{o || `Option ${i + 1}`}</div>
          ))}
        </div>
      )}
      {field.type === 'TOGGLE' && (
        <div className="flex items-center gap-2"><div className="w-8 h-4 rounded-full bg-gray-200 relative"><div className="w-3 h-3 bg-white rounded-full absolute top-0.5 left-0.5 shadow" /></div><span className="text-[10px] text-gray-400">No</span></div>
      )}
      {field.type === 'PHONE_OTP' && (
        <div className="space-y-1">{box(field.locked ? '•••• on file (locked)' : '10-digit mobile')}<span className="text-[9px] text-amber-500">OTP verification</span></div>
      )}
      {field.type === 'DOCUMENT' && (
        <div className="border-2 border-dashed border-gray-200 rounded-lg p-2 text-center"><FileText className="w-4 h-4 text-gray-300 mx-auto" /><p className="text-[9px] text-gray-400">Upload document</p></div>
      )}
      {(field.type === 'IMAGE' || field.type === 'CAMERA') && (
        <div className="border-2 border-dashed border-pink-200 rounded-lg p-2 text-center bg-pink-50/40"><Camera className="w-4 h-4 text-pink-300 mx-auto" /><p className="text-[9px] text-pink-400">Capture photo</p></div>
      )}
      {field.type === 'UPI_QR_SCAN' && box('scan / type UPI id')}
      {field.type === 'SIGNATURE' && (
        <div className="border border-gray-200 rounded-lg h-10 bg-white flex items-center justify-center"><PenLine className="w-4 h-4 text-gray-300" /></div>
      )}
      {field.type === 'GPS_POINT' && (
        <div className="border border-green-200 rounded-lg p-2 text-center bg-green-50"><MapPin className="w-4 h-4 text-green-500 mx-auto" /><p className="text-[9px] text-green-600">{field.captureTrigger === 'ON_SUBMIT' ? 'Auto on submit' : field.captureTrigger === 'ON_PHOTO' ? 'Tagged to photo' : 'Tap to capture'}</p></div>
      )}
      {field.type === 'DATA_DISPLAY' && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg"><Eye className="w-3 h-3 text-slate-400" /><span className="text-[10px] text-slate-600">[{field.dataDisplayKey || field.prefillKey || 'Excel value'}]</span></div>
      )}
      {field.type === 'CALCULATED' && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-orange-50 border border-orange-200 rounded-lg"><Calculator className="w-3 h-3 text-orange-400" /><span className="text-[10px] text-orange-600">= computed</span></div>
      )}
      {field.type === 'LOOKUP' && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-indigo-50 border border-indigo-200 rounded-lg"><Sparkles className="w-3 h-3 text-indigo-400" /><span className="text-[10px] text-indigo-600">= mapped value</span></div>
      )}
      {field.helpText && <p className="text-[9px] text-gray-400 mt-0.5">{field.helpText}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PrefillSourcesState {
  excelColumns: string[];
  outletFields: { key: string; label: string }[];
}

interface Props {
  value: EnrollmentFormSchema;
  campaignType: CampaignType;
  onChange: (schema: EnrollmentFormSchema) => void;
  onCampaignTypeChange: (t: CampaignType) => void;
  /** The scheme being authored — its roster columns + outlet-field catalog seed the prefill pickers (H1). */
  schemeId: string;
  /** Show Excel prefill controls (Mode B roster is active). */
  showPrefill?: boolean;
}

export function SchemeFormBuilder({
  value, campaignType, onChange, onCampaignTypeChange, schemeId, showPrefill = false,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [prefillSources, setPrefillSources] = useState<PrefillSourcesState>({ excelColumns: [], outletFields: [] });

  // H1: load this scheme's prefill sources (roster Excel columns + curated outlet fields)
  // to populate the "Prefill from" source pickers. Defaults stay empty on any failure.
  useEffect(() => {
    let cancelled = false;
    schemeApi.getPrefillSources(schemeId).then((res) => {
      if (cancelled || !res.success) return;
      setPrefillSources({
        excelColumns: res.data.excelColumns ?? [],
        outletFields: res.data.outletFields ?? [],
      });
    });
    return () => { cancelled = true; };
  }, [schemeId]);

  const fields = value.fields;

  const setFields = (next: FormField[]) => onChange({ ...value, fields: next });
  const patch = (id: string, p: Partial<FormField>) =>
    setFields(fields.map((f) => (f.id === id ? { ...f, ...p } : f)));

  const addField = (type: FormFieldType) => {
    const next = defaultField(type, fields.length);
    setFields([...fields, next]);
    setExpandedId(next.id);
    setShowPicker(false);
  };
  const removeField = (id: string) => {
    setFields(fields.filter((f) => f.id !== id).map((f, i) => ({ ...f, order: i })));
    if (expandedId === id) setExpandedId(null);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= fields.length) return;
    const copy = [...fields];
    const [m] = copy.splice(idx, 1);
    copy.splice(to, 0, m);
    setFields(copy.map((f, i) => ({ ...f, order: i })));
  };

  const setOption = (id: string, oi: number, v: string) => {
    const f = fields.find((x) => x.id === id);
    if (!f?.options) return;
    const opts = [...f.options];
    opts[oi] = v;
    patch(id, { options: opts });
  };
  const addOption = (id: string) => {
    const f = fields.find((x) => x.id === id);
    patch(id, { options: [...(f?.options ?? []), ''] });
  };
  const removeOption = (id: string, oi: number) => {
    const f = fields.find((x) => x.id === id);
    if (!f?.options) return;
    patch(id, { options: f.options.filter((_, i) => i !== oi) });
  };

  const errors = useMemo(() => validateSchemeFormSchema(value), [value]);

  return (
    <div className="flex gap-4">
      {/* Builder panel */}
      <div className="flex-1 space-y-3 min-w-0">
        {/* Campaign type + global settings */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Campaign type</label>
            <select
              value={campaignType}
              onChange={(e) => onCampaignTypeChange(e.target.value as CampaignType)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            >
              <option value="LOYALTY_ONLY">Loyalty only</option>
              <option value="OPEN_CAMPAIGN">Open campaign</option>
              <option value="MIXED">Mixed</option>
            </select>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => onChange({ ...value, captureGpsOnSubmit: !value.captureGpsOnSubmit })}
              className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${value.captureGpsOnSubmit ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}
              aria-pressed={value.captureGpsOnSubmit}
            >
              <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${value.captureGpsOnSubmit ? 'left-4' : 'left-0.5'}`} />
            </button>
            <div>
              <p className="text-xs font-medium text-gray-800">Capture GPS on submit</p>
              <p className="text-[11px] text-gray-500">Device location recorded when the form is submitted.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => onChange({ ...value, requireOtp: !value.requireOtp })}
              className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${value.requireOtp ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}
              aria-pressed={value.requireOtp}
            >
              <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${value.requireOtp ? 'left-4' : 'left-0.5'}`} />
            </button>
            <div>
              <p className="text-xs font-medium text-gray-800">Require phone-OTP verification</p>
              <p className="text-[11px] text-gray-500">A verified Phone (OTP) field must be completed before submit (D16).</p>
            </div>
          </label>
        </div>

        {/* Validation */}
        {errors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {e}
              </p>
            ))}
          </div>
        )}

        {/* Field list */}
        {fields.length === 0 && (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-6 text-center text-gray-400">
            <Type className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No fields yet — add your first field below.</p>
          </div>
        )}

        {fields.map((field, idx) => {
          const meta = META_BY_TYPE[field.type];
          const isExpanded = expandedId === field.id;
          const otherFields = fields.filter((f) => f.id !== field.id);
          const numericFields = otherFields.filter((f) => f.type === 'NUMBER' || f.type === 'CALCULATED');
          const dropdownFields = otherFields.filter((f) => f.type === 'DROPDOWN');
          const isDisplayOnly = DISPLAY_ONLY_FIELD_TYPES.has(field.type);
          return (
            <div key={field.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
                  <button onClick={() => move(idx, 1)} disabled={idx === fields.length - 1} className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
                </div>
                <div className="p-1.5 rounded-lg flex-shrink-0 bg-gray-100 text-gray-600">{meta.icon}</div>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => patch(field.id, { label: e.target.value })}
                  placeholder={`${meta.label} label…`}
                  className="flex-1 text-xs border-0 focus:outline-none text-gray-800 placeholder-gray-300 bg-transparent"
                />
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 hidden sm:inline">{meta.label}</span>
                {field.visibleWhen && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200">If</span>}
                {field.locked && <Lock className="w-3 h-3 text-gray-400" />}
                {!NON_REQUIRABLE.has(field.type) && (
                  <button
                    type="button"
                    onClick={() => patch(field.id, { required: !field.required })}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${field.required ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-gray-100 text-gray-400 border border-transparent'}`}
                  >
                    {field.required ? 'Required' : 'Optional'}
                  </button>
                )}
                <button type="button" onClick={() => setExpandedId(isExpanded ? null : field.id)} className="p-1 text-gray-400 hover:text-gray-600">
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                <button type="button" onClick={() => removeField(field.id)} className="p-1 text-gray-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
              </div>

              {isExpanded && (
                <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50">
                  {/* Placeholder + help */}
                  {!isDisplayOnly && field.type !== 'CALCULATED' && field.type !== 'LOOKUP' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Placeholder</label>
                        <input type="text" value={field.placeholder ?? ''} onChange={(e) => patch(field.id, { placeholder: e.target.value })}
                          className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Help text</label>
                        <input type="text" value={field.helpText ?? ''} onChange={(e) => patch(field.id, { helpText: e.target.value })}
                          className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                      </div>
                    </div>
                  )}
                  {(isDisplayOnly || field.type === 'CALCULATED' || field.type === 'LOOKUP') && field.type !== 'DATA_DISPLAY' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Help text</label>
                      <input type="text" value={field.helpText ?? ''} onChange={(e) => patch(field.id, { helpText: e.target.value })}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                    </div>
                  )}

                  {/* DATA_DISPLAY key */}
                  {field.type === 'DATA_DISPLAY' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Excel column key</label>
                      <input type="text" value={field.dataDisplayKey ?? ''} onChange={(e) => patch(field.id, { dataDisplayKey: e.target.value })}
                        placeholder="e.g. last_month_sales" className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                    </div>
                  )}

                  {/* Choice options */}
                  {CHOICE_TYPES.has(field.type) && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Options</label>
                      <div className="space-y-1.5">
                        {(field.options ?? []).map((opt, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <input type="text" value={opt} onChange={(e) => setOption(field.id, oi, e.target.value)}
                              onBlur={(e) => { const t = e.target.value.trim(); if (t !== e.target.value) setOption(field.id, oi, t); }}
                              placeholder={`Option ${oi + 1}`}
                              className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                            <button type="button" onClick={() => removeOption(field.id, oi)} disabled={(field.options?.length ?? 0) <= 1}
                              className="text-gray-300 hover:text-red-500 disabled:opacity-20"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        ))}
                        <button type="button" onClick={() => addOption(field.id)} className="text-xs text-[var(--brand-primary)] flex items-center gap-1 hover:text-green-700"><Plus className="w-3 h-3" /> Add option</button>
                      </div>
                    </div>
                  )}

                  {/* CALCULATED formula */}
                  {field.type === 'CALCULATED' && (
                    <div className="space-y-2">
                      <label className="block text-[10px] text-gray-500">Formula (a op b · references as &#123;fieldId&#125;)</label>
                      <div className="flex gap-2">
                        <input type="text" value={field.formula ?? ''} onChange={(e) => patch(field.id, { formula: e.target.value })}
                          placeholder="e.g. {fieldId} * 0.05" className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 font-mono" />
                        {numericFields.length > 0 && (
                          <select defaultValue="" onChange={(e) => { if (e.target.value) { patch(field.id, { formula: (field.formula ?? '') + `{${e.target.value}}` }); e.target.value = ''; } }}
                            className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600">
                            <option value="">Insert ▾</option>
                            {numericFields.map((f) => <option key={f.id} value={f.id}>{f.label || '(Untitled)'}</option>)}
                          </select>
                        )}
                      </div>
                      {/* Live sample evaluation — every referenced field set to 1 (author-time sanity check). */}
                      {(field.formula ?? '').trim() && (() => {
                        const refs = Array.from((field.formula ?? '').matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
                        const sample: Record<string, unknown> = {};
                        refs.forEach((r) => { sample[r] = 1; });
                        const result = evaluateFormula(field.formula ?? '', sample);
                        return result === null ? (
                          <p className="text-[10px] text-amber-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> formula error</p>
                        ) : (
                          <p className="text-[10px] text-orange-600">= {result} <span className="text-gray-400">(sample: each input = 1)</span></p>
                        );
                      })()}
                    </div>
                  )}

                  {/* LOOKUP source + map */}
                  {field.type === 'LOOKUP' && (() => {
                    const src = dropdownFields.find((f) => f.id === field.lookupSourceFieldId);
                    return (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[10px] text-gray-500 mb-1">Source dropdown</label>
                          <select value={field.lookupSourceFieldId ?? ''} onChange={(e) => patch(field.id, { lookupSourceFieldId: e.target.value || undefined })}
                            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">
                            <option value="">Select a dropdown field…</option>
                            {dropdownFields.map((f) => <option key={f.id} value={f.id}>{f.label || '(Untitled)'}</option>)}
                          </select>
                          {dropdownFields.length === 0 && <p className="text-[10px] text-amber-500 mt-1">Add a Dropdown field first.</p>}
                        </div>
                        {src && (
                          <div className="space-y-1.5">
                            <label className="block text-[10px] text-gray-500">Map each option → shown value</label>
                            {(src.options ?? []).filter((o) => o.trim()).map((opt) => (
                              <div key={opt} className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-600 w-24 truncate">{opt}</span>
                                <ChevronRight className="w-3 h-3 text-gray-300" />
                                <input type="text" value={field.lookupMap?.[opt] ?? ''} onChange={(e) => patch(field.id, { lookupMap: { ...(field.lookupMap ?? {}), [opt]: e.target.value } })}
                                  placeholder="mapped value" className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* PHONE_OTP otpRequired */}
                  {field.type === 'PHONE_OTP' && (
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-gray-600">
                      <input type="checkbox" checked={field.otpRequired ?? false} onChange={(e) => patch(field.id, { otpRequired: e.target.checked })}
                        className="w-3.5 h-3.5 accent-[var(--brand-primary)]" />
                      Require OTP verification of this number before submit
                    </label>
                  )}

                  {/* GPS captureTrigger */}
                  {field.type === 'GPS_POINT' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Capture trigger</label>
                      <select value={field.captureTrigger ?? 'MANUAL'} onChange={(e) => patch(field.id, { captureTrigger: e.target.value as GpsCaptureTrigger })}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">
                        {GPS_CAPTURE_TRIGGERS.map((t) => (
                          <option key={t} value={t}>{t === 'ON_SUBMIT' ? 'Automatically on submit' : t === 'ON_PHOTO' ? 'Bound to a photo' : 'Manual button'}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* GPS accuracy cap (D15) — reject fixes reporting worse accuracy than this */}
                  {field.type === 'GPS_POINT' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Max accuracy (metres)</label>
                      <input type="number" min="1" value={field.gpsMaxAccuracy ?? ''}
                        onChange={(e) => { const n = Number(e.target.value); patch(field.id, { gpsMaxAccuracy: n > 0 ? n : undefined }); }}
                        placeholder="blank = no cap" className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                      <p className="text-[9px] text-gray-400 mt-0.5">Reject a location fix whose reported accuracy is worse than this. Leave blank for no cap.</p>
                    </div>
                  )}

                  {/* CAMERA note (D14) */}
                  {field.type === 'CAMERA' && (
                    <div className="flex items-start gap-2 bg-pink-50 border border-pink-100 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-pink-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-pink-600">Opens the rear camera on field phones. GPS + a server-side watermark (time, geo, outlet code) are applied on capture.</p>
                    </div>
                  )}

                  {/* Conditional visibility + required */}
                  <ConditionEditor title="Show only when…" clause={field.visibleWhen} otherFields={otherFields} allFields={fields}
                    onChange={(c) => patch(field.id, { visibleWhen: c })} />
                  {!NON_REQUIRABLE.has(field.type) && !field.required && (
                    <ConditionEditor title="Required only when…" clause={field.requiredWhen} otherFields={otherFields} allFields={fields}
                      onChange={(c) => patch(field.id, { requiredWhen: c })} />
                  )}

                  {/* Prefill (Mode B) — value fields only. Dual-source picker (H1): an Excel roster
                      column and/or a matched-outlet field; the lock applies when either is bound. */}
                  {showPrefill && PREFILLABLE_FIELD_TYPES.has(field.type) && (() => {
                    const { excelColumns, outletFields } = prefillSources;
                    const columnMissing = !!field.prefillKey && !excelColumns.includes(field.prefillKey);
                    const hasBinding = !!field.prefillKey || !!field.outletField;
                    return (
                      <div className="pt-1 border-t border-gray-100 space-y-2">
                        <div>
                          <label className="block text-[10px] text-gray-500 mb-1">Prefill from Excel column</label>
                          <select value={field.prefillKey ?? ''} onChange={(e) => patch(field.id, { prefillKey: e.target.value || undefined })}
                            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">
                            <option value="">— none —</option>
                            {columnMissing && <option value={field.prefillKey}>{field.prefillKey}</option>}
                            {excelColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                          {excelColumns.length === 0 && (
                            <p className="text-[10px] text-gray-400 mt-1">Upload a roster to list its columns.</p>
                          )}
                          {columnMissing && (
                            <p className="text-[10px] text-amber-500 mt-1">column not in current roster</p>
                          )}
                        </div>
                        <div>
                          <label className="block text-[10px] text-gray-500 mb-1">Prefill from Outlet field (matched loyalty outlets)</label>
                          <select value={field.outletField ?? ''} onChange={(e) => patch(field.id, { outletField: e.target.value || undefined })}
                            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">
                            <option value="">— none —</option>
                            {outletFields.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                        </div>
                        {hasBinding && (
                          <div className="space-y-1.5">
                            <label className="flex items-start gap-2 cursor-pointer text-[11px] text-gray-600">
                              <input type="radio" name={`prefill-lock-${field.id}`} checked={!field.locked} onChange={() => patch(field.id, { locked: false })}
                                className="w-3.5 h-3.5 accent-[var(--brand-primary)] mt-0.5" />
                              <span>Editable — prefilled, the filler can change it</span>
                            </label>
                            <label className="flex items-start gap-2 cursor-pointer text-[11px] text-gray-600">
                              <input type="radio" name={`prefill-lock-${field.id}`} checked={!!field.locked} onChange={() => patch(field.id, { locked: true })}
                                className="w-3.5 h-3.5 accent-[var(--brand-primary)] mt-0.5" />
                              <span>Locked — value comes from the source, the filler cannot change it</span>
                            </label>
                            {field.type === 'PHONE_OTP' && (
                              <p className="text-[10px] text-gray-400 pl-6">
                                Locked = the OTP is sent to the Excel number and can&apos;t be changed (except for KYC-approved matched outlets, which always use the owner&apos;s on-file number).
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}

        {/* Add-field picker */}
        {showPicker ? (
          <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-700">Choose field type</p>
              <button type="button" onClick={() => setShowPicker(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
            {GROUPS.map((g) => (
              <div key={g}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{g}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FIELD_META.filter((m) => m.group === g).map(({ type, label, icon, desc }) => (
                    <button key={type} type="button" onClick={() => addField(type)}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-gray-200 hover:border-[var(--brand-primary)] hover:bg-green-50 transition-all text-center group">
                      <div className="p-2 rounded-lg bg-gray-100 text-gray-600 group-hover:scale-110 transition-transform">{icon}</div>
                      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
                      <span className="text-[10px] text-gray-400 leading-tight">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => setShowPicker(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-[var(--brand-primary)] font-medium hover:border-[var(--brand-primary)] hover:bg-green-50 transition-all">
            <Plus className="w-4 h-4" /> Add field
          </button>
        )}
      </div>

      {/* Mobile preview */}
      <div className="hidden lg:block w-56 flex-shrink-0">
        <div className="sticky top-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-gray-500 flex items-center gap-1"><Smartphone className="w-3.5 h-3.5" /> Preview</p>
            <button type="button" onClick={() => setShowPreview((p) => !p)} className="text-[10px] text-gray-400 hover:text-gray-600">{showPreview ? 'Hide' : 'Show'}</button>
          </div>
          {showPreview && (
            <div className="border-2 border-gray-300 rounded-2xl p-3 bg-white shadow-sm relative" style={{ minHeight: 300 }}>
              <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-3" />
              {fields.length === 0 ? (
                <div className="text-center py-8"><p className="text-[10px] text-gray-300">Fields appear here</p></div>
              ) : (
                <div className="max-h-[28rem] overflow-y-auto pr-1">
                  {fields.map((f) => <PreviewField key={f.id} field={f} />)}
                  <button className="w-full mt-2 py-2 bg-[var(--brand-primary)] text-white text-[11px] font-semibold rounded-lg">Submit</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SchemeFormBuilder;
