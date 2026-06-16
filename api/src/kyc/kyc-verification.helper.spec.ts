// Unit tests for the Stage-2 verification bridge (reconcile §5).
// Pure logic — shared by the bulk-commit (Lane A) and portal (Lane B) paths.

import { KycFieldDecision, KycFieldKey } from '@prisma/client';
import {
  evaluateSubmission,
  KYC_FIELD_KEYS,
  KYC_FIELD_COUNT,
  VerificationDecisionLike,
} from './kyc-verification.helper';

const item = (fieldKey: KycFieldKey, decision: KycFieldDecision): VerificationDecisionLike => ({
  fieldKey,
  decision,
});

/** All 7 fields with the same decision. */
const allWith = (decision: KycFieldDecision): VerificationDecisionLike[] =>
  KYC_FIELD_KEYS.map((k) => item(k, decision));

describe('evaluateSubmission (Stage-2 bridge)', () => {
  it('exposes exactly the 7 canonical field keys', () => {
    expect(KYC_FIELD_COUNT).toBe(7);
    expect(KYC_FIELD_KEYS).toEqual([
      'PAYMENT',
      'GST_VALIDATION',
      'GST_DOCUMENT',
      'ADDRESS',
      'ADDRESS_DOCUMENT',
      'BOARD_PHOTO',
      'OWNER_PHOTO',
    ]);
  });

  it('all 7 APPROVED → APPROVED, 7 of 7, no rejected fields', () => {
    const r = evaluateSubmission(allWith('APPROVED'));
    expect(r.next).toBe('APPROVED');
    expect(r.approvedCount).toBe(7);
    expect(r.rejectedFields).toEqual([]);
  });

  it('empty grid → PENDING_GIFSY, 0 of 7', () => {
    const r = evaluateSubmission([]);
    expect(r.next).toBe('PENDING_GIFSY');
    expect(r.approvedCount).toBe(0);
  });

  it('6 approved + 1 still pending → PENDING_GIFSY, 6 of 7', () => {
    const items = allWith('APPROVED').map((it, i) =>
      i === 6 ? item(it.fieldKey, 'PENDING') : it,
    );
    const r = evaluateSubmission(items);
    expect(r.next).toBe('PENDING_GIFSY');
    expect(r.approvedCount).toBe(6);
  });

  it('missing rows count as PENDING (partial grid stays PENDING_GIFSY)', () => {
    const r = evaluateSubmission([item('PAYMENT', 'APPROVED'), item('ADDRESS', 'APPROVED')]);
    expect(r.next).toBe('PENDING_GIFSY');
    expect(r.approvedCount).toBe(2);
  });

  it('all 7 terminal with 1 REJECTED → RE_UPLOAD_REQUIRED naming that field', () => {
    const items = allWith('APPROVED').map((it) =>
      it.fieldKey === 'OWNER_PHOTO' ? item(it.fieldKey, 'REJECTED') : it,
    );
    const r = evaluateSubmission(items);
    expect(r.next).toBe('RE_UPLOAD_REQUIRED');
    expect(r.rejectedFields).toEqual(['OWNER_PHOTO']);
    expect(r.approvedCount).toBe(6);
  });

  it('all 7 terminal with multiple REJECTED → all named, in canonical order', () => {
    const items = KYC_FIELD_KEYS.map((k) =>
      k === 'PAYMENT' || k === 'GST_VALIDATION' ? item(k, 'REJECTED') : item(k, 'APPROVED'),
    );
    const r = evaluateSubmission(items);
    expect(r.next).toBe('RE_UPLOAD_REQUIRED');
    expect(r.rejectedFields).toEqual(['PAYMENT', 'GST_VALIDATION']);
    expect(r.approvedCount).toBe(5);
  });

  it('a REJECTED among still-PENDING fields holds at PENDING_GIFSY (waits for all terminal)', () => {
    const items = [
      item('PAYMENT', 'REJECTED'),
      item('GST_VALIDATION', 'APPROVED'),
      // remaining 5 fields absent → PENDING
    ];
    const r = evaluateSubmission(items);
    expect(r.next).toBe('PENDING_GIFSY');
    expect(r.rejectedFields).toEqual([]); // not surfaced until the grid is complete
    expect(r.approvedCount).toBe(1);
  });

  it('duplicate rows for a field: last decision wins', () => {
    const items = [...allWith('APPROVED'), item('PAYMENT', 'REJECTED')];
    const r = evaluateSubmission(items);
    expect(r.next).toBe('RE_UPLOAD_REQUIRED');
    expect(r.rejectedFields).toEqual(['PAYMENT']);
  });
});
