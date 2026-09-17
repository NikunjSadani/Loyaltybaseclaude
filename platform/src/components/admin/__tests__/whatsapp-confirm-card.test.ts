/**
 * Unit tests for the WhatsApp-confirmation config helpers — the client-side validation
 * (`validateWhatsappConfirm`) that gates the scheme's WhatsApp-settings save, and the
 * metadata hydrator (`normalizeWhatsappConfirm`) that reads `scheme.metadata.whatsappConfirm`.
 *
 * Mirrors scheme-form-builder.test.ts: pure-function tests over the exported helpers.
 */

import { describe, it, expect } from 'vitest';
import { validateWhatsappConfirm, normalizeWhatsappConfirm, MAX_WHATSAPP_VARIABLES } from '../WhatsappConfirmCard';
import {
  DEFAULT_WHATSAPP_CONFIRM,
  type FormField,
  type FormFieldType,
  type WhatsappConfirmConfig,
} from '@/lib/scheme-types';

function field(type: FormFieldType, over: Partial<FormField> = {}): FormField {
  return {
    id: over.id ?? `f_${type}`,
    type,
    label: over.label ?? 'Label',
    required: over.required ?? false,
    order: over.order ?? 0,
    ...over,
  };
}

function config(over: Partial<WhatsappConfirmConfig> = {}): WhatsappConfirmConfig {
  return { ...DEFAULT_WHATSAPP_CONFIRM, ...over };
}

const FORM_FIELDS: FormField[] = [
  field('TEXT', { id: 'owner', label: 'Owner name' }),
  field('PHONE_OTP', { id: 'mobile', label: 'Mobile' }),
];

describe('normalizeWhatsappConfirm', () => {
  it('returns the all-off default for absent / non-object metadata', () => {
    expect(normalizeWhatsappConfirm(undefined)).toEqual(DEFAULT_WHATSAPP_CONFIRM);
    expect(normalizeWhatsappConfirm(null)).toEqual(DEFAULT_WHATSAPP_CONFIRM);
    expect(normalizeWhatsappConfirm('nope')).toEqual(DEFAULT_WHATSAPP_CONFIRM);
    // A fresh scheme is off by default.
    expect(normalizeWhatsappConfirm(undefined).enabled).toBe(false);
  });

  it('coerces a stored config into the exact whatsappConfirm shape', () => {
    const raw = {
      enabled: true,
      templateName: 'scheme_enroll_confirm',
      recipient: { source: 'FORM_FIELD', formFieldId: 'mobile' },
      variables: [
        { token: 'OWNER_NAME' },
        { token: 'FORM_FIELD', formFieldId: 'owner' },
      ],
    };
    expect(normalizeWhatsappConfirm(raw)).toEqual({
      enabled: true,
      templateName: 'scheme_enroll_confirm',
      recipient: { source: 'FORM_FIELD', formFieldId: 'mobile' },
      variables: [
        { token: 'OWNER_NAME', formFieldId: undefined },
        { token: 'FORM_FIELD', formFieldId: 'owner' },
      ],
    });
  });

  it('drops unknown tokens and a stray form-field id on a non-FORM_FIELD variable', () => {
    const out = normalizeWhatsappConfirm({
      enabled: true,
      templateName: 't',
      variables: [
        { token: 'BOGUS' },
        { token: 'OWNER_NAME', formFieldId: 'owner' }, // formFieldId is meaningless here → dropped
      ],
    });
    expect(out.variables).toEqual([{ token: 'OWNER_NAME', formFieldId: undefined }]);
    // recipient defaults to PARTNER_PHONE when absent
    expect(out.recipient).toEqual({ source: 'PARTNER_PHONE', formFieldId: undefined });
  });
});

describe('validateWhatsappConfirm', () => {
  it('requires nothing while disabled (default off)', () => {
    expect(validateWhatsappConfirm(config(), FORM_FIELDS)).toEqual([]);
    // even a half-filled config passes validation while enabled=false
    expect(validateWhatsappConfirm(config({ templateName: '' }), FORM_FIELDS)).toEqual([]);
  });

  it('requires a template name once enabled', () => {
    const errs = validateWhatsappConfirm(config({ enabled: true, templateName: '   ' }), FORM_FIELDS);
    expect(errs.some((e) => /template name/i.test(e))).toBe(true);
  });

  it('requires a form field when the recipient is a FORM_FIELD', () => {
    const errs = validateWhatsappConfirm(
      config({ enabled: true, templateName: 't', recipient: { source: 'FORM_FIELD' } }),
      FORM_FIELDS,
    );
    expect(errs.some((e) => /Recipient: choose the form field/i.test(e))).toBe(true);
  });

  it('flags a recipient form field that no longer exists on the form', () => {
    const errs = validateWhatsappConfirm(
      config({ enabled: true, templateName: 't', recipient: { source: 'FORM_FIELD', formFieldId: 'gone' } }),
      FORM_FIELDS,
    );
    expect(errs.some((e) => /no longer exists/i.test(e))).toBe(true);
  });

  it('requires a form field on each FORM_FIELD variable', () => {
    const errs = validateWhatsappConfirm(
      config({
        enabled: true,
        templateName: 't',
        variables: [{ token: 'OWNER_NAME' }, { token: 'FORM_FIELD' }],
      }),
      FORM_FIELDS,
    );
    // the 2nd variable ({{2}}) is the offending one
    expect(errs.some((e) => /Variable \{\{2\}\}: choose a form field/i.test(e))).toBe(true);
  });

  it('caps the number of variables (backend rejects > 20 → mirror it)', () => {
    const many = Array.from({ length: MAX_WHATSAPP_VARIABLES + 1 }, () => ({ token: 'SCHEME_NAME' as const }));
    const errs = validateWhatsappConfirm(config({ enabled: true, templateName: 't', variables: many }), FORM_FIELDS);
    expect(errs.some((e) => /at most 20/i.test(e))).toBe(true);
  });

  it('accepts exactly the max number of variables', () => {
    const many = Array.from({ length: MAX_WHATSAPP_VARIABLES }, () => ({ token: 'SCHEME_NAME' as const }));
    const errs = validateWhatsappConfirm(config({ enabled: true, templateName: 't', variables: many }), FORM_FIELDS);
    expect(errs).toEqual([]);
  });

  it('is clean for a fully-specified enabled config', () => {
    const errs = validateWhatsappConfirm(
      config({
        enabled: true,
        templateName: 'scheme_enroll_confirm',
        recipient: { source: 'FORM_FIELD', formFieldId: 'mobile' },
        variables: [
          { token: 'OWNER_NAME' },
          { token: 'SUBMISSION_DATE' },
          { token: 'FORM_FIELD', formFieldId: 'owner' },
        ],
      }),
      FORM_FIELDS,
    );
    expect(errs).toEqual([]);
  });

  it('is clean with the partner-phone recipient and no form-field variables', () => {
    const errs = validateWhatsappConfirm(
      config({
        enabled: true,
        templateName: 't',
        recipient: { source: 'PARTNER_PHONE' },
        variables: [{ token: 'SCHEME_NAME' }],
      }),
      FORM_FIELDS,
    );
    expect(errs).toEqual([]);
  });

  it('produces a valid saved payload — round-trips through normalize unchanged', () => {
    const saved = config({
      enabled: true,
      templateName: 'scheme_enroll_confirm',
      recipient: { source: 'FORM_FIELD', formFieldId: 'mobile' },
      variables: [{ token: 'FORM_FIELD', formFieldId: 'owner' }],
    });
    expect(validateWhatsappConfirm(saved, FORM_FIELDS)).toEqual([]);
    // The exact object the FE sends as `whatsappConfirm` survives a metadata read-back.
    expect(normalizeWhatsappConfirm(saved)).toEqual(saved);
  });
});
