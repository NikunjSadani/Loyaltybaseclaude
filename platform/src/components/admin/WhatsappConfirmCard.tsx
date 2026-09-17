'use client';

/**
 * WhatsappConfirmCard — per-scheme "WhatsApp confirmation on enrollment submit"
 * authoring surface (scheme.metadata.whatsappConfirm).
 *
 * Controlled: the parent (SchemeManager's WhatsApp tab) owns the config + persists it
 * through the scheme create/update payload (`schemeApi.update({ whatsappConfirm })`).
 * The variable rows are ORDERED — a row's ordinal position IS the WhatsApp template
 * slot it fills ({{1}}, {{2}}, …). Field dropdowns are seeded from the scheme's SAVED
 * enrollment-form fields (the persisted form) — never the unsaved builder draft — so a
 * mapping can only ever reference a field that actually exists server-side (the backend
 * authoritatively rejects a formFieldId absent from the saved form).
 *
 * Mirrors the SchemeFormBuilder authoring style: card layout, toggle buttons, and an
 * exported pure `validateWhatsappConfirm` the parent gates its Save on (+
 * `normalizeWhatsappConfirm` to hydrate raw metadata).
 */

import { useId, useMemo } from 'react';
import {
  MessageCircle, Plus, Trash2, ChevronUp, ChevronDown, AlertCircle, Info, Phone,
} from 'lucide-react';
import {
  DEFAULT_WHATSAPP_CONFIRM,
  WHATSAPP_CONFIRM_TOKENS,
  type FormField,
  type WhatsappConfirmConfig,
  type WhatsappConfirmToken,
  type WhatsappConfirmVariable,
  type WhatsappRecipientSource,
} from '@/lib/scheme-types';

// ── Token catalog (label + what it resolves to — drives the dropdowns + the legend) ──

interface TokenMeta {
  token: WhatsappConfirmToken;
  label: string;
  /** Plain-language explanation shown in the help legend. */
  resolves: string;
}

const TOKEN_META: TokenMeta[] = [
  { token: 'OWNER_NAME',      label: 'Owner name',      resolves: "the outlet owner's name" },
  { token: 'OWNER_PHONE',     label: 'Owner phone',     resolves: "the outlet owner's phone number" },
  { token: 'OUTLET_NAME',     label: 'Outlet name',     resolves: "the outlet's name" },
  { token: 'OUTLET_CODE',     label: 'Outlet code',     resolves: "the outlet's code" },
  { token: 'SCHEME_NAME',     label: 'Scheme name',     resolves: "this scheme's name" },
  { token: 'SUBMISSION_DATE', label: 'Submission date', resolves: 'the date the form was submitted' },
  { token: 'FORM_FIELD',      label: 'Form field →',    resolves: 'the value the outlet entered for the chosen form field' },
];

// SECTION fields are structural (no captured value) — never a variable/recipient source.
const isSelectableField = (f: FormField) => f.type !== 'SECTION';
/** Phone-ish fields float to the top of the recipient picker (still lists all fields). */
const isPhoneish = (f: FormField) =>
  f.type === 'PHONE_OTP' ||
  /phone|mobile|whats\s*app|contact/i.test(`${f.label} ${f.placeholder ?? ''}`);

const fieldLabel = (f: FormField) => f.label?.trim() || '(Untitled field)';

/** Backend caps a WhatsApp template at 20 body variables ({{1}}…{{20}}) → mirror it here. */
export const MAX_WHATSAPP_VARIABLES = 20;

// ── Pure hydrate + validate (mirrors normalize/validate in SchemeFormBuilder) ─────

/**
 * Coerce raw `scheme.metadata.whatsappConfirm` (unknown JSON) into a valid config,
 * dropping anything malformed. Always returns a complete `WhatsappConfirmConfig` so the
 * controlled card never sees `undefined`. Never throws.
 */
export function normalizeWhatsappConfirm(raw: unknown): WhatsappConfirmConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WHATSAPP_CONFIRM };
  const o = raw as Record<string, unknown>;

  const rawRecipient = o.recipient && typeof o.recipient === 'object'
    ? (o.recipient as Record<string, unknown>)
    : {};
  const source: WhatsappRecipientSource = rawRecipient.source === 'FORM_FIELD' ? 'FORM_FIELD' : 'PARTNER_PHONE';

  const variables: WhatsappConfirmVariable[] = Array.isArray(o.variables)
    ? (o.variables as unknown[])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
        .filter((v) => (WHATSAPP_CONFIRM_TOKENS as readonly string[]).includes(v.token as string))
        .map((v) => ({
          token: v.token as WhatsappConfirmToken,
          formFieldId:
            v.token === 'FORM_FIELD' && typeof v.formFieldId === 'string' ? v.formFieldId : undefined,
        }))
    : [];

  return {
    enabled: o.enabled === true,
    templateName: typeof o.templateName === 'string' ? o.templateName : '',
    recipient: {
      source,
      formFieldId:
        source === 'FORM_FIELD' && typeof rawRecipient.formFieldId === 'string'
          ? rawRecipient.formFieldId
          : undefined,
    },
    variables,
  };
}

/**
 * Validation gating the save (mirrors validateSchemeFormSchema). When disabled →
 * nothing is required (returns []). When enabled: template name non-empty; a FORM_FIELD
 * recipient must name an existing field; every FORM_FIELD variable must name an existing
 * field. `formFields` is the scheme's enrollment-form fields — existence is only checked
 * when that list is available (non-empty).
 */
export function validateWhatsappConfirm(
  config: WhatsappConfirmConfig | null | undefined,
  formFields: FormField[] = [],
): string[] {
  const errors: string[] = [];
  if (!config || !config.enabled) return errors;

  if (!config.templateName.trim()) {
    errors.push('Enter the MSG91-registered WhatsApp template name.');
  }

  if (config.variables.length > MAX_WHATSAPP_VARIABLES) {
    errors.push(`Too many variables — a WhatsApp template supports at most ${MAX_WHATSAPP_VARIABLES}.`);
  }

  const ids = new Set(formFields.map((f) => f.id));
  const knows = formFields.length > 0; // don't flag "no longer exists" before fields have loaded

  if (config.recipient.source === 'FORM_FIELD') {
    if (!config.recipient.formFieldId) {
      errors.push('Recipient: choose the form field that holds the phone number.');
    } else if (knows && !ids.has(config.recipient.formFieldId)) {
      errors.push('Recipient: the selected form field no longer exists — pick another.');
    }
  }

  config.variables.forEach((v, i) => {
    if (v.token !== 'FORM_FIELD') return;
    if (!v.formFieldId) {
      errors.push(`Variable {{${i + 1}}}: choose a form field.`);
    } else if (knows && !ids.has(v.formFieldId)) {
      errors.push(`Variable {{${i + 1}}}: the selected form field no longer exists — pick another.`);
    }
  });

  return errors;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  value: WhatsappConfirmConfig;
  /**
   * The scheme's SAVED (persisted) enrollment-form fields — seed the recipient +
   * FORM_FIELD dropdowns and the "field no longer exists" check. Never the unsaved
   * builder draft, so a mapping can only reference a field the backend also knows.
   */
  formFields: FormField[];
  onChange: (next: WhatsappConfirmConfig) => void;
}

/**
 * A <select> of the form's value fields (phone-ish grouped first). Shared by the
 * recipient picker + each FORM_FIELD variable row. Module-level (like ConditionEditor)
 * so it isn't re-created on every render of the card.
 */
function FieldSelect({
  selected, onSelect, phoneFields, otherFields, hasFields, ariaLabel, missingHint,
}: {
  selected: string | undefined;
  onSelect: (id: string) => void;
  phoneFields: FormField[];
  otherFields: FormField[];
  hasFields: boolean;
  ariaLabel: string;
  missingHint?: boolean;
}) {
  const known = [...phoneFields, ...otherFields].some((f) => f.id === selected);
  return (
    <>
      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={ariaLabel}
        className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700"
      >
        <option value="">— choose a form field —</option>
        {selected && !known && <option value={selected}>(field removed from form)</option>}
        {phoneFields.length > 0 && (
          <optgroup label="Phone fields">
            {phoneFields.map((f) => <option key={f.id} value={f.id}>{fieldLabel(f)}</option>)}
          </optgroup>
        )}
        {otherFields.length > 0 && (
          <optgroup label="Other fields">
            {otherFields.map((f) => <option key={f.id} value={f.id}>{fieldLabel(f)}</option>)}
          </optgroup>
        )}
      </select>
      {!hasFields && (
        <p className="text-[10px] text-amber-500 mt-1">Add enrollment-form fields first (Enrollment form tab).</p>
      )}
      {missingHint && selected && !known && (
        <p className="text-[10px] text-amber-500 mt-1">This field is no longer on the form — pick another.</p>
      )}
    </>
  );
}

export function WhatsappConfirmCard({ value, formFields, onChange }: Props) {
  // Unique per card instance so multiple radio groups on a page never collide.
  const uid = useId();
  const recipientLabelId = `${uid}-recipient-label`;

  const errors = useMemo(() => validateWhatsappConfirm(value, formFields), [value, formFields]);
  const selectable = useMemo(() => formFields.filter(isSelectableField), [formFields]);
  const phoneFields = useMemo(() => selectable.filter(isPhoneish), [selectable]);
  const otherFields = useMemo(() => selectable.filter((f) => !isPhoneish(f)), [selectable]);
  const atVariableCap = value.variables.length >= MAX_WHATSAPP_VARIABLES;

  const patch = (p: Partial<WhatsappConfirmConfig>) => onChange({ ...value, ...p });

  const setRecipientSource = (source: WhatsappRecipientSource) => {
    if (source === 'FORM_FIELD') {
      // Seed to an existing pick or the first PHONE-ish field only — never silently
      // grab a name/text field under a "phone field" label; leave it blank to force a
      // deliberate choice (the required check then flags it).
      patch({ recipient: { source, formFieldId: value.recipient.formFieldId ?? phoneFields[0]?.id } });
    } else {
      patch({ recipient: { source: 'PARTNER_PHONE' } });
    }
  };

  const addVariable = () => patch({ variables: [...value.variables, { token: 'OWNER_NAME' }] });
  const removeVariable = (idx: number) => patch({ variables: value.variables.filter((_, i) => i !== idx) });
  const patchVariable = (idx: number, p: Partial<WhatsappConfirmVariable>) =>
    patch({ variables: value.variables.map((v, i) => (i === idx ? { ...v, ...p } : v)) });
  const moveVariable = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= value.variables.length) return;
    const copy = [...value.variables];
    const [m] = copy.splice(idx, 1);
    copy.splice(to, 0, m);
    patch({ variables: copy });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Header + enable toggle */}
      <div className="flex items-start gap-3 p-4">
        <div className="p-1.5 rounded-lg bg-green-50 text-green-600 flex-shrink-0">
          <MessageCircle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">WhatsApp confirmation on submission</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Send an MSG91 WhatsApp template message the moment an enrollment form is submitted.
          </p>
        </div>
        <button
          type="button"
          onClick={() => patch({ enabled: !value.enabled })}
          className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${value.enabled ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}
          aria-pressed={value.enabled}
          aria-label="Enable WhatsApp confirmation"
        >
          <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${value.enabled ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>

      {value.enabled && (
        <div className="border-t border-gray-100 p-4 space-y-5 bg-gray-50/60">
          {/* Dormant-channel note */}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-blue-700">
              Messages are only actually delivered once this tenant&apos;s WhatsApp channel is configured — until then
              this stays dormant (nothing is sent, no error).
            </p>
          </div>

          {/* Template name */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              WhatsApp template name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={value.templateName}
              onChange={(e) => patch({ templateName: e.target.value })}
              placeholder="e.g. scheme_enroll_confirm"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            />
            <p className="text-[10px] text-gray-400 mt-1">Exactly as registered with MSG91.</p>
          </div>

          {/* Recipient */}
          <div>
            <p id={recipientLabelId} className="block text-xs font-medium text-gray-700 mb-1.5">Send to</p>
            <div role="radiogroup" aria-labelledby={recipientLabelId} className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer text-[11px] text-gray-600">
                <input
                  type="radio" name={`${uid}-recipient`} checked={value.recipient.source === 'PARTNER_PHONE'}
                  onChange={() => setRecipientSource('PARTNER_PHONE')}
                  className="w-3.5 h-3.5 accent-[var(--brand-primary)] mt-0.5"
                />
                <span className="flex items-center gap-1"><Phone className="w-3 h-3 text-gray-400" /> Partner phone (the enrolling outlet owner&apos;s number on file)</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-[11px] text-gray-600">
                <input
                  type="radio" name={`${uid}-recipient`} checked={value.recipient.source === 'FORM_FIELD'}
                  onChange={() => setRecipientSource('FORM_FIELD')}
                  className="w-3.5 h-3.5 accent-[var(--brand-primary)] mt-0.5"
                />
                <span>A phone field from this form</span>
              </label>
            </div>
            {value.recipient.source === 'FORM_FIELD' && (
              <div className="mt-2 pl-5">
                <FieldSelect
                  selected={value.recipient.formFieldId}
                  onSelect={(id) => patch({ recipient: { source: 'FORM_FIELD', formFieldId: id || undefined } })}
                  phoneFields={phoneFields}
                  otherFields={otherFields}
                  hasFields={selectable.length > 0}
                  ariaLabel="Recipient phone form field"
                  missingHint
                />
              </div>
            )}
          </div>

          {/* Variables */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-gray-700">Template variables</label>
              <span className="text-[10px] text-gray-400">order = &#123;&#123;1&#125;&#125;, &#123;&#123;2&#125;&#125;, …</span>
            </div>
            {value.variables.length === 0 && (
              <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-3 text-center text-[11px] text-gray-400">
                No variables — add one for each &#123;&#123;n&#125;&#125; slot in your template.
              </div>
            )}
            <div className="space-y-2">
              {value.variables.map((v, idx) => (
                <div key={idx} className="flex items-start gap-2 bg-white border border-gray-200 rounded-lg p-2">
                  <div className="flex flex-col gap-0.5 pt-1">
                    <button type="button" onClick={() => moveVariable(idx, -1)} disabled={idx === 0}
                      className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => moveVariable(idx, 1)} disabled={idx === value.variables.length - 1}
                      className="p-0.5 text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
                  </div>
                  <span className="text-[11px] font-mono font-semibold text-gray-500 bg-gray-100 rounded px-1.5 py-1 mt-0.5 flex-shrink-0">
                    &#123;&#123;{idx + 1}&#125;&#125;
                  </span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <select
                      value={v.token}
                      onChange={(e) => {
                        const token = e.target.value as WhatsappConfirmToken;
                        patchVariable(idx, { token, formFieldId: token === 'FORM_FIELD' ? v.formFieldId : undefined });
                      }}
                      aria-label={`Variable ${idx + 1} token`}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700"
                    >
                      {TOKEN_META.map((t) => <option key={t.token} value={t.token}>{t.label}</option>)}
                    </select>
                    {v.token === 'FORM_FIELD' && (
                      <FieldSelect
                        selected={v.formFieldId}
                        onSelect={(id) => patchVariable(idx, { formFieldId: id || undefined })}
                        phoneFields={phoneFields}
                        otherFields={otherFields}
                        hasFields={selectable.length > 0}
                        ariaLabel={`Variable ${idx + 1} form field`}
                        missingHint
                      />
                    )}
                  </div>
                  <button type="button" onClick={() => removeVariable(idx)}
                    className="p-1 text-gray-300 hover:text-red-500 mt-0.5"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addVariable} disabled={atVariableCap}
              title={atVariableCap ? `A WhatsApp template supports at most ${MAX_WHATSAPP_VARIABLES} variables.` : undefined}
              className="mt-2 flex items-center gap-1 text-xs text-[var(--brand-primary)] font-medium hover:text-green-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--brand-primary)]">
              <Plus className="w-3.5 h-3.5" /> Add variable
            </button>
            {atVariableCap && (
              <p className="text-[10px] text-amber-500 mt-1">Maximum {MAX_WHATSAPP_VARIABLES} variables reached.</p>
            )}
          </div>

          {/* Token legend / help — the builder must understand each token with no prior knowledge */}
          <div className="border border-gray-200 rounded-lg bg-white p-3">
            <p className="text-[11px] font-semibold text-gray-700 mb-2">What each token resolves to</p>
            <ul className="space-y-1">
              {TOKEN_META.map((t) => (
                <li key={t.token} className="text-[11px] text-gray-600 flex gap-1.5">
                  <span className="font-medium text-gray-800 flex-shrink-0">{t.label.replace(' →', '')}</span>
                  <span className="text-gray-300">→</span>
                  <span>{t.resolves}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-500 mt-2">
              Note: &ldquo;Partner phone&rdquo; only sends when the enrolling outlet owner has a phone number on
              file — otherwise it&apos;s a silent no-op (nothing is sent).
            </p>
            <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-700">
                The number and order of variables must <strong>EXACTLY</strong> match your MSG91-registered WhatsApp
                template (&#123;&#123;1&#125;&#125;, &#123;&#123;2&#125;&#125;, …). We can&apos;t verify your template — matching is on you.
              </p>
            </div>
          </div>

          {/* Inline validation (click to focus the offending control) */}
          {errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
              {errors.map((e, i) => (
                <p key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {e}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default WhatsappConfirmCard;
