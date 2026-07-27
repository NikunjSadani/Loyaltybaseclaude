'use client';

/**
 * VisibilityFormBuilder — GIFSY_ADMIN capture-form authoring for the Visibility
 * (POSM) feature (VISIBILITY-POSM-DESIGN.md D9/D16). Authors the shared
 * `VisibilityFormSchema` (from `@/lib/visibility-types`) — the EXACT contract the
 * shared capture renderer and the backend enforce.
 *
 * This is a deliberately TRIMMED clone of the Scheme SchemeFormBuilder: only the
 * capture-instrument field palette (TEXT / TEXTAREA / NUMBER / DATE / DROPDOWN /
 * MULTI_SELECT / TOGGLE / CAMERA / GPS_POINT — NO reward / lookup / calculation /
 * signature / document / OTP surface). CAMERA fields gain a per-field instruction
 * text + an optional reference/sample image (uploaded via visibilityApi.uploadMedia,
 * stored as a GCS key, previewed via mediaViewUrl).
 *
 * Self-contained: loads the current form on mount and persists via
 * visibilityApi.upsertForm (versioned). It does NOT import the scheme feature.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Type, Hash, List,
  Calendar, Camera, MapPin, Info, AlertCircle, CheckSquare, ToggleRight,
  Smartphone, AlignLeft, CheckCircle, Loader2, Save, ImagePlus, X,
} from 'lucide-react';
import { visibilityApi, mediaViewUrl } from '@/lib/visibility';
import {
  GPS_CAPTURE_TRIGGERS,
  formCapturesLocation,
  type VisibilityFormFieldType,
  type VisibilityFormField,
  type VisibilityFormSchema,
  type GpsCaptureTrigger,
  type VisibleWhen,
  type VisibleWhenOp,
} from '@/lib/visibility-types';

const EMPTY_FORM: VisibilityFormSchema = { captureGpsOnSubmit: false, fields: [] };

// ── Field-type metadata (TRIMMED palette) ────────────────────────────────────

interface FieldMeta {
  type: VisibilityFormFieldType;
  label: string;
  icon: React.ReactNode;
  desc: string;
  group: 'Input' | 'Choice' | 'Capture';
}

const FIELD_META: FieldMeta[] = [
  { type: 'TEXT',         label: 'Text',         icon: <Type className="w-4 h-4" />,        desc: 'Single-line text',     group: 'Input' },
  { type: 'TEXTAREA',     label: 'Paragraph',    icon: <AlignLeft className="w-4 h-4" />,   desc: 'Multi-line text',      group: 'Input' },
  { type: 'NUMBER',       label: 'Number',       icon: <Hash className="w-4 h-4" />,        desc: 'Numeric value',        group: 'Input' },
  { type: 'DATE',         label: 'Date',         icon: <Calendar className="w-4 h-4" />,    desc: 'Date picker',          group: 'Input' },
  { type: 'DROPDOWN',     label: 'Dropdown',     icon: <List className="w-4 h-4" />,        desc: 'Single select',        group: 'Choice' },
  { type: 'MULTI_SELECT', label: 'Multi-select', icon: <CheckSquare className="w-4 h-4" />, desc: 'Choose many',          group: 'Choice' },
  { type: 'TOGGLE',       label: 'Yes / No',     icon: <ToggleRight className="w-4 h-4" />, desc: 'Boolean toggle',       group: 'Choice' },
  { type: 'CAMERA',       label: 'Camera',       icon: <Camera className="w-4 h-4" />,      desc: 'Rear-camera capture',  group: 'Capture' },
  { type: 'GPS_POINT',    label: 'GPS Location', icon: <MapPin className="w-4 h-4" />,      desc: 'Capture coordinates',  group: 'Capture' },
];

const META_BY_TYPE: Record<VisibilityFormFieldType, FieldMeta> = FIELD_META.reduce(
  (acc, m) => { acc[m.type] = m; return acc; },
  {} as Record<VisibilityFormFieldType, FieldMeta>,
);

const GROUPS: FieldMeta['group'][] = ['Input', 'Choice', 'Capture'];

const CHOICE_TYPES: ReadonlySet<VisibilityFormFieldType> = new Set<VisibilityFormFieldType>(['DROPDOWN', 'MULTI_SELECT']);

function uid() { return Math.random().toString(36).slice(2, 9); }

function defaultField(type: VisibilityFormFieldType, order: number): VisibilityFormField {
  return {
    id: uid(),
    type,
    label: '',
    required: false,
    placeholder: '',
    helpText: '',
    options: CHOICE_TYPES.has(type) ? [''] : undefined,
    captureTrigger: type === 'GPS_POINT' ? 'MANUAL' : undefined,
    noGallery: type === 'CAMERA' ? true : undefined,
    instruction: type === 'CAMERA' ? '' : undefined,
    order,
  };
}

// ── Client-side validation (mirrors the backend validateFormSchema subset) ────

export function validateVisibilityFormSchema(schema: VisibilityFormSchema): string[] {
  const errors: string[] = [];
  const fields = schema.fields ?? [];
  if (fields.length === 0) errors.push('Add at least one field.');
  const ids = new Set(fields.map((f) => f.id));

  fields.forEach((f, i) => {
    const pos = `Field ${i + 1}`;
    const name = f.label || META_BY_TYPE[f.type]?.label || f.type;
    if (!f.label.trim()) errors.push(`${pos}: label cannot be empty.`);
    if (CHOICE_TYPES.has(f.type)) {
      const opts = (f.options ?? []).filter((o) => o.trim());
      if (opts.length === 0) errors.push(`${pos} ("${name}"): add at least one option.`);
    }
    for (const [key, clause] of [['visibleWhen', f.visibleWhen], ['requiredWhen', f.requiredWhen]] as const) {
      if (!clause) continue;
      if (clause.fieldId === f.id) errors.push(`${pos} ("${name}"): ${key} cannot depend on itself.`);
      else if (!ids.has(clause.fieldId)) errors.push(`${pos} ("${name}"): ${key} references an unknown field.`);
    }
  });

  if (!fields.some((f) => f.type === 'CAMERA')) {
    errors.push('A visibility form needs at least one Camera field (the POSM photo proof).');
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
  otherFields: VisibilityFormField[];
  allFields: VisibilityFormField[];
  onChange: (c: VisibleWhen | undefined) => void;
}) {
  const enabled = !!clause;
  const dep = clause ? allFields.find((f) => f.id === clause.fieldId) : undefined;
  return (
    <div className="pt-1 border-t border-gray-100 space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={enabled}
          onChange={(e) => {
            if (!e.target.checked) onChange(undefined);
            else if (otherFields.length > 0) onChange({ fieldId: otherFields[0].id, op: 'eq', value: '' });
          }}
          className="w-3.5 h-3.5 accent-[var(--brand-primary)]" />
        <span className="text-[11px] text-gray-600 font-medium">{title}</span>
      </label>
      {enabled && clause && (
        <div className="flex flex-wrap items-center gap-2 pl-5">
          <select value={clause.fieldId} onChange={(e) => onChange({ ...clause, fieldId: e.target.value })}
            className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
            {otherFields.map((f) => <option key={f.id} value={f.id}>{f.label || '(Untitled)'}</option>)}
          </select>
          <select value={clause.op} onChange={(e) => onChange({ ...clause, op: e.target.value as VisibleWhenOp })}
            className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
            {OP_LABELS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
          {CHOICE_TYPES.has(dep?.type ?? 'TEXT') ? (
            <select value={clause.value} onChange={(e) => onChange({ ...clause, value: e.target.value })}
              className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
              <option value="">Select…</option>
              {(dep?.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input type="text" value={clause.value} onChange={(e) => onChange({ ...clause, value: e.target.value })}
              placeholder="value" className="text-[10px] border border-gray-200 rounded-lg px-2 py-1.5 w-24" />
          )}
        </div>
      )}
      {enabled && otherFields.length === 0 && (
        <p className="text-[10px] text-gray-400 pl-5">Add more fields to build a condition.</p>
      )}
    </div>
  );
}

// ── Camera sample-image uploader ──────────────────────────────────────────────

function SampleImageUploader({
  sampleImageKey, onChange,
}: { sampleImageKey: string | undefined; onChange: (key: string | undefined) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const res = await visibilityApi.uploadMedia(file);
    setUploading(false);
    if (res.success && res.data?.key) onChange(res.data.key);
    else setError('success' in res && !res.success ? res.error : 'Upload failed');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div>
      <label className="block text-[10px] text-gray-500 mb-1">Reference / sample image (optional)</label>
      {sampleImageKey ? (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mediaViewUrl(sampleImageKey)} alt="Sample" className="w-16 h-16 object-cover rounded-lg border border-gray-200 bg-gray-50" />
          <button type="button" onClick={() => onChange(undefined)}
            className="flex items-center gap-1 text-[11px] text-red-500 hover:text-red-600">
            <X className="w-3 h-3" /> Remove
          </button>
        </div>
      ) : (
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium border border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] cursor-pointer">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
          {uploading ? 'Uploading…' : 'Upload sample'}
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} aria-label="Upload sample image" />
        </label>
      )}
      {error && <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{error}</p>}
    </div>
  );
}

// ── Mobile preview cell ───────────────────────────────────────────────────────

function PreviewField({ field }: { field: VisibilityFormField }) {
  const label = field.label || <span className="text-gray-300 italic">Untitled field</span>;
  const star = field.required ? <span className="text-red-500 ml-0.5">*</span> : null;
  const box = (inner: React.ReactNode) => (
    <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400">{inner}</div>
  );
  return (
    <div className="mb-3">
      <p className="text-[11px] font-semibold text-gray-700 mb-1 flex items-center gap-1">{label}{star}</p>
      {field.type === 'TEXT' && box(field.placeholder || 'Enter text…')}
      {field.type === 'TEXTAREA' && box(field.placeholder || 'Enter details…')}
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
      {field.type === 'CAMERA' && (
        <div className="border-2 border-dashed border-pink-200 rounded-lg p-2 text-center bg-pink-50/40">
          <Camera className="w-4 h-4 text-pink-300 mx-auto" />
          <p className="text-[9px] text-pink-400">Capture photo</p>
          {field.instruction && <p className="text-[9px] text-gray-400 mt-0.5 italic">{field.instruction}</p>}
        </div>
      )}
      {field.type === 'GPS_POINT' && (
        <div className="border border-green-200 rounded-lg p-2 text-center bg-green-50"><MapPin className="w-4 h-4 text-green-500 mx-auto" /><p className="text-[9px] text-green-600">{field.captureTrigger === 'ON_SUBMIT' ? 'Auto on submit' : field.captureTrigger === 'ON_PHOTO' ? 'Tagged to photo' : 'Tap to capture'}</p></div>
      )}
      {field.helpText && <p className="text-[9px] text-gray-400 mt-0.5">{field.helpText}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function VisibilityFormBuilder() {
  const [value, setValue] = useState<VisibilityFormSchema>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Whether the tenant's geo-fence is enabled (from config) — a form with no location
  // field silently defeats it (D10), so we warn + block save while that's the case.
  const [geoFenceEnabled, setGeoFenceEnabled] = useState(false);

  const hydrate = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // Load the form AND the config (the geo-fence cross-check needs the config's flag).
    const [res, cfgRes] = await Promise.all([
      visibilityApi.getForm(),
      visibilityApi.getConfig(),
    ]);
    if (res.success) {
      const fs = res.data?.formSchema;
      setValue({
        captureGpsOnSubmit: !!fs?.captureGpsOnSubmit,
        fields: Array.isArray(fs?.fields) ? fs!.fields : [],
      });
    } else {
      setLoadError(res.error);
    }
    setGeoFenceEnabled(cfgRes.success && !!cfgRes.data?.geoFence?.enabled);
    setLoading(false);
  }, []);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const fields = value.fields;
  const setFields = (next: VisibilityFormField[]) => setValue((v) => ({ ...v, fields: next }));
  const patch = (id: string, p: Partial<VisibilityFormField>) =>
    setFields(fields.map((f) => (f.id === id ? { ...f, ...p } : f)));

  const addField = (type: VisibilityFormFieldType) => {
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

  const errors = useMemo(() => validateVisibilityFormSchema(value), [value]);
  // Geo-fence on (config) but this form produces no device location → the fence can't be
  // evaluated (D10). Warn + block save so the admin can't silently disarm it from here.
  const geoFenceNeedsGps = geoFenceEnabled && !formCapturesLocation(value);

  const save = async () => {
    setMsg(null);
    const errs = validateVisibilityFormSchema(value);
    if (errs.length > 0) { setMsg({ kind: 'err', text: 'Fix the highlighted issues before saving.' }); return; }
    if (geoFenceNeedsGps) {
      setMsg({ kind: 'err', text: 'The geo-fence is enabled for this tenant but this form records no location. Add a GPS field (or turn on "Capture GPS on submit"), or disable the geo-fence on the Config tab.' });
      return;
    }
    setSaving(true);
    const res = await visibilityApi.upsertForm({ formSchema: value });
    setSaving(false);
    if (res.success) setMsg({ kind: 'ok', text: 'Form saved (a new version was recorded).' });
    else setMsg({ kind: 'err', text: res.error });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-red-500">{loadError}</p>
        <button onClick={hydrate} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        {/* Builder panel */}
        <div className="flex-1 space-y-3 min-w-0">
          {/* Global settings */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <button type="button" aria-pressed={value.captureGpsOnSubmit} aria-label="Capture GPS on submit"
                onClick={() => setValue((v) => ({ ...v, captureGpsOnSubmit: !v.captureGpsOnSubmit }))}
                className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${value.captureGpsOnSubmit ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}>
                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${value.captureGpsOnSubmit ? 'left-4' : 'left-0.5'}`} />
              </button>
              <div>
                <p className="text-xs font-medium text-gray-800">Capture GPS on submit</p>
                <p className="text-[11px] text-gray-500">Device location is recorded on submit into a GPS field and used for the geo-fence check.</p>
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

          {/* Geo-fence cross-check (D10): fence on but no location field in this form. */}
          {geoFenceNeedsGps && (
            <div data-testid="geo-fence-no-gps-warning"
              className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-600">
                The geo-fence is <strong>enabled</strong> for this tenant, but this form records no device
                location — the fence can never be checked (every capture would silently pass). Add a
                <strong> GPS Location</strong> field, or turn on <strong>Capture GPS on submit</strong> above
                (or disable the geo-fence on the Config tab). Saving is blocked until then.
              </p>
            </div>
          )}

          {/* Field list */}
          {fields.length === 0 && (
            <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-6 text-center text-gray-400">
              <Camera className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No fields yet — add a Camera field for the POSM photo.</p>
            </div>
          )}

          {fields.map((field, idx) => {
            const meta = META_BY_TYPE[field.type];
            const isExpanded = expandedId === field.id;
            const otherFields = fields.filter((f) => f.id !== field.id);
            return (
              <div key={field.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
                    <button onClick={() => move(idx, 1)} disabled={idx === fields.length - 1} className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="p-1.5 rounded-lg flex-shrink-0 bg-gray-100 text-gray-600">{meta.icon}</div>
                  <input type="text" value={field.label} onChange={(e) => patch(field.id, { label: e.target.value })}
                    placeholder={`${meta.label} label…`}
                    className="flex-1 text-xs border-0 focus:outline-none text-gray-800 placeholder-gray-300 bg-transparent" />
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 hidden sm:inline">{meta.label}</span>
                  {field.visibleWhen && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200">If</span>}
                  <button type="button" onClick={() => patch(field.id, { required: !field.required })}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${field.required ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-gray-100 text-gray-400 border border-transparent'}`}>
                    {field.required ? 'Required' : 'Optional'}
                  </button>
                  <button type="button" onClick={() => setExpandedId(isExpanded ? null : field.id)} className="p-1 text-gray-400 hover:text-gray-600">
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  <button type="button" onClick={() => removeField(field.id)} className="p-1 text-gray-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50">
                    {/* Placeholder + help */}
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

                    {/* Choice options */}
                    {CHOICE_TYPES.has(field.type) && (
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Options</label>
                        <div className="space-y-1.5">
                          {(field.options ?? []).map((opt, oi) => (
                            <div key={oi} className="flex items-center gap-2">
                              <input type="text" value={opt} onChange={(e) => setOption(field.id, oi, e.target.value)} placeholder={`Option ${oi + 1}`}
                                className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                              <button type="button" onClick={() => removeOption(field.id, oi)} disabled={(field.options?.length ?? 0) <= 1}
                                className="text-gray-300 hover:text-red-500 disabled:opacity-20"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          ))}
                          <button type="button" onClick={() => addOption(field.id)} className="text-xs text-[var(--brand-primary)] flex items-center gap-1 hover:text-green-700"><Plus className="w-3 h-3" /> Add option</button>
                        </div>
                      </div>
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

                    {/* CAMERA: instruction + sample image + gallery toggle (D9/D16) */}
                    {field.type === 'CAMERA' && (
                      <div className="space-y-3">
                        <div>
                          <label className="block text-[10px] text-gray-500 mb-1">Instruction (what / how to shoot)</label>
                          <input type="text" value={field.instruction ?? ''} onChange={(e) => patch(field.id, { instruction: e.target.value })}
                            placeholder="e.g. Photograph the full cooler with the POSM branding visible"
                            aria-label="Camera instruction"
                            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
                        </div>
                        <SampleImageUploader sampleImageKey={field.sampleImageKey}
                          onChange={(key) => patch(field.id, { sampleImageKey: key })} />
                        <label className="flex items-center gap-2 cursor-pointer text-[11px] text-gray-600">
                          <input type="checkbox" checked={field.noGallery ?? false} onChange={(e) => patch(field.id, { noGallery: e.target.checked })}
                            className="w-3.5 h-3.5 accent-[var(--brand-primary)]" />
                          Native camera only — disable gallery upload
                        </label>
                        <div className="flex items-start gap-2 bg-pink-50 border border-pink-100 rounded-lg px-3 py-2">
                          <Info className="w-3.5 h-3.5 text-pink-400 flex-shrink-0 mt-0.5" />
                          <p className="text-[11px] text-pink-600">Opens the rear camera on field phones. Time, geo and outlet code are stored alongside the photo.</p>
                        </div>
                      </div>
                    )}

                    {/* Conditional visibility + required */}
                    <ConditionEditor title="Show only when…" clause={field.visibleWhen} otherFields={otherFields} allFields={fields}
                      onChange={(c) => patch(field.id, { visibleWhen: c })} />
                    {!field.required && (
                      <ConditionEditor title="Required only when…" clause={field.requiredWhen} otherFields={otherFields} allFields={fields}
                        onChange={(c) => patch(field.id, { requiredWhen: c })} />
                    )}
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

      {msg && (
        <p className={`text-xs flex items-center gap-1.5 ${msg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {msg.kind === 'ok' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{msg.text}
        </p>
      )}

      <div className="flex justify-end">
        <button onClick={save} disabled={saving || geoFenceNeedsGps}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save form'}
        </button>
      </div>
    </div>
  );
}

export default VisibilityFormBuilder;
