/**
 * scheme-whatsapp-confirm.helper.ts — pure, unit-testable config + resolver for the
 * per-scheme "WhatsApp confirmation on enrollment submit" feature.
 *
 * When a scheme has WhatsApp-confirmation configured + enabled (stored on
 * `scheme.metadata.whatsappConfirm`), EACH successful enrollment submit fires a
 * WhatsApp TEMPLATE message to the resolved recipient via MSG91, fire-and-forget.
 * The engine (scheme-enrollment.service `submit()`) owns the Prisma loads + the send;
 * this file owns ONLY the pure logic:
 *   - the stored config shape + its validation (create/update DTO),
 *   - `resolveSchemeWhatsappConfirm(config, ctx)` — the pure recipient/body resolver.
 *
 * No Prisma / NestJS imports, so it is testable with plain objects. IST date rendering
 * is delegated to common/ist-date so a SUBMISSION_DATE variable renders the Indian
 * wall-clock date regardless of the server timezone (prod runs UTC).
 */

import { formatDateIST } from '../common/ist-date';
import { phoneLast10, isValidPhone } from '../common/audience/audience.helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Config contract (stored on scheme.metadata.whatsappConfirm)
// ─────────────────────────────────────────────────────────────────────────────

/** Where the confirmation recipient's phone comes from. */
export const WHATSAPP_CONFIRM_RECIPIENT_SOURCES = ['PARTNER_PHONE', 'FORM_FIELD'] as const;
export type WhatsappConfirmRecipientSource =
  (typeof WHATSAPP_CONFIRM_RECIPIENT_SOURCES)[number];

/** The variable tokens a body slot can bind to (ORDERED → body_1, body_2, …). */
export const WHATSAPP_CONFIRM_VARIABLE_TOKENS = [
  'OWNER_NAME',
  'OWNER_PHONE',
  'OUTLET_NAME',
  'OUTLET_CODE',
  'SCHEME_NAME',
  'SUBMISSION_DATE',
  'FORM_FIELD',
] as const;
export type WhatsappConfirmVariableToken =
  (typeof WHATSAPP_CONFIRM_VARIABLE_TOKENS)[number];

/** Cap on body variables — mirrors BroadcastDto's ArrayMaxSize discipline. */
export const WHATSAPP_CONFIRM_MAX_VARIABLES = 20;

export interface WhatsappConfirmRecipient {
  source: WhatsappConfirmRecipientSource;
  /** Required when source === 'FORM_FIELD' — the form field id holding the phone. */
  formFieldId?: string;
}

export interface WhatsappConfirmVariable {
  token: WhatsappConfirmVariableToken;
  /** Required when token === 'FORM_FIELD' — the form field id holding the value. */
  formFieldId?: string;
}

export interface WhatsappConfirmConfig {
  /** Master switch — default false; when false the feature is inert (no send). */
  enabled: boolean;
  /** MSG91-registered WhatsApp template name (required when enabled). */
  templateName: string;
  recipient: WhatsappConfirmRecipient;
  /** Ordered → body_1, body_2, … (WhatsApp positional variables). */
  variables: WhatsappConfirmVariable[];
}

/** The resolution context the engine assembles per submit (all fields best-effort). */
export interface WhatsappConfirmContext {
  ownerName?: string | null;
  ownerPhone?: string | null;
  outletName?: string | null;
  outletCode?: string | null;
  schemeName?: string | null;
  submittedAt: Date;
  /** The persisted enrollment values, keyed by form field id. */
  formValues: Record<string, unknown>;
}

/** The resolved send instruction, or null when nothing should be sent. */
export interface ResolvedWhatsappConfirm {
  phone: string;
  templateName: string;
  bodyValues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing (tolerant — reads a raw JSON value into the typed shape)
// ─────────────────────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isSource(v: unknown): v is WhatsappConfirmRecipientSource {
  return typeof v === 'string' && (WHATSAPP_CONFIRM_RECIPIENT_SOURCES as readonly string[]).includes(v);
}

function isToken(v: unknown): v is WhatsappConfirmVariableToken {
  return typeof v === 'string' && (WHATSAPP_CONFIRM_VARIABLE_TOKENS as readonly string[]).includes(v);
}

/**
 * Read a raw metadata.whatsappConfirm value into the typed config, tolerantly. Returns
 * null only when the value is not an object; otherwise a best-effort view (an invalid
 * recipient source / token is preserved as-is for the resolver to reject). `enabled` is
 * strictly `=== true` so any non-true value reads as disabled.
 */
export function parseWhatsappConfirmConfig(raw: unknown): WhatsappConfirmConfig | null {
  const o = asObject(raw);
  if (!o) return null;

  const recipientRaw = asObject(o.recipient) ?? {};
  const recipient: WhatsappConfirmRecipient = {
    source: isSource(recipientRaw.source) ? recipientRaw.source : ('' as WhatsappConfirmRecipientSource),
    ...(typeof recipientRaw.formFieldId === 'string' ? { formFieldId: recipientRaw.formFieldId } : {}),
  };

  const variables: WhatsappConfirmVariable[] = Array.isArray(o.variables)
    ? o.variables.map((v) => {
        const vo = asObject(v) ?? {};
        return {
          token: isToken(vo.token) ? vo.token : ('' as WhatsappConfirmVariableToken),
          ...(typeof vo.formFieldId === 'string' ? { formFieldId: vo.formFieldId } : {}),
        };
      })
    : [];

  return {
    enabled: o.enabled === true,
    templateName: typeof o.templateName === 'string' ? o.templateName : '',
    recipient,
    variables,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (scheme create/update DTO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a raw `whatsappConfirm` config for the scheme create/update input. Returns a
 * list of human-readable errors (empty === valid). When NOT enabled, the config may be
 * stored/cleared WITHOUT a template or recipient (the feature is simply inert); provided
 * fields are still shape-checked so junk never persists. When enabled, the template +
 * recipient (+ any FORM_FIELD field id) are required.
 */
export function validateWhatsappConfirmConfig(value: unknown): string[] {
  const errors: string[] = [];
  const o = asObject(value);
  if (!o) return ['whatsappConfirm must be an object.'];

  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    errors.push('whatsappConfirm.enabled must be a boolean.');
  }
  const enabled = o.enabled === true;

  // templateName
  if (o.templateName !== undefined && typeof o.templateName !== 'string') {
    errors.push('whatsappConfirm.templateName must be a string.');
  }
  if (enabled) {
    const t = typeof o.templateName === 'string' ? o.templateName.trim() : '';
    if (t === '') errors.push('whatsappConfirm.templateName is required when enabled.');
  }

  // recipient
  const recipient = asObject(o.recipient);
  if (o.recipient !== undefined && !recipient) {
    errors.push('whatsappConfirm.recipient must be an object.');
  }
  if (recipient) {
    if (recipient.source !== undefined && !isSource(recipient.source)) {
      errors.push(
        `whatsappConfirm.recipient.source must be one of: ${WHATSAPP_CONFIRM_RECIPIENT_SOURCES.join(', ')}.`,
      );
    }
    // formFieldId is REQUIRED only when the feature is enabled (a disabled config is inert, so a
    // half-configured FORM_FIELD recipient may be stored without a field yet — matches the FE, which
    // skips validation while disabled; the required-ness re-applies the moment it's re-enabled).
    if (enabled && recipient.source === 'FORM_FIELD') {
      const f = typeof recipient.formFieldId === 'string' ? recipient.formFieldId.trim() : '';
      if (f === '') {
        errors.push('whatsappConfirm.recipient.formFieldId is required when source is FORM_FIELD.');
      }
    }
  }
  if (enabled && !recipient) {
    errors.push('whatsappConfirm.recipient is required when enabled.');
  }
  if (enabled && recipient && !isSource(recipient.source)) {
    errors.push('whatsappConfirm.recipient.source is required when enabled.');
  }

  // variables
  if (o.variables !== undefined) {
    if (!Array.isArray(o.variables)) {
      errors.push('whatsappConfirm.variables must be an array.');
    } else {
      if (o.variables.length > WHATSAPP_CONFIRM_MAX_VARIABLES) {
        errors.push(`whatsappConfirm.variables must have at most ${WHATSAPP_CONFIRM_MAX_VARIABLES} entries.`);
      }
      o.variables.forEach((v, i) => {
        const vo = asObject(v);
        if (!vo) {
          errors.push(`whatsappConfirm.variables[${i}] must be an object.`);
          return;
        }
        if (!isToken(vo.token)) {
          errors.push(
            `whatsappConfirm.variables[${i}].token must be one of: ${WHATSAPP_CONFIRM_VARIABLE_TOKENS.join(', ')}.`,
          );
        }
        // Required only when enabled (inert otherwise — mirrors the recipient rule + the FE).
        if (enabled && vo.token === 'FORM_FIELD') {
          const f = typeof vo.formFieldId === 'string' ? vo.formFieldId.trim() : '';
          if (f === '') {
            errors.push(`whatsappConfirm.variables[${i}].formFieldId is required when token is FORM_FIELD.`);
          }
        }
      });
    }
  }

  return errors;
}

/**
 * Normalize a validated raw config into the deterministic stored shape (only known keys,
 * trimmed template). Call ONLY after validateWhatsappConfirmConfig passes. A FORM_FIELD
 * source/token keeps its formFieldId; other kinds drop it.
 */
export function normalizeWhatsappConfirmForStore(value: unknown): WhatsappConfirmConfig {
  const o = asObject(value) ?? {};
  const recipientRaw = asObject(o.recipient) ?? {};
  const source = isSource(recipientRaw.source)
    ? recipientRaw.source
    : ('PARTNER_PHONE' as WhatsappConfirmRecipientSource);
  const recipient: WhatsappConfirmRecipient = {
    source,
    ...(source === 'FORM_FIELD' && typeof recipientRaw.formFieldId === 'string'
      ? { formFieldId: recipientRaw.formFieldId.trim() }
      : {}),
  };

  const variables: WhatsappConfirmVariable[] = Array.isArray(o.variables)
    ? o.variables.map((v) => {
        const vo = asObject(v) ?? {};
        const token = isToken(vo.token) ? vo.token : ('OWNER_NAME' as WhatsappConfirmVariableToken);
        return {
          token,
          ...(token === 'FORM_FIELD' && typeof vo.formFieldId === 'string'
            ? { formFieldId: vo.formFieldId.trim() }
            : {}),
        };
      })
    : [];

  return {
    enabled: o.enabled === true,
    templateName: typeof o.templateName === 'string' ? o.templateName.trim() : '',
    recipient,
    variables,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver (pure) — the recipient phone + ordered body values, or null
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a single variable token to its string value (missing/empty → ''). */
function resolveVariable(
  variable: WhatsappConfirmVariable,
  ctx: WhatsappConfirmContext,
): string {
  switch (variable.token) {
    case 'OWNER_NAME':
      return String(ctx.ownerName ?? '');
    case 'OWNER_PHONE':
      return String(ctx.ownerPhone ?? '');
    case 'OUTLET_NAME':
      return String(ctx.outletName ?? '');
    case 'OUTLET_CODE':
      return String(ctx.outletCode ?? '');
    case 'SCHEME_NAME':
      return String(ctx.schemeName ?? '');
    case 'SUBMISSION_DATE':
      return formatDateIST(ctx.submittedAt);
    case 'FORM_FIELD': {
      if (!variable.formFieldId) return '';
      const v = ctx.formValues[variable.formFieldId];
      return v === undefined || v === null ? '' : String(v);
    }
    default:
      return '';
  }
}

/**
 * Pure resolver for the WhatsApp confirmation send. Returns `null` (skip send) when the
 * config is disabled, misconfigured, or the recipient phone is unresolvable / not a valid
 * bare 10-digit Indian mobile. Otherwise returns the normalized phone, the template name,
 * and the ordered positional body values.
 *
 * Recipient:
 *   - PARTNER_PHONE → ctx.ownerPhone
 *   - FORM_FIELD    → String(ctx.formValues[recipient.formFieldId])
 * The phone is normalized via phoneLast10; an invalid (non-10-digit) result → null.
 *
 * Body values preserve config order; each token maps per resolveVariable (empty/missing → '').
 */
export function resolveSchemeWhatsappConfirm(
  config: unknown,
  ctx: WhatsappConfirmContext,
): ResolvedWhatsappConfirm | null {
  const cfg = parseWhatsappConfirmConfig(config);
  if (!cfg) return null;
  if (!cfg.enabled) return null;

  const templateName = cfg.templateName.trim();
  if (templateName === '') return null;

  // Recipient phone.
  let rawPhone: unknown;
  if (cfg.recipient.source === 'PARTNER_PHONE') {
    rawPhone = ctx.ownerPhone;
  } else if (cfg.recipient.source === 'FORM_FIELD') {
    if (!cfg.recipient.formFieldId) return null;
    rawPhone = ctx.formValues[cfg.recipient.formFieldId];
  } else {
    return null; // unknown / missing source
  }

  const phone = phoneLast10(rawPhone == null ? '' : String(rawPhone));
  if (!isValidPhone(phone)) return null;

  const bodyValues = cfg.variables.map((v) => resolveVariable(v, ctx));

  return { phone, templateName, bodyValues };
}
