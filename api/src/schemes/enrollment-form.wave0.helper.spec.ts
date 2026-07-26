/**
 * enrollment-form.wave0.helper.spec.ts — Scheme Data-Collection (Wave-0, §13.1)
 *
 * Unit tests for the NET-NEW field types + logic added to enrollment-form.helper:
 *   EMAIL · MULTI_SELECT · TOGGLE · PHONE_OTP · LOOKUP · SECTION · SIGNATURE,
 *   plus `requiredWhen` (conditional-required) and LOOKUP server-resolution.
 *
 * Run: npx jest src/schemes/enrollment-form.wave0.helper.spec.ts
 */

import {
  validateFormSchema,
  validateSubmittedValues,
  resolveLookup,
  isFieldRequired,
  EnrollmentFormSchema,
  FormField,
} from './enrollment-form.helper';

// A field builder with sane defaults so each test only sets what it exercises.
const field = (over: Partial<FormField> & { id: string; type: FormField['type'] }): FormField => ({
  label: over.label ?? over.id,
  required: false,
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 0,
  ...over,
});

const schema = (fields: FormField[]): EnrollmentFormSchema => ({
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields,
});

const raw = (fields: unknown[]): unknown => ({ captureGpsOnSubmit: false, requireOtp: false, fields });

describe('validateFormSchema — Wave-0 field types', () => {
  it('accepts the net-new simple field types (EMAIL/TOGGLE/PHONE_OTP/SECTION/SIGNATURE)', () => {
    const errs = validateFormSchema(
      raw([
        field({ id: 'a', type: 'EMAIL', label: 'Email' }),
        field({ id: 'b', type: 'TOGGLE', label: 'Active?' }),
        field({ id: 'c', type: 'PHONE_OTP', label: 'Phone', otpRequired: true }),
        field({ id: 'd', type: 'SECTION', label: 'Section header' }),
        field({ id: 'e', type: 'SIGNATURE', label: 'Sign' }),
      ]),
    );
    expect(errs).toEqual([]);
  });

  it('requires options on MULTI_SELECT', () => {
    const errs = validateFormSchema(raw([field({ id: 'm', type: 'MULTI_SELECT', label: 'Pick' })]));
    expect(errs.some((e) => /MULTI_SELECT must have at least one option/.test(e))).toBe(true);
  });

  it('accepts MULTI_SELECT with string options', () => {
    const errs = validateFormSchema(
      raw([field({ id: 'm', type: 'MULTI_SELECT', label: 'Pick', options: ['A', 'B'] })]),
    );
    expect(errs).toEqual([]);
  });

  it('validates captureTrigger enum on GPS_POINT', () => {
    const bad = validateFormSchema(
      raw([field({ id: 'g', type: 'GPS_POINT', captureTrigger: 'NONSENSE' as never })]),
    );
    expect(bad.some((e) => /captureTrigger must be one of/.test(e))).toBe(true);
    const ok = validateFormSchema(
      raw([field({ id: 'g', type: 'GPS_POINT', captureTrigger: 'ON_PHOTO' })]),
    );
    expect(ok).toEqual([]);
  });

  it('LOOKUP requires a resolvable source field id + non-empty string map', () => {
    // missing source + map
    const missing = validateFormSchema(raw([field({ id: 'l', type: 'LOOKUP', label: 'Slab' })]));
    expect(missing.some((e) => /must set lookupSourceFieldId/.test(e))).toBe(true);
    expect(missing.some((e) => /must have a non-empty lookupMap/.test(e))).toBe(true);

    // unknown source ref
    const unknown = validateFormSchema(
      raw([field({ id: 'l', type: 'LOOKUP', lookupSourceFieldId: 'ghost', lookupMap: { Gold: '5%' } })]),
    );
    expect(unknown.some((e) => /unknown source field id/.test(e))).toBe(true);

    // self ref
    const self = validateFormSchema(
      raw([field({ id: 'l', type: 'LOOKUP', lookupSourceFieldId: 'l', lookupMap: { Gold: '5%' } })]),
    );
    expect(self.some((e) => /cannot source from itself/.test(e))).toBe(true);

    // happy path
    const ok = validateFormSchema(
      raw([
        field({ id: 'tier', type: 'DROPDOWN', options: ['Gold', 'Silver'] }),
        field({ id: 'l', type: 'LOOKUP', lookupSourceFieldId: 'tier', lookupMap: { Gold: '5%', Silver: '2%' } }),
      ]),
    );
    expect(ok).toEqual([]);
  });

  it('rejects a non-string lookupMap value', () => {
    const errs = validateFormSchema(
      raw([
        field({ id: 'tier', type: 'DROPDOWN', options: ['Gold'] }),
        field({ id: 'l', type: 'LOOKUP', lookupSourceFieldId: 'tier', lookupMap: { Gold: 5 } as never }),
      ]),
    );
    expect(errs.some((e) => /all lookupMap values must be strings/.test(e))).toBe(true);
  });

  it('validates requiredWhen structure (self ref + unknown ref + op)', () => {
    const self = validateFormSchema(
      raw([field({ id: 'x', type: 'TEXT', requiredWhen: { fieldId: 'x', op: 'eq', value: '1' } })]),
    );
    expect(self.some((e) => /requiredWhen cannot depend on itself/.test(e))).toBe(true);

    const unknown = validateFormSchema(
      raw([field({ id: 'x', type: 'TEXT', requiredWhen: { fieldId: 'ghost', op: 'eq', value: '1' } })]),
    );
    expect(unknown.some((e) => /requiredWhen references unknown field id/.test(e))).toBe(true);

    const badOp = validateFormSchema(
      raw([
        field({ id: 'y', type: 'TOGGLE' }),
        field({ id: 'x', type: 'TEXT', requiredWhen: { fieldId: 'y', op: 'like' as never, value: '1' } }),
      ]),
    );
    expect(badOp.some((e) => /requiredWhen.op must be one of/.test(e))).toBe(true);
  });

  // ── A-LOW-2: a requireOtp form must carry a PHONE_OTP+otpRequired field ──────
  it('rejects a requireOtp form with no PHONE_OTP field (A-LOW-2 fail-open)', () => {
    const errs = validateFormSchema({
      captureGpsOnSubmit: false,
      requireOtp: true,
      fields: [field({ id: 't', type: 'TEXT', label: 'Name' })],
    });
    expect(errs.some((e) => /requireOtp is true but the form has no PHONE_OTP field/.test(e))).toBe(true);
  });

  it('rejects a requireOtp form whose PHONE_OTP field is not otpRequired (A-LOW-2)', () => {
    const errs = validateFormSchema({
      captureGpsOnSubmit: false,
      requireOtp: true,
      fields: [field({ id: 'ph', type: 'PHONE_OTP', label: 'Phone', otpRequired: false })],
    });
    expect(errs.some((e) => /requireOtp is true but the form has no PHONE_OTP field/.test(e))).toBe(true);
  });

  it('accepts a requireOtp form that has a PHONE_OTP+otpRequired field (A-LOW-2)', () => {
    const errs = validateFormSchema({
      captureGpsOnSubmit: false,
      requireOtp: true,
      fields: [field({ id: 'ph', type: 'PHONE_OTP', label: 'Phone', otpRequired: true })],
    });
    expect(errs).toEqual([]);
  });

  // ── captureGpsOnSubmit coherence: needs a GPS_POINT field to store the fix ────
  it('rejects captureGpsOnSubmit=true when the form has no GPS_POINT field', () => {
    const errs = validateFormSchema({
      captureGpsOnSubmit: true,
      requireOtp: false,
      fields: [field({ id: 't', type: 'TEXT', label: 'Name' })],
    });
    expect(errs.some((e) => /captureGpsOnSubmit is true but the form has no GPS_POINT field/.test(e))).toBe(true);
  });

  it('accepts captureGpsOnSubmit=true when a GPS_POINT field is present', () => {
    const errs = validateFormSchema({
      captureGpsOnSubmit: true,
      requireOtp: false,
      fields: [field({ id: 'gps', type: 'GPS_POINT', label: 'Location' })],
    });
    expect(errs).toEqual([]);
  });
});

describe('isFieldRequired — conditional-required (requiredWhen)', () => {
  const f = field({ id: 'reason', type: 'TEXT', requiredWhen: { fieldId: 'active', op: 'eq', value: 'false' } });

  it('is required only when the clause holds', () => {
    expect(isFieldRequired(f, { active: 'false' })).toBe(true);
    expect(isFieldRequired(f, { active: 'true' })).toBe(false);
  });

  it('a base-required field is always required regardless of requiredWhen', () => {
    const g = field({ id: 'x', type: 'TEXT', required: true });
    expect(isFieldRequired(g, {})).toBe(true);
  });
});

describe('resolveLookup — server resolution from the source field', () => {
  const f = field({
    id: 'slab',
    type: 'LOOKUP',
    lookupSourceFieldId: 'tier',
    lookupMap: { Gold: '5%', Silver: '2%' },
  });

  it('maps the source value through lookupMap', () => {
    expect(resolveLookup(f, { tier: 'Gold' })).toBe('5%');
  });
  it('returns null for an empty or unmapped source', () => {
    expect(resolveLookup(f, { tier: '' })).toBeNull();
    expect(resolveLookup(f, { tier: 'Bronze' })).toBeNull();
  });
});

describe('validateSubmittedValues — Wave-0 coercion + resolution', () => {
  it('SECTION is skipped (never required, never validated)', () => {
    const s = schema([field({ id: 'sec', type: 'SECTION', required: true })]);
    const { errors } = validateSubmittedValues(s, {});
    expect(errors).toEqual([]);
  });

  it('EMAIL rejects garbage, accepts a real address', () => {
    const s = schema([field({ id: 'e', type: 'EMAIL', required: true })]);
    expect(validateSubmittedValues(s, { e: 'not-an-email' }).errors.length).toBe(1);
    expect(validateSubmittedValues(s, { e: 'a@b.com' }).errors).toEqual([]);
  });

  it('TOGGLE treats false as a real answer (not empty) and accepts yes/no tokens', () => {
    const s = schema([field({ id: 't', type: 'TOGGLE', required: true })]);
    // false is a valid, present answer → no "required" error
    expect(validateSubmittedValues(s, { t: false }).errors).toEqual([]);
    expect(validateSubmittedValues(s, { t: 'no' }).errors).toEqual([]);
    // missing → required error
    expect(validateSubmittedValues(s, {}).errors.length).toBe(1);
    // garbage → invalid
    expect(validateSubmittedValues(s, { t: 'maybe' }).errors.length).toBe(1);
  });

  it('MULTI_SELECT validates each entry against options (array or comma string)', () => {
    const s = schema([field({ id: 'm', type: 'MULTI_SELECT', options: ['A', 'B', 'C'] })]);
    expect(validateSubmittedValues(s, { m: ['A', 'C'] }).errors).toEqual([]);
    expect(validateSubmittedValues(s, { m: 'A,B' }).errors).toEqual([]);
    expect(validateSubmittedValues(s, { m: ['A', 'Z'] }).errors.length).toBe(1);
  });

  it('PHONE_OTP validates the 10-digit shape (verification is service-enforced)', () => {
    const s = schema([field({ id: 'p', type: 'PHONE_OTP', required: true })]);
    expect(validateSubmittedValues(s, { p: '9900000041' }).errors).toEqual([]);
    expect(validateSubmittedValues(s, { p: '12345' }).errors.length).toBe(1);
  });

  it('requiredWhen makes a field conditionally required', () => {
    const s = schema([
      field({ id: 'active', type: 'TOGGLE' }),
      field({ id: 'reason', type: 'TEXT', requiredWhen: { fieldId: 'active', op: 'eq', value: 'false' } }),
    ]);
    // condition holds + empty → required error
    expect(validateSubmittedValues(s, { active: 'false' }).errors.length).toBe(1);
    // condition holds + provided → ok
    expect(validateSubmittedValues(s, { active: 'false', reason: 'closed' }).errors).toEqual([]);
    // condition false → not required
    expect(validateSubmittedValues(s, { active: 'true' }).errors).toEqual([]);
  });

  it('LOOKUP is server-resolved into resolvedValues, ignoring any client value', () => {
    const s = schema([
      field({ id: 'tier', type: 'DROPDOWN', options: ['Gold', 'Silver'] }),
      field({ id: 'slab', type: 'LOOKUP', lookupSourceFieldId: 'tier', lookupMap: { Gold: '5%', Silver: '2%' } }),
    ]);
    const { errors, resolvedValues } = validateSubmittedValues(s, { tier: 'Gold', slab: 'HACK-99%' });
    expect(errors).toEqual([]);
    expect(resolvedValues.slab).toBe('5%'); // server wins, client "HACK-99%" discarded
  });

  it('a field hidden by visibleWhen is never required', () => {
    const s = schema([
      field({ id: 'gate', type: 'TOGGLE' }),
      field({ id: 'x', type: 'TEXT', required: true, visibleWhen: { fieldId: 'gate', op: 'eq', value: 'true' } }),
    ]);
    // gate not "true" → x hidden → not required
    expect(validateSubmittedValues(s, { gate: 'false' }).errors).toEqual([]);
  });
});
