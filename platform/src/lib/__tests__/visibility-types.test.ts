/**
 * visibility-types.test.ts — the PURE form-logic helpers that the capture renderer +
 * the backend both enforce: isFieldVisible / isFieldRequired / orderedFields /
 * validateVisibilityValues (incl. the GPS-required + captureGpsOnSubmit integrity guard).
 */

import { describe, it, expect } from 'vitest';
import {
  isFieldVisible,
  isFieldRequired,
  orderedFields,
  validateVisibilityValues,
  formCapturesLocation,
  isResubmitCapture,
  isChangesRequested,
  hasRejectedPhoto,
  rejectedPhotoFieldIds,
  classifyVisibilityCapture,
  summarizeVisibilityCaptures,
  VISIBILITY_STATUS_WORDS,
  VISIBILITY_CAPTURE_STATUS_LABELS,
  CAPTURE_UI_STATE_LABELS,
  VISIBILITY_SUMMARY_BUCKET_LABELS,
  visibilityStatusLabel,
  captureUiStateLabel,
  reviewActionLabel,
  type SalesEligibleOutlet,
  type VisibilityFormField,
  type VisibilityFormSchema,
} from '@/lib/visibility-types';

function field(partial: Partial<VisibilityFormField> & { id: string; type: VisibilityFormField['type'] }): VisibilityFormField {
  return {
    label: partial.id,
    required: false,
    order: 0,
    ...partial,
  } as VisibilityFormField;
}

describe('isFieldVisible', () => {
  it('is visible with no visibleWhen clause', () => {
    expect(isFieldVisible(field({ id: 'a', type: 'TEXT' }), {})).toBe(true);
  });

  it('honours an eq visibleWhen clause', () => {
    const f = field({ id: 'b', type: 'TEXT', visibleWhen: { fieldId: 'kind', op: 'eq', value: 'POSM' } });
    expect(isFieldVisible(f, { kind: 'POSM' })).toBe(true);
    expect(isFieldVisible(f, { kind: 'OTHER' })).toBe(false);
    expect(isFieldVisible(f, {})).toBe(false);
  });
});

describe('formCapturesLocation (M4 geo-fence cross-check)', () => {
  const cam: VisibilityFormField = { id: 'p', type: 'CAMERA', label: 'Photo', required: true, order: 0 };
  const gps: VisibilityFormField = { id: 'g', type: 'GPS_POINT', label: 'Loc', required: false, order: 1 };

  it('true when captureGpsOnSubmit is on', () => {
    expect(formCapturesLocation({ captureGpsOnSubmit: true, fields: [cam] })).toBe(true);
  });
  it('true when a GPS_POINT field exists', () => {
    expect(formCapturesLocation({ captureGpsOnSubmit: false, fields: [cam, gps] })).toBe(true);
  });
  it('false when neither (camera-only form defeats the geo-fence)', () => {
    expect(formCapturesLocation({ captureGpsOnSubmit: false, fields: [cam] })).toBe(false);
  });
  it('false for a null/undefined schema', () => {
    expect(formCapturesLocation(null)).toBe(false);
    expect(formCapturesLocation(undefined)).toBe(false);
  });
});

describe('isResubmitCapture (M3 rejected-then-late routing)', () => {
  const base: Pick<SalesEligibleOutlet, 'status' | 'captureId' | 'windowState'> = {
    status: null, captureId: null, windowState: 'due',
  };

  it('true for a REJECTED status with a captureId (window still open)', () => {
    expect(isResubmitCapture({ ...base, status: 'REJECTED', captureId: 'c1', windowState: 'rejected' })).toBe(true);
  });
  it('true for a REJECTED status that has since gone LATE (the collision case)', () => {
    // windowState flips to 'late' but the row is still REJECTED → must resubmit, not submit.
    expect(isResubmitCapture({ ...base, status: 'REJECTED', captureId: 'c1', windowState: 'late' })).toBe(true);
  });
  it('false without a captureId even if windowState is rejected/late', () => {
    expect(isResubmitCapture({ ...base, status: null, captureId: null, windowState: 'late' })).toBe(false);
  });
  it('false for a non-rejected status (e.g. a late-but-never-captured window)', () => {
    expect(isResubmitCapture({ ...base, status: 'APPROVED', captureId: 'c1', windowState: 'approved' })).toBe(false);
  });
  it('falls back to windowState∈{rejected,late}+captureId when status is absent', () => {
    expect(isResubmitCapture({ ...base, status: null, captureId: 'c1', windowState: 'rejected' })).toBe(true);
    expect(isResubmitCapture({ ...base, status: null, captureId: 'c1', windowState: 'late' })).toBe(true);
    expect(isResubmitCapture({ ...base, status: null, captureId: 'c1', windowState: 'due' })).toBe(false);
  });

  it('true for a CHANGES_REQUESTED status with a captureId (per-photo re-capture)', () => {
    expect(isResubmitCapture({ ...base, status: 'CHANGES_REQUESTED', captureId: 'c1', windowState: 'changes_requested' })).toBe(true);
    // robust even if the backend reuses windowState 'rejected' for a CHANGES_REQUESTED row
    expect(isResubmitCapture({ ...base, status: 'CHANGES_REQUESTED', captureId: 'c1', windowState: 'rejected' })).toBe(true);
  });
  it('falls back to windowState changes_requested + captureId when status is absent', () => {
    expect(isResubmitCapture({ ...base, status: null, captureId: 'c1', windowState: 'changes_requested' })).toBe(true);
  });
});

describe('isChangesRequested / per-photo review helpers', () => {
  it('detects CHANGES_REQUESTED via status OR windowState', () => {
    expect(isChangesRequested({ status: 'CHANGES_REQUESTED' })).toBe(true);
    expect(isChangesRequested({ windowState: 'changes_requested' })).toBe(true);
    expect(isChangesRequested({ status: 'REJECTED', windowState: 'rejected' })).toBe(false);
    expect(isChangesRequested({})).toBe(false);
  });

  it('hasRejectedPhoto / rejectedPhotoFieldIds read the review map', () => {
    const reviews = {
      a: { status: 'APPROVED' as const, reviewedAt: 'x', reviewedByUserId: 'g' },
      b: { status: 'REJECTED' as const, reasonCode: 'BLURRY' as const, reviewedAt: 'x', reviewedByUserId: 'g' },
    };
    expect(hasRejectedPhoto(reviews)).toBe(true);
    expect(rejectedPhotoFieldIds(reviews)).toEqual(['b']);
    expect(hasRejectedPhoto(null)).toBe(false);
    expect(hasRejectedPhoto(undefined)).toBe(false);
    expect(rejectedPhotoFieldIds({ a: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'g' } })).toEqual([]);
  });
});

describe('isFieldRequired', () => {
  it('required:true is always required', () => {
    expect(isFieldRequired(field({ id: 'a', type: 'TEXT', required: true }), {})).toBe(true);
  });

  it('requiredWhen makes a field conditionally required', () => {
    const f = field({ id: 'note', type: 'TEXT', requiredWhen: { fieldId: 'ok', op: 'eq', value: 'no' } });
    expect(isFieldRequired(f, { ok: 'no' })).toBe(true);
    expect(isFieldRequired(f, { ok: 'yes' })).toBe(false);
  });
});

describe('orderedFields', () => {
  it('sorts by order', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        field({ id: 'z', type: 'TEXT', order: 3 }),
        field({ id: 'a', type: 'TEXT', order: 1 }),
        field({ id: 'm', type: 'TEXT', order: 2 }),
      ],
    };
    expect(orderedFields(schema).map((f) => f.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('validateVisibilityValues', () => {
  it('passes a valid camera + gps capture', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: true,
      fields: [
        field({ id: 'photo', type: 'CAMERA', required: true }),
        field({ id: 'geo', type: 'GPS_POINT', required: true }),
      ],
    };
    const { errors } = validateVisibilityValues(schema, {
      photo: 'visibility-media/c1/x.jpg',
      geo: { lat: 1, lng: 2 },
    });
    expect(errors).toEqual([]);
  });

  it('flags a missing required field', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [field({ id: 'photo', type: 'CAMERA', required: true, label: 'Store photo' })],
    };
    const { errors } = validateVisibilityValues(schema, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Store photo.*required/i);
  });

  it('flags a required GPS field left empty', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        field({ id: 'photo', type: 'CAMERA', required: true }),
        field({ id: 'geo', type: 'GPS_POINT', required: true, label: 'Location' }),
      ],
    };
    const { errors } = validateVisibilityValues(schema, { photo: 'k' });
    expect(errors.some((e) => /Location.*required/i.test(e))).toBe(true);
  });

  it('flags captureGpsOnSubmit with no GPS_POINT field (schema-integrity guard)', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: true,
      fields: [field({ id: 'photo', type: 'CAMERA', required: true })],
    };
    const { errors } = validateVisibilityValues(schema, { photo: 'k' });
    expect(errors.some((e) => /no GPS location field/i.test(e))).toBe(true);
  });

  it('does not require a field hidden by visibleWhen', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        field({ id: 'kind', type: 'DROPDOWN', options: ['A', 'B'] }),
        field({
          id: 'detail',
          type: 'TEXT',
          required: true,
          label: 'Detail',
          visibleWhen: { fieldId: 'kind', op: 'eq', value: 'B' },
        }),
      ],
    };
    // kind !== 'B' → detail hidden → not required
    expect(validateVisibilityValues(schema, { kind: 'A' }).errors).toEqual([]);
    // kind === 'B' → detail visible + empty → required error
    expect(validateVisibilityValues(schema, { kind: 'B' }).errors.some((e) => /Detail.*required/i.test(e))).toBe(true);
  });

  it('validates NUMBER + DROPDOWN value types', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        field({ id: 'n', type: 'NUMBER', label: 'Count' }),
        field({ id: 'd', type: 'DROPDOWN', label: 'Grade', options: ['GOOD', 'BAD'] }),
      ],
    };
    expect(validateVisibilityValues(schema, { n: 'abc', d: 'GOOD' }).errors.some((e) => /Count.*number/i.test(e))).toBe(true);
    expect(validateVisibilityValues(schema, { n: '5', d: 'NOPE' }).errors.some((e) => /Grade.*invalid/i.test(e))).toBe(true);
    expect(validateVisibilityValues(schema, { n: '5', d: 'GOOD' }).errors).toEqual([]);
  });
});

describe('classifyVisibilityCapture (dashboard 5-status summary)', () => {
  const approved = { status: 'APPROVED' as const, reviewedAt: 't', reviewedByUserId: 'u' };
  const rejected = { status: 'REJECTED' as const, reviewedAt: 't', reviewedByUserId: 'u' };

  it('no capture → pending', () => {
    expect(classifyVisibilityCapture({ status: null })).toBe('pending');
    expect(classifyVisibilityCapture({})).toBe('pending');
  });

  it('APPROVED → approved', () => {
    expect(classifyVisibilityCapture({ status: 'APPROVED' })).toBe('approved');
  });

  it('SUBMITTED → in_review (even with a photo already approved, nothing rejected)', () => {
    expect(classifyVisibilityCapture({ status: 'SUBMITTED' })).toBe('in_review');
    expect(classifyVisibilityCapture({ status: 'SUBMITTED', photoReviews: { a: approved } })).toBe('in_review');
  });

  it('whole-capture REJECTED → rejected', () => {
    expect(classifyVisibilityCapture({ status: 'REJECTED', photoReviews: { a: rejected } })).toBe('rejected');
  });

  it('CHANGES_REQUESTED with one approved + one rejected → partial (the owner scenario)', () => {
    expect(
      classifyVisibilityCapture({ status: 'CHANGES_REQUESTED', photoReviews: { a: approved, b: rejected } }),
    ).toBe('partial');
  });

  it('CHANGES_REQUESTED with no photo approved → rejected (not partial)', () => {
    expect(
      classifyVisibilityCapture({ status: 'CHANGES_REQUESTED', photoReviews: { a: rejected } }),
    ).toBe('rejected');
    // rejected + still-pending photo (no approval yet) is also a plain rejection.
    expect(
      classifyVisibilityCapture({ status: 'CHANGES_REQUESTED', photoReviews: { b: rejected } }),
    ).toBe('rejected');
  });
});

describe('summarizeVisibilityCaptures', () => {
  const o = (status: SalesEligibleOutlet['status'], photoReviews?: SalesEligibleOutlet['photoReviews']) =>
    ({ status, photoReviews } as Pick<SalesEligibleOutlet, 'status' | 'photoReviews'>);
  const approved = { status: 'APPROVED' as const, reviewedAt: 't', reviewedByUserId: 'u' };
  const rejected = { status: 'REJECTED' as const, reviewedAt: 't', reviewedByUserId: 'u' };

  it('counts each bucket and totals them', () => {
    const counts = summarizeVisibilityCaptures([
      o('APPROVED'),
      o('APPROVED'),
      o('SUBMITTED'),
      o(null),
      o('REJECTED', { a: rejected }),
      o('CHANGES_REQUESTED', { a: approved, b: rejected }),
    ]);
    expect(counts).toEqual({ total: 6, approved: 2, partial: 1, in_review: 1, pending: 1, rejected: 1 });
  });

  it('empty list → all zero', () => {
    expect(summarizeVisibilityCaptures([])).toEqual({
      total: 0, approved: 0, partial: 0, in_review: 0, pending: 0, rejected: 0,
    });
  });
});

// ── Plain status words (owner 2026-11-20) — ONE helper for admin / sales / partner UI ──

describe('plain visibility status words', () => {
  it('maps every capture status code to the agreed words (codes unchanged)', () => {
    expect(VISIBILITY_CAPTURE_STATUS_LABELS).toEqual({
      SUBMITTED: 'Waiting for review',
      APPROVED: 'Approved',
      CHANGES_REQUESTED: 'Needs re-take',
      REJECTED: 'Rejected',
    });
    expect(VISIBILITY_STATUS_WORDS.NOT_CAPTURED).toBe('Not captured yet');
    expect(VISIBILITY_STATUS_WORDS.MISSED).toBe('Missed');
  });

  it('visibilityStatusLabel: null → Not captured yet / Missed (closed window); unknown code shown as-is', () => {
    expect(visibilityStatusLabel(null)).toBe('Not captured yet');
    expect(visibilityStatusLabel(undefined, { windowClosed: true })).toBe('Missed');
    expect(visibilityStatusLabel('APPROVED', { windowClosed: true })).toBe('Approved');
    expect(visibilityStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('UI-state labels use the same words; a CHANGES_REQUESTED status beats the backend "rejected" state', () => {
    expect(CAPTURE_UI_STATE_LABELS).toEqual({
      due: 'Not captured yet', awaiting: 'Waiting for review', approved: 'Approved',
      rejected: 'Rejected', changes_requested: 'Needs re-take', late: 'Missed',
    });
    expect(captureUiStateLabel('rejected', 'CHANGES_REQUESTED')).toBe('Needs re-take');
    expect(captureUiStateLabel('rejected', 'REJECTED')).toBe('Rejected');
  });

  it('dashboard bucket labels reuse the words', () => {
    expect(VISIBILITY_SUMMARY_BUCKET_LABELS.in_review).toBe('Waiting for review');
    expect(VISIBILITY_SUMMARY_BUCKET_LABELS.pending).toBe('Not captured yet');
    expect(VISIBILITY_SUMMARY_BUCKET_LABELS.rejected).toBe('Rejected / Needs re-take');
  });

  it('review-history action labels are plain words', () => {
    expect(reviewActionLabel({ action: 'PHOTO_REJECTED', version: 1, statusAfter: 'CHANGES_REQUESTED' })).toBe('Asked for a re-take of a photo');
    expect(reviewActionLabel({ action: 'RESUBMITTED', version: 3, statusAfter: 'SUBMITTED' })).toBe('Re-took photos (version 3)');
    expect(reviewActionLabel({ action: 'CAPTURE_APPROVED_ALL', version: 1, statusAfter: 'SUBMITTED' })).toBe('Approved all photos (still waiting for review)');
    expect(reviewActionLabel({ action: 'CHANGES_REQUESTED_RESULT', version: 1, statusAfter: 'CHANGES_REQUESTED' })).toBe('Capture moved to "Needs re-take"');
  });
});
