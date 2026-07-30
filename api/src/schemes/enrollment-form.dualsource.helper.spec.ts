/**
 * enrollment-form.dualsource.helper.spec.ts — Scheme UX-hardening Wave 0.
 *
 * Covers the new dual-source prefill contract + must-fixes on the pure helpers:
 *   • collectPrefillKeys includes dataDisplayKey (H2 — DATA_DISPLAY no longer stripped)
 *   • applyPrefillPins dual-source precedence (outletField wins → Excel column → graceful blank)
 *   • collectOutletFieldKeys / pickBoundOutletFields projection (data minimisation)
 *   • validateFormSchema: outletField ∈ catalog, gpsMaxAccuracy positive, audience dropped
 *   • validateSubmittedValues: GPS accuracy cap (D15) — opt-in, only when reported
 */
import {
  applyPrefillPins,
  collectOutletFieldKeys,
  collectPrefillKeys,
  pickBoundOutletFields,
  validateFormSchema,
  validateSubmittedValues,
  EnrollmentFormSchema,
  FormField,
} from './enrollment-form.helper';

const field = (over: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({
  label: over.label ?? 'L',
  required: false,
  order: 1,
  ...over,
});

const schemaOf = (fields: FormField[]): EnrollmentFormSchema => ({
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields,
});

describe('collectPrefillKeys (H2)', () => {
  it('collects both prefillKey and dataDisplayKey columns', () => {
    const schema = schemaOf([
      field({ id: 'a', type: 'TEXT', prefillKey: 'owner_phone' }),
      field({ id: 'b', type: 'DATA_DISPLAY', dataDisplayKey: 'last_month_sales' }),
      field({ id: 'c', type: 'TEXT' }),
    ]);
    const keys = collectPrefillKeys(schema);
    expect([...keys].sort()).toEqual(['last_month_sales', 'owner_phone']);
  });
});

describe('applyPrefillPins — dual source (D13)', () => {
  const lockedField = field({
    id: 'name',
    type: 'TEXT',
    locked: true,
    outletField: 'ownerName',
    prefillKey: 'owner_col',
  });
  const schema = schemaOf([lockedField]);

  it('outletField (matched-outlet DB value) wins over the Excel column', () => {
    const out = applyPrefillPins(schema, { name: 'typed' }, { owner_col: 'Excel' }, { ownerName: 'DB' });
    expect(out.name).toBe('DB');
  });

  it('falls back to the Excel column when the outlet value is absent', () => {
    const out = applyPrefillPins(schema, { name: 'typed' }, { owner_col: 'Excel' }, {});
    expect(out.name).toBe('Excel');
  });

  it('does not pin (keeps the submitted value) when neither source carries a value', () => {
    const out = applyPrefillPins(schema, { name: 'typed' }, {}, {});
    expect(out.name).toBe('typed');
  });

  it('uses only the Excel column for a locked field with no outletField', () => {
    const s = schemaOf([field({ id: 'x', type: 'TEXT', locked: true, prefillKey: 'col' })]);
    const out = applyPrefillPins(s, { x: 'typed' }, { col: 'ExcelVal' }, { ownerName: 'irrelevant' });
    expect(out.x).toBe('ExcelVal');
  });
});

describe('collectOutletFieldKeys / pickBoundOutletFields', () => {
  const schema = schemaOf([
    field({ id: 'a', type: 'TEXT', outletField: 'ownerName' }),
    field({ id: 'b', type: 'TEXT', outletField: 'panNumber' }),
    field({ id: 'c', type: 'TEXT' }),
  ]);

  it('collects the bound outlet-field keys', () => {
    expect([...collectOutletFieldKeys(schema)].sort()).toEqual(['ownerName', 'panNumber']);
  });

  it('projects a resolved map to ONLY the bound outlet fields (data minimisation)', () => {
    const projected = pickBoundOutletFields(
      { ownerName: 'Asha', panNumber: 'ABCDE1234F', gstNumber: 'SECRET', phone: '9812300000' },
      schema,
    );
    expect(projected).toEqual({ ownerName: 'Asha', panNumber: 'ABCDE1234F' });
  });

  it('returns null when the form binds no outlet fields', () => {
    expect(pickBoundOutletFields({ ownerName: 'x' }, schemaOf([field({ id: 'z', type: 'TEXT' })]))).toBeNull();
  });
});

describe('validateFormSchema — outletField + gpsMaxAccuracy + dropped audience', () => {
  it('accepts a valid outletField from the catalog', () => {
    const errors = validateFormSchema(schemaOf([field({ id: 'a', type: 'TEXT', outletField: 'ownerName' })]));
    expect(errors).toEqual([]);
  });

  it('rejects an unknown outletField', () => {
    const errors = validateFormSchema(schemaOf([field({ id: 'a', type: 'TEXT', outletField: 'not_a_field' })]));
    expect(errors.some((e) => e.includes('outletField must be one of'))).toBe(true);
  });

  it('rejects a non-positive gpsMaxAccuracy', () => {
    const errors = validateFormSchema(
      schemaOf([field({ id: 'g', type: 'GPS_POINT', gpsMaxAccuracy: -5 } as Partial<FormField> & Pick<FormField, 'id' | 'type'>)]),
    );
    expect(errors.some((e) => e.includes('gpsMaxAccuracy must be a positive number'))).toBe(true);
  });

  it('no longer validates a per-field audience (dropped) — a stray value is simply ignored', () => {
    const errors = validateFormSchema(
      schemaOf([{ ...field({ id: 'a', type: 'TEXT' }), audience: 'NONSENSE' } as unknown as FormField]),
    );
    expect(errors).toEqual([]);
  });
});

describe('validateSubmittedValues — GPS accuracy cap (D15)', () => {
  const schema = schemaOf([field({ id: 'g', type: 'GPS_POINT', gpsMaxAccuracy: 50 } as Partial<FormField> & Pick<FormField, 'id' | 'type'>)]);

  it('rejects a fix whose reported accuracy exceeds the cap', () => {
    const { errors } = validateSubmittedValues(schema, { g: { lat: 12.9, lng: 77.6, accuracy: 120 } });
    expect(errors.some((e) => e.includes('accuracy'))).toBe(true);
  });

  it('accepts a fix within the cap', () => {
    const { errors } = validateSubmittedValues(schema, { g: { lat: 12.9, lng: 77.6, accuracy: 30 } });
    expect(errors).toEqual([]);
  });

  it('accepts a fix with no reported accuracy (cannot prove it fails — opt-in)', () => {
    const { errors } = validateSubmittedValues(schema, { g: { lat: 12.9, lng: 77.6 } });
    expect(errors).toEqual([]);
  });
});
