/**
 * Unit tests for visibility-form.helper.ts (Visibility POSM capture-form engine).
 *
 * Covers: structural validation (field shapes, camera+instruction+sample-image,
 * at-least-one-camera, GPS-required-when-captureGpsOnSubmit, clause refs), and
 * submit-time validation + projection (hidden-field drop, unknown-key drop,
 * required, type coercion).
 *
 * Run: npx jest src/visibility/visibility-form.helper.spec.ts
 */

import {
  validateFormSchema,
  validateSubmittedValues,
  evaluateVisibleWhen,
  isFieldRequired,
  MEDIA_FIELD_TYPES,
  VisibilityFormSchema,
  FormField,
} from './visibility-form.helper';

const cameraField = (over: Partial<FormField> = {}): FormField => ({
  id: 'photo',
  type: 'CAMERA',
  label: 'Shelf photo',
  required: true,
  order: 1,
  ...over,
});

const gpsField = (over: Partial<FormField> = {}): FormField => ({
  id: 'geo',
  type: 'GPS_POINT',
  label: 'Location',
  required: false,
  order: 2,
  ...over,
});

describe('validateFormSchema', () => {
  it('accepts a minimal valid form (one camera field, no gps-on-submit)', () => {
    const schema = { captureGpsOnSubmit: false, fields: [cameraField()] };
    expect(validateFormSchema(schema)).toEqual([]);
  });

  it('accepts a camera field with instruction + sampleImageKey', () => {
    const schema = {
      captureGpsOnSubmit: false,
      fields: [
        cameraField({
          instruction: 'Shoot the full shelf head-on',
          sampleImageKey: 'visibility-media/deoleo/2026-07/sample.jpg',
        }),
      ],
    };
    expect(validateFormSchema(schema)).toEqual([]);
  });

  it('rejects a non-string instruction / sampleImageKey', () => {
    const schema = {
      captureGpsOnSubmit: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: [cameraField({ instruction: 42 as any, sampleImageKey: {} as any })],
    };
    const errs = validateFormSchema(schema);
    expect(errs.some((e) => e.includes('instruction must be a string'))).toBe(true);
    expect(errs.some((e) => e.includes('sampleImageKey must be a string'))).toBe(true);
  });

  it('requires at least one CAMERA field', () => {
    const schema = {
      captureGpsOnSubmit: false,
      fields: [{ id: 't', type: 'TEXT', label: 'Notes', required: false, order: 1 }],
    };
    expect(validateFormSchema(schema)).toContain(
      'The visibility form must have at least one CAMERA (photo) field.',
    );
  });

  it('requires a GPS_POINT field when captureGpsOnSubmit is true', () => {
    const schema = { captureGpsOnSubmit: true, fields: [cameraField()] };
    const errs = validateFormSchema(schema);
    expect(errs.some((e) => e.includes('no GPS_POINT field'))).toBe(true);
  });

  it('accepts captureGpsOnSubmit:true when a GPS_POINT field is present', () => {
    const schema = { captureGpsOnSubmit: true, fields: [cameraField(), gpsField()] };
    expect(validateFormSchema(schema)).toEqual([]);
  });

  it('rejects an empty fields array', () => {
    expect(validateFormSchema({ captureGpsOnSubmit: false, fields: [] })).toContain(
      'The visibility form must have at least one field.',
    );
  });

  it('rejects a non-boolean captureGpsOnSubmit', () => {
    const schema = { captureGpsOnSubmit: 'yes', fields: [cameraField()] };
    expect(validateFormSchema(schema)).toContain('formSchema.captureGpsOnSubmit must be a boolean.');
  });

  it('rejects duplicate field ids', () => {
    const schema = {
      captureGpsOnSubmit: false,
      fields: [cameraField({ id: 'dup' }), cameraField({ id: 'dup', order: 2 })],
    };
    expect(validateFormSchema(schema).some((e) => e.includes('duplicate field id'))).toBe(true);
  });

  it('requires options on a DROPDOWN', () => {
    const schema = {
      captureGpsOnSubmit: false,
      fields: [
        cameraField(),
        { id: 'cond', type: 'DROPDOWN', label: 'Condition', required: true, order: 2 },
      ],
    };
    expect(validateFormSchema(schema).some((e) => e.includes('must have at least one option'))).toBe(
      true,
    );
  });

  it('rejects a visibleWhen clause that references an unknown / self field', () => {
    const selfRef = {
      captureGpsOnSubmit: false,
      fields: [cameraField({ visibleWhen: { fieldId: 'photo', op: 'eq', value: 'x' } })],
    };
    expect(validateFormSchema(selfRef).some((e) => e.includes('cannot depend on itself'))).toBe(true);

    const unknownRef = {
      captureGpsOnSubmit: false,
      fields: [cameraField({ visibleWhen: { fieldId: 'nope', op: 'eq', value: 'x' } })],
    };
    expect(validateFormSchema(unknownRef).some((e) => e.includes('unknown field id'))).toBe(true);
  });

  it('exposes CAMERA in MEDIA_FIELD_TYPES', () => {
    expect(MEDIA_FIELD_TYPES.has('CAMERA')).toBe(true);
    expect(MEDIA_FIELD_TYPES.has('GPS_POINT')).toBe(false);
  });
});

describe('validateSubmittedValues', () => {
  const schema: VisibilityFormSchema = {
    captureGpsOnSubmit: true,
    fields: [
      cameraField(),
      gpsField(),
      {
        id: 'cond',
        type: 'DROPDOWN',
        label: 'POSM condition',
        required: true,
        order: 3,
        options: ['Good', 'Damaged', 'Missing'],
      },
      {
        id: 'reason',
        type: 'TEXT',
        label: 'Damage reason',
        required: true,
        order: 4,
        visibleWhen: { fieldId: 'cond', op: 'eq', value: 'Damaged' },
      },
    ],
  };

  it('projects only visible, known fields (drops unknown keys)', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'visibility-media/t/a.jpg',
      geo: { lat: 1, lng: 2 },
      cond: 'Good',
      injected: 'evil',
    });
    expect(res.errors).toEqual([]);
    expect(res.values).toEqual({
      photo: 'visibility-media/t/a.jpg',
      geo: { lat: 1, lng: 2 },
      cond: 'Good',
    });
    expect('injected' in res.values).toBe(false);
    // `reason` is hidden while cond !== 'Damaged' → never persisted.
    expect('reason' in res.values).toBe(false);
  });

  it('requires a conditionally-visible field once its clause is satisfied', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'k',
      geo: { lat: 12.9, lng: 77.5 },
      cond: 'Damaged',
      // reason omitted
    });
    expect(res.errors.some((e) => e.includes('Damage reason'))).toBe(true);
  });

  it('keeps a conditionally-visible field when supplied', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'k',
      geo: { lat: 12.9, lng: 77.5 },
      cond: 'Damaged',
      reason: 'Torn banner',
    });
    expect(res.errors).toEqual([]);
    expect(res.values.reason).toBe('Torn banner');
  });

  it('flags a missing required camera field', () => {
    const res = validateSubmittedValues(schema, { geo: { lat: 12.9, lng: 77.5 }, cond: 'Good' });
    expect(res.errors.some((e) => e.includes('Shelf photo'))).toBe(true);
  });

  it('accepts a GPS_POINT value supplied as a JSON string', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'k',
      geo: JSON.stringify({ lat: 12.9, lng: 77.5 }),
      cond: 'Good',
    });
    expect(res.errors).toEqual([]);
  });

  it('rejects a present-but-unparseable GPS_POINT value (400, not a silent empty geo)', () => {
    const res = validateSubmittedValues(schema, { photo: 'k', geo: 'not-a-fix', cond: 'Good' });
    expect(res.errors.some((e) => e.includes('valid GPS location'))).toBe(true);
  });

  it('rejects an out-of-range GPS_POINT value (lat/lng outside Earth bounds)', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'k',
      geo: { lat: 999, lng: 77.5 },
      cond: 'Good',
    });
    expect(res.errors.some((e) => e.includes('valid GPS location'))).toBe(true);
  });

  it('errors on a REQUIRED but missing GPS_POINT field', () => {
    const requiredGpsSchema: VisibilityFormSchema = {
      captureGpsOnSubmit: true,
      fields: [cameraField(), gpsField({ required: true })],
    };
    const res = validateSubmittedValues(requiredGpsSchema, { photo: 'k' /* geo omitted */ });
    expect(res.errors.some((e) => e.includes('Location') && e.includes('required'))).toBe(true);
  });

  it('rejects an out-of-list dropdown selection', () => {
    const res = validateSubmittedValues(schema, {
      photo: 'k',
      geo: { lat: 12.9, lng: 77.5 },
      cond: 'Sideways',
    });
    expect(res.errors.some((e) => e.includes('invalid selection'))).toBe(true);
  });

  it('evaluateVisibleWhen + isFieldRequired agree with the projection', () => {
    const reason = schema.fields[3];
    expect(evaluateVisibleWhen(reason, { cond: 'Good' })).toBe(false);
    expect(evaluateVisibleWhen(reason, { cond: 'Damaged' })).toBe(true);
    expect(isFieldRequired(reason, { cond: 'Damaged' })).toBe(true);
  });
});
