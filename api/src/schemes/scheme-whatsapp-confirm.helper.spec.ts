/**
 * scheme-whatsapp-confirm.helper.spec.ts — pure unit tests for the per-scheme
 * "WhatsApp confirmation on enrollment submit" config + resolver.
 *
 * Covers:
 *   - resolveSchemeWhatsappConfirm: each variable token; PARTNER_PHONE vs FORM_FIELD
 *     recipient; invalid/blank phone → null; disabled/misconfigured → null; body order
 *     preserved; FORM_FIELD variable missing → ''.
 *   - validateWhatsappConfirmConfig: enabled requires template + recipient (+ FORM_FIELD
 *     field id); not-enabled is lenient; variable token/cap checks.
 *
 * Run: npx jest src/schemes/scheme-whatsapp-confirm.helper.spec.ts
 */

import {
  resolveSchemeWhatsappConfirm,
  validateWhatsappConfirmConfig,
  normalizeWhatsappConfirmForStore,
  parseWhatsappConfirmConfig,
  WhatsappConfirmContext,
  WHATSAPP_CONFIRM_MAX_VARIABLES,
} from './scheme-whatsapp-confirm.helper';
import { formatDateIST } from '../common/ist-date';

const baseCtx = (over: Partial<WhatsappConfirmContext> = {}): WhatsappConfirmContext => ({
  ownerName: 'Ravi Kumar',
  ownerPhone: '+91 98300 11252',
  outletName: 'Ravi Stores',
  outletCode: 'OUT001',
  schemeName: 'Diwali Dhamaka',
  submittedAt: new Date('2026-09-17T06:00:00.000Z'),
  formValues: { fPhone: '9876543210', fSlab: 'Gold', fEmpty: '' },
  ...over,
});

const enabledConfig = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  templateName: 'scheme_enroll_confirm',
  recipient: { source: 'PARTNER_PHONE' },
  variables: [],
  ...over,
});

describe('resolveSchemeWhatsappConfirm', () => {
  it('resolves PARTNER_PHONE recipient (normalized) + template, no variables', () => {
    const res = resolveSchemeWhatsappConfirm(enabledConfig(), baseCtx());
    expect(res).toEqual({
      phone: '9830011252', // normalized last-10 from '+91 98300 11252'
      templateName: 'scheme_enroll_confirm',
      bodyValues: [],
    });
  });

  it('resolves a FORM_FIELD recipient from formValues', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({ recipient: { source: 'FORM_FIELD', formFieldId: 'fPhone' } }),
      baseCtx(),
    );
    expect(res?.phone).toBe('9876543210');
  });

  it('maps every variable token to its ctx value, preserving order', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({
        variables: [
          { token: 'OWNER_NAME' },
          { token: 'OWNER_PHONE' },
          { token: 'OUTLET_NAME' },
          { token: 'OUTLET_CODE' },
          { token: 'SCHEME_NAME' },
          { token: 'SUBMISSION_DATE' },
          { token: 'FORM_FIELD', formFieldId: 'fSlab' },
        ],
      }),
      baseCtx(),
    );
    expect(res?.bodyValues).toEqual([
      'Ravi Kumar',
      '+91 98300 11252',
      'Ravi Stores',
      'OUT001',
      'Diwali Dhamaka',
      formatDateIST(new Date('2026-09-17T06:00:00.000Z')), // '17 Sep 2026'
      'Gold',
    ]);
  });

  it('renders SUBMISSION_DATE as the IST wall-clock date', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({ variables: [{ token: 'SUBMISSION_DATE' }] }),
      baseCtx({ submittedAt: new Date('2026-09-17T06:00:00.000Z') }),
    );
    expect(res?.bodyValues[0]).toBe('17 Sep 2026');
  });

  it('a FORM_FIELD variable with a missing field id → empty string', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({ variables: [{ token: 'FORM_FIELD', formFieldId: 'doesNotExist' }] }),
      baseCtx(),
    );
    expect(res?.bodyValues).toEqual(['']);
  });

  it('a FORM_FIELD variable with no formFieldId → empty string', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({ variables: [{ token: 'FORM_FIELD' }] }),
      baseCtx(),
    );
    expect(res?.bodyValues).toEqual(['']);
  });

  it('missing/blank ctx values render as empty strings (not "null")', () => {
    const res = resolveSchemeWhatsappConfirm(
      enabledConfig({
        variables: [{ token: 'OWNER_NAME' }, { token: 'OUTLET_CODE' }, { token: 'FORM_FIELD', formFieldId: 'fEmpty' }],
      }),
      baseCtx({ ownerName: null, outletCode: undefined }),
    );
    expect(res?.bodyValues).toEqual(['', '', '']);
  });

  it('returns null when disabled', () => {
    expect(resolveSchemeWhatsappConfirm(enabledConfig({ enabled: false }), baseCtx())).toBeNull();
  });

  it('returns null when config is missing / not an object', () => {
    expect(resolveSchemeWhatsappConfirm(null, baseCtx())).toBeNull();
    expect(resolveSchemeWhatsappConfirm(undefined, baseCtx())).toBeNull();
    expect(resolveSchemeWhatsappConfirm('nope', baseCtx())).toBeNull();
  });

  it('returns null when enabled but templateName is blank', () => {
    expect(resolveSchemeWhatsappConfirm(enabledConfig({ templateName: '   ' }), baseCtx())).toBeNull();
  });

  it('returns null when the PARTNER_PHONE recipient has no valid phone', () => {
    expect(
      resolveSchemeWhatsappConfirm(enabledConfig(), baseCtx({ ownerPhone: null })),
    ).toBeNull();
    expect(
      resolveSchemeWhatsappConfirm(enabledConfig(), baseCtx({ ownerPhone: '12345' })),
    ).toBeNull();
  });

  it('returns null when a FORM_FIELD recipient resolves to an invalid phone', () => {
    expect(
      resolveSchemeWhatsappConfirm(
        enabledConfig({ recipient: { source: 'FORM_FIELD', formFieldId: 'fSlab' } }),
        baseCtx(), // fSlab = 'Gold' → not a phone
      ),
    ).toBeNull();
  });

  it('returns null when a FORM_FIELD recipient has no formFieldId', () => {
    expect(
      resolveSchemeWhatsappConfirm(enabledConfig({ recipient: { source: 'FORM_FIELD' } }), baseCtx()),
    ).toBeNull();
  });

  it('returns null for an unknown recipient source', () => {
    expect(
      resolveSchemeWhatsappConfirm(enabledConfig({ recipient: { source: 'SOMETHING' } }), baseCtx()),
    ).toBeNull();
  });
});

describe('validateWhatsappConfirmConfig', () => {
  it('accepts a fully-configured enabled config', () => {
    expect(
      validateWhatsappConfirmConfig({
        enabled: true,
        templateName: 't',
        recipient: { source: 'PARTNER_PHONE' },
        variables: [{ token: 'OWNER_NAME' }, { token: 'FORM_FIELD', formFieldId: 'f1' }],
      }),
    ).toEqual([]);
  });

  it('accepts a disabled config with no template/recipient (clearing)', () => {
    expect(validateWhatsappConfirmConfig({ enabled: false })).toEqual([]);
    expect(validateWhatsappConfirmConfig({})).toEqual([]);
  });

  it('accepts a DISABLED config with a half-configured FORM_FIELD (inert → no required-ness; audit FE-F2)', () => {
    // A disabled config is inert; a dangling FORM_FIELD recipient/variable (no formFieldId yet)
    // must NOT error — mirrors the FE, which skips validation while disabled. Re-enabling re-applies
    // the required checks. Type validity of provided values is still enforced (see below).
    expect(
      validateWhatsappConfirmConfig({
        enabled: false,
        recipient: { source: 'FORM_FIELD' }, // no formFieldId
        variables: [{ token: 'FORM_FIELD' }], // no formFieldId
      }),
    ).toEqual([]);
    // …but a bad TYPE is still rejected even when disabled.
    expect(
      validateWhatsappConfirmConfig({ enabled: false, variables: [{ token: 'BOGUS' }] }).some((e) =>
        /token must be one of/.test(e),
      ),
    ).toBe(true);
  });

  it('requires templateName when enabled', () => {
    const errs = validateWhatsappConfirmConfig({ enabled: true, recipient: { source: 'PARTNER_PHONE' } });
    expect(errs.some((e) => /templateName is required/.test(e))).toBe(true);
  });

  it('requires recipient when enabled', () => {
    const errs = validateWhatsappConfirmConfig({ enabled: true, templateName: 't' });
    expect(errs.some((e) => /recipient is required/.test(e))).toBe(true);
  });

  it('requires recipient.formFieldId when source is FORM_FIELD', () => {
    const errs = validateWhatsappConfirmConfig({
      enabled: true,
      templateName: 't',
      recipient: { source: 'FORM_FIELD' },
    });
    expect(errs.some((e) => /recipient.formFieldId is required/.test(e))).toBe(true);
  });

  it('rejects an invalid recipient source', () => {
    const errs = validateWhatsappConfirmConfig({
      enabled: true,
      templateName: 't',
      recipient: { source: 'NOPE' },
    });
    expect(errs.some((e) => /recipient.source must be one of/.test(e))).toBe(true);
  });

  it('rejects an invalid variable token', () => {
    const errs = validateWhatsappConfirmConfig({
      enabled: true,
      templateName: 't',
      recipient: { source: 'PARTNER_PHONE' },
      variables: [{ token: 'BOGUS' }],
    });
    expect(errs.some((e) => /token must be one of/.test(e))).toBe(true);
  });

  it('requires a variable formFieldId when token is FORM_FIELD', () => {
    const errs = validateWhatsappConfirmConfig({
      enabled: true,
      templateName: 't',
      recipient: { source: 'PARTNER_PHONE' },
      variables: [{ token: 'FORM_FIELD' }],
    });
    expect(errs.some((e) => /variables\[0\].formFieldId is required/.test(e))).toBe(true);
  });

  it('caps variables length', () => {
    const variables = Array.from({ length: WHATSAPP_CONFIRM_MAX_VARIABLES + 1 }, () => ({ token: 'OWNER_NAME' }));
    const errs = validateWhatsappConfirmConfig({
      enabled: true,
      templateName: 't',
      recipient: { source: 'PARTNER_PHONE' },
      variables,
    });
    expect(errs.some((e) => /at most 20 entries/.test(e))).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateWhatsappConfirmConfig('nope').length).toBeGreaterThan(0);
  });
});

describe('normalizeWhatsappConfirmForStore', () => {
  it('keeps only known keys, trims the template, and drops FORM_FIELD ids on non-FORM_FIELD kinds', () => {
    const stored = normalizeWhatsappConfirmForStore({
      enabled: true,
      templateName: '  scheme_confirm  ',
      junk: 'x',
      recipient: { source: 'PARTNER_PHONE', formFieldId: 'ignored' },
      variables: [
        { token: 'OWNER_NAME', formFieldId: 'ignored' },
        { token: 'FORM_FIELD', formFieldId: 'f1', junk: 1 },
      ],
    });
    expect(stored).toEqual({
      enabled: true,
      templateName: 'scheme_confirm',
      recipient: { source: 'PARTNER_PHONE' },
      variables: [{ token: 'OWNER_NAME' }, { token: 'FORM_FIELD', formFieldId: 'f1' }],
    });
  });
});

describe('parseWhatsappConfirmConfig', () => {
  it('reads enabled strictly and preserves order', () => {
    const cfg = parseWhatsappConfirmConfig({
      enabled: 'true', // not === true → disabled
      templateName: 't',
      recipient: { source: 'PARTNER_PHONE' },
      variables: [{ token: 'OUTLET_NAME' }],
    });
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.variables).toEqual([{ token: 'OUTLET_NAME' }]);
  });

  it('returns null for a non-object', () => {
    expect(parseWhatsappConfirmConfig(42)).toBeNull();
  });
});
