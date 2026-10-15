// Unit tests for the Stage-2 verification bridge (reconcile §5).
// Pure logic — shared by the bulk-commit (Lane A) and portal (Lane B) paths.

import { KycFieldDecision, KycFieldKey } from '@prisma/client';
import {
  evaluateSubmission,
  requiredFieldKeys,
  SO_DECLARATION_FIELD_KEYS,
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

  it('all 7 REJECTED → RE_UPLOAD_REQUIRED, every field named in canonical order, 0 approved', () => {
    const r = evaluateSubmission(allWith('REJECTED'));
    expect(r.next).toBe('RE_UPLOAD_REQUIRED');
    expect(r.approvedCount).toBe(0);
    expect(r.rejectedFields).toEqual(KYC_FIELD_KEYS);
  });

  it('ignores unknown field keys and extra rows (cannot corrupt the verdict)', () => {
    const items: VerificationDecisionLike[] = [
      ...allWith('APPROVED'),
      { fieldKey: 'NOT_A_REAL_FIELD' as KycFieldKey, decision: 'REJECTED' },
    ];
    const r = evaluateSubmission(items);
    expect(r.next).toBe('APPROVED');
    expect(r.approvedCount).toBe(7);
    expect(r.rejectedFields).toEqual([]);
  });

  it('rejectedFields order is independent of input order', () => {
    const forward = evaluateSubmission([
      item('PAYMENT', 'REJECTED'),
      item('ADDRESS', 'REJECTED'),
      ...KYC_FIELD_KEYS.filter((k) => k !== 'PAYMENT' && k !== 'ADDRESS').map((k) =>
        item(k, 'APPROVED'),
      ),
    ]);
    const reversed = evaluateSubmission([
      item('ADDRESS', 'REJECTED'),
      item('PAYMENT', 'REJECTED'),
      ...KYC_FIELD_KEYS.filter((k) => k !== 'PAYMENT' && k !== 'ADDRESS').map((k) =>
        item(k, 'APPROVED'),
      ),
    ]);
    expect(forward.rejectedFields).toEqual(['PAYMENT', 'ADDRESS']);
    expect(reversed.rejectedFields).toEqual(['PAYMENT', 'ADDRESS']);
  });
});

describe('requiredFieldKeys (SO Declaration variant)', () => {
  it('STANDARD (and omitted/null) → all 7 canonical keys, unchanged', () => {
    expect(requiredFieldKeys({ kycVariant: 'STANDARD' })).toEqual(KYC_FIELD_KEYS);
    expect(requiredFieldKeys(null)).toEqual(KYC_FIELD_KEYS);
    expect(requiredFieldKeys(undefined)).toEqual(KYC_FIELD_KEYS);
    expect(requiredFieldKeys({})).toEqual(KYC_FIELD_KEYS);
  });

  it('SO_DECLARATION → only the 4 blocking keys (GST/doc keys non-blocking)', () => {
    expect(requiredFieldKeys({ kycVariant: 'SO_DECLARATION' })).toEqual([
      'PAYMENT',
      'ADDRESS',
      'BOARD_PHOTO',
      'OWNER_PHOTO',
    ]);
    expect(SO_DECLARATION_FIELD_KEYS).not.toContain('GST_VALIDATION');
    expect(SO_DECLARATION_FIELD_KEYS).not.toContain('GST_DOCUMENT');
    expect(SO_DECLARATION_FIELD_KEYS).not.toContain('ADDRESS_DOCUMENT');
  });
});

describe('evaluateSubmission — SO Declaration variant', () => {
  const soDecl = { kycVariant: 'SO_DECLARATION' as const };

  it('APPROVES when the 4 required keys are APPROVED even if the GST/address-doc keys are ABSENT', () => {
    const items = SO_DECLARATION_FIELD_KEYS.map((k) => item(k, 'APPROVED'));
    const r = evaluateSubmission(items, soDecl);
    expect(r.next).toBe('APPROVED');
    expect(r.approvedCount).toBe(4);
  });

  it('a REJECTED optional GST doc is NON-BLOCKING (still approves on the 4 required)', () => {
    const items = [
      ...SO_DECLARATION_FIELD_KEYS.map((k) => item(k, 'APPROVED')),
      item('GST_DOCUMENT', 'REJECTED'),
      item('ADDRESS_DOCUMENT', 'REJECTED'),
    ];
    expect(evaluateSubmission(items, soDecl).next).toBe('APPROVED');
  });

  it('a PENDING REQUIRED key still holds at PENDING_GIFSY', () => {
    const items = [
      item('PAYMENT', 'APPROVED'),
      item('ADDRESS', 'APPROVED'),
      item('BOARD_PHOTO', 'APPROVED'),
      item('OWNER_PHOTO', 'PENDING'),
    ];
    expect(evaluateSubmission(items, soDecl).next).toBe('PENDING_GIFSY');
  });

  it('a REJECTED required key → RE_UPLOAD_REQUIRED (only the required one surfaces)', () => {
    const items = [
      item('PAYMENT', 'REJECTED'),
      item('ADDRESS', 'APPROVED'),
      item('BOARD_PHOTO', 'APPROVED'),
      item('OWNER_PHOTO', 'APPROVED'),
      item('GST_DOCUMENT', 'REJECTED'),
    ];
    const r = evaluateSubmission(items, soDecl);
    expect(r.next).toBe('RE_UPLOAD_REQUIRED');
    expect(r.rejectedFields).toEqual(['PAYMENT']);
  });

  it('REGRESSION: STANDARD still blocks on a missing GST key (byte-identical)', () => {
    const items = KYC_FIELD_KEYS.filter((k) => k !== 'GST_DOCUMENT').map((k) => item(k, 'APPROVED'));
    expect(evaluateSubmission(items, { kycVariant: 'STANDARD' }).next).toBe('PENDING_GIFSY');
    // and with no submission arg at all (legacy callers) it must also stay STANDARD
    expect(evaluateSubmission(items).next).toBe('PENDING_GIFSY');
  });
});
