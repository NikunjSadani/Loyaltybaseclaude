'use client';

/**
 * EnrollmentFormBuilder
 *
 * Lets the admin define the custom fields that sales employees (and
 * self-enrolling outlet owners) fill in when enrolling an outlet for
 * a campaign.
 *
 * Features:
 *  - Add / remove fields
 *  - ▲ ▼ reorder (no external DnD library)
 *  - Per-field: label, required toggle, placeholder, help text
 *  - Type-specific options (DROPDOWN option list, IMAGE max-count)
 *  - Auto-fill from Excel toggle (only relevant when SPECIFIC targeting)
 *  - Live mobile-frame preview (right panel, collapsible)
 *  - GPS always captured on photo (badge, not configurable)
 *  - Configurable "capture GPS on form submission" toggle
 *  - OTP required toggle
 */

import { useState } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Type,
  Hash,
  List,
  Calendar,
  FileText,
  Camera,
  MapPin,
  Smartphone,
  Info,
  AlertCircle,
  QrCode,
  Eye,
  Users,
  UserCheck,
  UserX,
} from 'lucide-react';
import {
  reorderFields,
  validateEnrollmentFormConfig,
  type FormField,
  type FormFieldType,
  type FieldAudience,
  type EnrollmentFormConfig,
} from '@/lib/campaign';

// ── Field type metadata ───────────────────────────────────────────────────────

const FIELD_TYPES: { type: FormFieldType; label: string; icon: React.ReactNode; desc: string }[] = [
  { type: 'TEXT',         label: 'Text',          icon: <Type className="w-4 h-4" />,     desc: 'Single-line text input' },
  { type: 'NUMBER',       label: 'Number',         icon: <Hash className="w-4 h-4" />,     desc: 'Numeric value' },
  { type: 'DROPDOWN',     label: 'Dropdown',       icon: <List className="w-4 h-4" />,     desc: 'Select from a list' },
  { type: 'DATE',         label: 'Date',           icon: <Calendar className="w-4 h-4" />, desc: 'Date picker' },
  { type: 'DOCUMENT',     label: 'Document',       icon: <FileText className="w-4 h-4" />, desc: 'File / PDF upload' },
  { type: 'IMAGE',        label: 'Photo Upload',   icon: <Camera className="w-4 h-4" />,   desc: 'Gallery image picker + GPS tag' },
  { type: 'CAMERA',       label: 'Camera Capture', icon: <Camera className="w-4 h-4" />,   desc: 'Live camera → still + GPS tag' },
  { type: 'GPS_POINT',    label: 'GPS Location',   icon: <MapPin className="w-4 h-4" />,   desc: 'Explicit lat/lng pin drop' },
  { type: 'UPI_QR_SCAN',  label: 'UPI QR Scan',    icon: <QrCode className="w-4 h-4" />,   desc: 'Scan QR code → extract UPI ID' },
  { type: 'DATA_DISPLAY', label: 'Data Display',   icon: <Eye className="w-4 h-4" />,      desc: 'Read-only: shows Excel data point' },
];

const TYPE_BG: Record<FormFieldType, string> = {
  TEXT:         'bg-blue-50 text-blue-600',
  NUMBER:       'bg-purple-50 text-purple-600',
  DROPDOWN:     'bg-amber-50 text-amber-600',
  DATE:         'bg-cyan-50 text-cyan-600',
  DOCUMENT:     'bg-gray-100 text-gray-600',
  IMAGE:        'bg-pink-50 text-pink-600',
  CAMERA:       'bg-rose-50 text-rose-600',
  GPS_POINT:    'bg-green-50 text-green-600',
  UPI_QR_SCAN:  'bg-indigo-50 text-indigo-600',
  DATA_DISPLAY: 'bg-slate-100 text-slate-600',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function defaultField(type: FormFieldType, order: number): FormField {
  return {
    id: uid(),
    type,
    label: '',
    required: false,
    placeholder: '',
    helpText: '',
    options: type === 'DROPDOWN' ? [''] : undefined,
    autoFillFromExcel: false,
    autoFillEditable: false,
    order,
  };
}

// ── Mobile preview ────────────────────────────────────────────────────────────

function MobilePreviewField({ field }: { field: FormField }) {
  const labelText = field.label || <span className="text-gray-300 italic">Untitled field</span>;
  const req = field.required
    ? <span className="text-red-500 ml-0.5">*</span>
    : null;

  return (
    <div className="mb-3">
      <p className="text-[11px] font-semibold text-gray-700 mb-1">{labelText}{req}</p>
      {field.type === 'TEXT' && (
        <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400">
          {field.placeholder || 'Enter text…'}
        </div>
      )}
      {field.type === 'NUMBER' && (
        <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400">
          {field.placeholder || '0'}
        </div>
      )}
      {field.type === 'DATE' && (
        <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400">
          DD / MM / YYYY
        </div>
      )}
      {field.type === 'DROPDOWN' && (
        <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-[11px] text-gray-400 flex items-center justify-between">
          <span>{field.options?.[0] || 'Select…'}</span>
          <ChevronRight className="w-3 h-3 rotate-90" />
        </div>
      )}
      {field.type === 'DOCUMENT' && (
        <div className="border-2 border-dashed border-gray-200 rounded-lg p-3 text-center">
          <FileText className="w-5 h-5 text-gray-300 mx-auto mb-1" />
          <p className="text-[10px] text-gray-400">Tap to upload document</p>
        </div>
      )}
      {field.type === 'IMAGE' && (
        <div className="border-2 border-dashed border-pink-200 rounded-lg p-3 text-center bg-pink-50/40">
          <Camera className="w-5 h-5 text-pink-300 mx-auto mb-1" />
          <p className="text-[10px] text-pink-400">Tap to take photo</p>
          <p className="text-[9px] text-gray-400 mt-0.5">📍 GPS auto-captured</p>
        </div>
      )}
      {field.type === 'GPS_POINT' && (
        <div className="border border-green-200 rounded-lg p-3 text-center bg-green-50">
          <MapPin className="w-5 h-5 text-green-500 mx-auto mb-1" />
          <p className="text-[10px] text-green-600">Tap to capture location</p>
        </div>
      )}
      {field.type === 'CAMERA' && (
        <div className="border-2 border-dashed border-rose-200 rounded-lg p-3 text-center bg-rose-50/40">
          <Camera className="w-5 h-5 text-rose-400 mx-auto mb-1" />
          <p className="text-[10px] text-rose-500">Tap to open camera</p>
          <p className="text-[9px] text-gray-400 mt-0.5">📍 GPS auto-captured</p>
        </div>
      )}
      {field.type === 'UPI_QR_SCAN' && (
        <div className="space-y-1.5">
          <div className="border border-gray-200 rounded-lg px-2.5 py-2 bg-gray-50 text-[11px] text-gray-400">
            9876543210@paytm
          </div>
          <div className="flex items-center gap-1 text-[10px] text-indigo-600 font-medium">
            <QrCode className="w-3 h-3" /> Scan QR Code
          </div>
        </div>
      )}
      {field.type === 'DATA_DISPLAY' && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg">
          <Eye className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-[11px] text-slate-600 font-medium">
            {field.dataDisplayKey ? `[${field.dataDisplayKey}]` : '[ Excel value ]'}
          </span>
        </div>
      )}
      {field.helpText && (
        <p className="text-[10px] text-gray-400 mt-0.5">{field.helpText}</p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  config: EnrollmentFormConfig;
  onChange: (config: EnrollmentFormConfig) => void;
  /** Show auto-fill toggles only when outlet targeting is SPECIFIC */
  showAutoFill?: boolean;
}

export function EnrollmentFormBuilder({ config, onChange, showAutoFill = false }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const setFields = (fields: FormField[]) =>
    onChange({ ...config, fields });

  const setField = (id: string, patch: Partial<FormField>) =>
    setFields(config.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addField = (type: FormFieldType) => {
    const next = defaultField(type, config.fields.length);
    setFields([...config.fields, next]);
    setExpandedId(next.id);
    setShowTypePicker(false);
  };

  const removeField = (id: string) => {
    setFields(config.fields.filter((f) => f.id !== id).map((f, i) => ({ ...f, order: i })));
    if (expandedId === id) setExpandedId(null);
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    setFields(reorderFields(config.fields, idx, idx - 1));
  };

  const moveDown = (idx: number) => {
    if (idx === config.fields.length - 1) return;
    setFields(reorderFields(config.fields, idx, idx + 1));
  };

  const setOption = (fieldId: string, optIdx: number, value: string) => {
    const field = config.fields.find((f) => f.id === fieldId);
    if (!field?.options) return;
    const opts = [...field.options];
    opts[optIdx] = value;
    setField(fieldId, { options: opts });
  };

  const addOption = (fieldId: string) => {
    const field = config.fields.find((f) => f.id === fieldId);
    setField(fieldId, { options: [...(field?.options ?? []), ''] });
  };

  const removeOption = (fieldId: string, optIdx: number) => {
    const field = config.fields.find((f) => f.id === fieldId);
    if (!field?.options) return;
    setField(fieldId, { options: field.options.filter((_, i) => i !== optIdx) });
  };

  const validationErrors = validateEnrollmentFormConfig(config);

  return (
    <div className="flex gap-4">
      {/* ── Builder panel ── */}
      <div className="flex-1 space-y-3 min-w-0">

        {/* Global settings */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-700">Form Settings</p>

          {/* Capture GPS on submit */}
          <label className="flex items-start gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => onChange({ ...config, captureGpsOnSubmit: !config.captureGpsOnSubmit })}
              className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${config.captureGpsOnSubmit ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${config.captureGpsOnSubmit ? 'left-4' : 'left-0.5'}`} />
            </button>
            <div>
              <p className="text-xs font-medium text-gray-800">Capture GPS on form submission</p>
              <p className="text-[11px] text-gray-500">Device location is recorded when the employee submits the form</p>
            </div>
          </label>

          {/* GPS on photo — always on, not configurable */}
          <div className="flex items-start gap-3">
            <div className="w-9 h-5 rounded-full bg-pink-400 flex-shrink-0 mt-0.5 relative">
              <div className="w-4 h-4 bg-white rounded-full absolute top-0.5 left-4 shadow" />
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600">GPS captured on every photo <span className="text-[10px] text-pink-600 bg-pink-50 px-1.5 py-0.5 rounded-full ml-1">Always on</span></p>
              <p className="text-[11px] text-gray-400">Location is automatically tagged to each image at capture time</p>
            </div>
          </div>

          {/* OTP required */}
          <label className="flex items-start gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => onChange({ ...config, requireOtp: !config.requireOtp })}
              className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${config.requireOtp ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${config.requireOtp ? 'left-4' : 'left-0.5'}`} />
            </button>
            <div>
              <p className="text-xs font-medium text-gray-800">Require OTP verification</p>
              <p className="text-[11px] text-gray-500">OTP sent to outlet's registered phone via MSG91 before submission</p>
            </div>
          </label>
        </div>

        {/* Validation errors */}
        {validationErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
            {validationErrors.map((e, i) => (
              <p key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {e}
              </p>
            ))}
          </div>
        )}

        {/* Field list */}
        {config.fields.length === 0 && (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-6 text-center text-gray-400">
            <Type className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No fields yet — add your first field below</p>
          </div>
        )}

        {config.fields.map((field, idx) => {
          const meta = FIELD_TYPES.find((t) => t.type === field.type)!;
          const isExpanded = expandedId === field.id;

          return (
            <div key={field.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* Row header */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                {/* Reorder */}
                <div className="flex flex-col gap-0.5">
                  <button onClick={() => moveUp(idx)} disabled={idx === 0}
                    className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20 transition-colors">
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => moveDown(idx)} disabled={idx === config.fields.length - 1}
                    className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20 transition-colors">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Type icon */}
                <div className={`p-1.5 rounded-lg flex-shrink-0 ${TYPE_BG[field.type]}`}>
                  {meta.icon}
                </div>

                {/* Label input (inline) */}
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => setField(field.id, { label: e.target.value })}
                  placeholder={`${meta.label} label…`}
                  className="flex-1 text-xs border-0 focus:outline-none text-gray-800 placeholder-gray-300 bg-transparent"
                />

                {/* Required badge */}
                <button
                  type="button"
                  onClick={() => setField(field.id, { required: !field.required })}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors flex-shrink-0 ${
                    field.required
                      ? 'bg-red-50 text-red-600 border border-red-200'
                      : 'bg-gray-100 text-gray-400 border border-transparent'
                  }`}
                >
                  {field.required ? 'Required' : 'Optional'}
                </button>

                {/* Expand toggle */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : field.id)}
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {/* Delete */}
                <button
                  type="button"
                  onClick={() => removeField(field.id)}
                  className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Expanded options */}
              {isExpanded && (
                <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50">
                  {/* Audience picker */}
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1.5">Visible to</label>
                    <div className="flex gap-2">
                      {([
                        { value: 'ALL',                 label: 'Everyone',      icon: <Users className="w-3 h-3" /> },
                        { value: 'LOYALTY_MEMBERS',     label: 'Loyalty only',  icon: <UserCheck className="w-3 h-3" /> },
                        { value: 'NON_LOYALTY_MEMBERS', label: 'Non-loyalty',   icon: <UserX className="w-3 h-3" /> },
                      ] as { value: FieldAudience; label: string; icon: React.ReactNode }[]).map(({ value, label, icon }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setField(field.id, { audience: value })}
                          className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                            (field.audience ?? 'ALL') === value
                              ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {icon} {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Placeholder + help text (not shown for DATA_DISPLAY) */}
                  {field.type !== 'DATA_DISPLAY' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Placeholder text</label>
                      <input
                        type="text"
                        value={field.placeholder ?? ''}
                        onChange={(e) => setField(field.id, { placeholder: e.target.value })}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Help text</label>
                      <input
                        type="text"
                        value={field.helpText ?? ''}
                        onChange={(e) => setField(field.id, { helpText: e.target.value })}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                      />
                    </div>
                  </div>
                  )}

                  {/* DATA_DISPLAY key */}
                  {field.type === 'DATA_DISPLAY' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Excel column key</label>
                      <input
                        type="text"
                        value={(field as FormField & { dataDisplayKey?: string }).dataDisplayKey ?? ''}
                        onChange={(e) => setField(field.id, { dataDisplayKey: e.target.value } as Partial<FormField>)}
                        placeholder="e.g. last_month_sales"
                        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                      />
                      <p className="text-[10px] text-gray-400 mt-0.5">Matches the column name from the outlet Excel upload</p>
                    </div>
                  )}

                  {/* DROPDOWN options */}
                  {field.type === 'DROPDOWN' && (
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Options</label>
                      <div className="space-y-1.5">
                        {(field.options ?? []).map((opt, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={opt}
                              onChange={(e) => setOption(field.id, oi, e.target.value)}
                              placeholder={`Option ${oi + 1}`}
                              className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                            />
                            <button
                              type="button"
                              onClick={() => removeOption(field.id, oi)}
                              disabled={(field.options?.length ?? 0) <= 1}
                              className="text-gray-300 hover:text-red-500 disabled:opacity-20 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => addOption(field.id)}
                          className="text-xs text-[var(--brand-primary)] flex items-center gap-1 hover:text-green-700"
                        >
                          <Plus className="w-3 h-3" /> Add option
                        </button>
                      </div>
                    </div>
                  )}

                  {/* IMAGE / CAMERA — GPS note */}
                  {(field.type === 'IMAGE' || field.type === 'CAMERA') && (
                    <div className="flex items-start gap-2 bg-pink-50 border border-pink-100 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-pink-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-pink-600">
                        GPS coordinates are automatically captured at the moment each photo is taken. This cannot be disabled.
                      </p>
                    </div>
                  )}

                  {/* UPI_QR_SCAN — info note */}
                  {field.type === 'UPI_QR_SCAN' && (
                    <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-indigo-600">
                        Opens the device camera to scan a UPI QR code. Extracted UPI ID is auto-filled into the field. Partner can also type manually.
                      </p>
                    </div>
                  )}

                  {/* DATA_DISPLAY — info note */}
                  {field.type === 'DATA_DISPLAY' && (
                    <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-slate-600">
                        Read-only field — displays a data point from the outlet targeting Excel. The partner cannot edit this value.
                      </p>
                    </div>
                  )}

                  {/* Auto-fill from Excel */}
                  {showAutoFill && (
                    <div className="flex items-center gap-3 pt-1 border-t border-gray-100">
                      <label className="flex items-center gap-2 cursor-pointer flex-1">
                        <input
                          type="checkbox"
                          checked={field.autoFillFromExcel}
                          onChange={(e) => setField(field.id, { autoFillFromExcel: e.target.checked })}
                          className="w-3.5 h-3.5 accent-[var(--brand-primary)]"
                        />
                        <span className="text-[11px] text-gray-600">Pre-fill from Excel column</span>
                      </label>
                      {field.autoFillFromExcel && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={field.autoFillEditable}
                            onChange={(e) => setField(field.id, { autoFillEditable: e.target.checked })}
                            className="w-3.5 h-3.5 accent-[var(--brand-primary)]"
                          />
                          <span className="text-[11px] text-gray-600">Allow editing</span>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Add field — type picker */}
        {showTypePicker ? (
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-700 mb-2">Choose field type</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {FIELD_TYPES.map(({ type, label, icon, desc }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addField(type)}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-gray-200 hover:border-[var(--brand-primary)] hover:bg-green-50 transition-all text-center group"
                >
                  <div className={`p-2 rounded-lg ${TYPE_BG[type]} group-hover:scale-110 transition-transform`}>
                    {icon}
                  </div>
                  <span className="text-[11px] font-semibold text-gray-700">{label}</span>
                  <span className="text-[10px] text-gray-400 leading-tight">{desc}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowTypePicker(false)}
              className="mt-2 text-xs text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowTypePicker(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-[var(--brand-primary)] font-medium hover:border-[var(--brand-primary)] hover:bg-green-50 transition-all"
          >
            <Plus className="w-4 h-4" />
            Add field
          </button>
        )}
      </div>

      {/* ── Mobile preview panel ── */}
      <div className="hidden lg:block w-52 flex-shrink-0">
        <div className="sticky top-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-gray-500 flex items-center gap-1">
              <Smartphone className="w-3.5 h-3.5" /> Preview
            </p>
            <button
              type="button"
              onClick={() => setShowPreview((p) => !p)}
              className="text-[10px] text-gray-400 hover:text-gray-600"
            >
              {showPreview ? 'Hide' : 'Show'}
            </button>
          </div>
          {showPreview && (
            <div className="border-2 border-gray-300 rounded-2xl p-3 bg-white shadow-sm overflow-hidden relative" style={{ minHeight: 300 }}>
              {/* Phone notch */}
              <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-3" />
              {config.fields.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-[10px] text-gray-300">Fields will appear here</p>
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto pr-1">
                  {config.fields.map((f) => (
                    <MobilePreviewField key={f.id} field={f} />
                  ))}
                  {config.requireOtp && (
                    <div className="mt-2 border border-amber-200 rounded-lg px-2 py-2 bg-amber-50 text-center">
                      <p className="text-[10px] text-amber-600 font-medium">OTP Verification</p>
                      <p className="text-[9px] text-amber-500">Sent to outlet's phone</p>
                    </div>
                  )}
                  <button className="w-full mt-3 py-2 bg-[var(--brand-primary)] text-white text-[11px] font-semibold rounded-lg">
                    Submit
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
