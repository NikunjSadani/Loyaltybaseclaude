import {
  CLEAR_BANK_RAIL,
  type PayoutField,
  carriesBothPayoutRails,
  effectiveProposedPayout,
  incompletePayoutRailMessage,
  isCompletePayoutRail,
  isPayoutFieldEditable,
  isPayoutRailCompleteForSubmission,
  isPayoutRailReachable,
  livePayoutRail,
  missingEditablePayoutRoutingFields,
  payoutFieldEditability,
  payoutRailFor,
  resolveProposedPayoutRail,
  resolveReKycPayout,
  resolveReKycPayoutRail,
  resolveUpiCaptureMethod,
} from './payout-rail.helper';

describe('payout-rail.helper', () => {
  describe('R4a — a COMPLETE rail: UPI = upiId; BANK = account number AND IFSC', () => {
    it('isCompletePayoutRail: bank needs BOTH account + IFSC; upi needs a upiId; blanks are absent', () => {
      expect(isCompletePayoutRail('bank', { accountNumber: '123', ifscCode: 'HDFC0001' })).toBe(true);
      expect(isCompletePayoutRail('bank', { accountNumber: '123' })).toBe(false);
      expect(isCompletePayoutRail('bank', { ifscCode: 'HDFC0001' })).toBe(false);
      expect(isCompletePayoutRail('bank', { accountNumber: '123', ifscCode: '  ' })).toBe(false);
      expect(isCompletePayoutRail('upi', { upiId: 'a@upi' })).toBe(true);
      expect(isCompletePayoutRail('upi', { upiId: ' ' })).toBe(false);
    });

    it('carriesBothPayoutRails: only a complete UPI AND a complete bank rail', () => {
      expect(carriesBothPayoutRails({ upiId: 'a@upi', ifscCode: 'I' })).toBe(false);
      expect(carriesBothPayoutRails({ upiId: 'a@upi', accountNumber: '123' })).toBe(false); // no IFSC
      expect(carriesBothPayoutRails({ upiId: 'a@upi', accountNumber: '  ', ifscCode: 'I' })).toBe(false);
      expect(carriesBothPayoutRails({ upiId: ' ', accountNumber: '123', ifscCode: 'I' })).toBe(false);
      expect(carriesBothPayoutRails({ upiId: 'a@upi', accountNumber: '123', ifscCode: 'I' })).toBe(true);
    });

    it('payoutRailFor: the mode only when its rail is complete, else undefined', () => {
      expect(payoutRailFor('bank', { accountNumber: '123', ifscCode: 'I' })).toBe('bank');
      expect(payoutRailFor('bank', { accountNumber: '123' })).toBeUndefined();
      expect(payoutRailFor('bank', { accountNumber: '', ifscCode: 'I' })).toBeUndefined();
      expect(payoutRailFor('upi', { upiId: 'a@upi' })).toBe('upi');
      expect(payoutRailFor('upi', { upiId: '  ' })).toBeUndefined();
      expect(payoutRailFor(undefined, { upiId: 'a@upi', accountNumber: '1', ifscCode: 'I' })).toBeUndefined();
    });

    it('CLEAR_BANK_RAIL never nulls the cheque evidence key (F6)', () => {
      expect('payoutChequeFileKey' in CLEAR_BANK_RAIL).toBe(false);
    });
  });

  describe('resolveProposedPayoutRail — explicit only, never inferred (F1)', () => {
    it('returns the staged payoutRail', () => {
      expect(resolveProposedPayoutRail({ payoutRail: 'upi' })).toBe('upi');
      expect(resolveProposedPayoutRail({ payoutRail: 'bank' })).toBe('bank');
    });
    it('a legacy proposal (no payoutRail) with a mode + filled rail infers NOTHING', () => {
      expect(resolveProposedPayoutRail({ paymentMode: 'upi', upiId: 'a@upi' })).toBeNull();
      expect(resolveProposedPayoutRail({ paymentMode: 'bank', bankAccountNumber: '1' })).toBeNull();
    });
  });

  describe('effectiveProposedPayout', () => {
    it('new draft with a COMPLETE payoutRail → proposal unchanged + the OTHER rail cleared', () => {
      const r = effectiveProposedPayout(
        { payoutRail: 'bank', bankAccountNumber: '1', ifscCode: 'HDFC0001' },
        { accountNumber: true, ifscCode: true },
      );
      expect(r.rail).toBe('bank');
      expect(r.clears).toEqual({ upiId: null, upiCaptureMethod: null });
      expect(r.proposal.bankAccountNumber).toBe('1');
    });

    it('R4a: an explicit payoutRail whose staged rail is INCOMPLETE sets nothing and clears nothing', () => {
      const bank = effectiveProposedPayout({ payoutRail: 'bank', bankAccountNumber: '1' }, null);
      expect(bank.rail).toBeNull();
      expect(bank.clears).toEqual({});
      const upi = effectiveProposedPayout({ payoutRail: 'upi', upiId: '  ' }, null);
      expect(upi.rail).toBeNull();
      expect(upi.clears).toEqual({});
    });

    it('legacy draft + field flags → only payout keys whose own flag is true survive; nothing cleared', () => {
      const r = effectiveProposedPayout(
        { gstNumber: 'G', paymentMode: 'upi', upiId: 'a@upi', bankName: 'B', bankAccountNumber: '1', ifscCode: 'I', bankAccountHolder: 'H' },
        { upiId: true, gstNumber: true },
      );
      expect(r.rail).toBeNull();
      expect(r.clears).toEqual({});
      expect(r.proposal).toEqual({ gstNumber: 'G', paymentMode: 'upi', upiId: 'a@upi' });
    });

    it('legacy draft + NO payout flag → every payout key (incl. paymentMode) dropped', () => {
      const r = effectiveProposedPayout({ gstNumber: 'G', paymentMode: 'bank', bankAccountNumber: '1' }, { gstNumber: true });
      expect(r.proposal).toEqual({ gstNumber: 'G' });
    });

    it('legacy draft + no field flags (blanket / unknown) → passes through unchanged (pre-change write-back)', () => {
      const proposed = { paymentMode: 'upi', upiId: 'a@upi', bankAccountNumber: '1' };
      for (const flags of [null, undefined, {}, { remarks: 'x' }]) {
        const r = effectiveProposedPayout(proposed, flags);
        expect(r.proposal).toBe(proposed);
        expect(r.clears).toEqual({});
        expect(r.rail).toBeNull();
      }
    });
  });

  describe('re-KYC rail rules — never reject what the rep cannot fix', () => {
    const editableOnly = (...fields: PayoutField[]) => (f: PayoutField) => fields.includes(f);
    const all = () => true;

    it('isPayoutFieldEditable: brand-new / blanket → every field; flagged → only flagged fields', () => {
      expect(isPayoutFieldEditable('upiId', true, { gstNumber: true })).toBe(true);
      for (const flags of [null, undefined, {}, { remarks: 'x' }]) {
        expect(isPayoutFieldEditable('ifscCode', false, flags)).toBe(true);
      }
      expect(isPayoutFieldEditable('upiId', false, { upiId: true })).toBe(true);
      expect(isPayoutFieldEditable('ifscCode', false, { upiId: true })).toBe(false);
      expect(payoutFieldEditability(false, { accountNumber: true })('accountNumber')).toBe(true);
      expect(payoutFieldEditability(false, { accountNumber: true })('ifscCode')).toBe(false);
    });

    it('isPayoutRailReachable: each routing field editable OR stored non-empty', () => {
      expect(isPayoutRailReachable('upi', editableOnly('upiId'), {})).toBe(true);
      expect(isPayoutRailReachable('upi', editableOnly(), { upiId: 'a@upi' })).toBe(true);
      expect(isPayoutRailReachable('upi', editableOnly(), { upiId: '  ' })).toBe(false);
      expect(isPayoutRailReachable('bank', editableOnly('accountNumber'), { ifscCode: 'I' })).toBe(true);
      expect(isPayoutRailReachable('bank', editableOnly('accountNumber'), {})).toBe(false);
      expect(isPayoutRailReachable('bank', editableOnly('bankName'), { accountNumber: '1', ifscCode: 'I' })).toBe(true);
      expect(isPayoutRailReachable('bank', all, {})).toBe(true);
    });

    it('isPayoutRailCompleteForSubmission: submitted for editable fields, stored for locked ones', () => {
      // locked IFSC → the stored one counts; a submitted IFSC on a locked field is ignored
      expect(isPayoutRailCompleteForSubmission('bank', editableOnly('accountNumber'), { accountNumber: '2' }, { ifscCode: 'I' })).toBe(true);
      expect(isPayoutRailCompleteForSubmission('bank', editableOnly('accountNumber'), { accountNumber: '2', ifscCode: 'X' }, {})).toBe(false);
      // editable field submitted empty → incomplete even when a stored value exists
      expect(isPayoutRailCompleteForSubmission('upi', all, { upiId: '' }, { upiId: 'old@upi' })).toBe(false);
      expect(isPayoutRailCompleteForSubmission('upi', editableOnly(), {}, { upiId: 'old@upi' })).toBe(true);
    });

    it('livePayoutRail: UPI first, then a COMPLETE bank rail, else null', () => {
      expect(livePayoutRail({ upiId: 'a@upi', accountNumber: '1', ifscCode: 'I' })).toBe('upi');
      expect(livePayoutRail({ accountNumber: '1', ifscCode: 'I' })).toBe('bank');
      expect(livePayoutRail({ accountNumber: '1' })).toBeNull();
      expect(livePayoutRail({ upiId: ' ' })).toBeNull();
    });

    it('incompletePayoutRailMessage names only the missing editable field(s)', () => {
      expect(incompletePayoutRailMessage('upi', ['upiId'])).toBe('Enter a UPI ID');
      expect(incompletePayoutRailMessage('bank', ['accountNumber', 'ifscCode'])).toBe('Enter both account number and IFSC');
      expect(incompletePayoutRailMessage('bank', ['accountNumber'])).toBe('Enter the account number');
      expect(incompletePayoutRailMessage('bank', ['ifscCode'])).toBe('Enter the IFSC');
      expect(missingEditablePayoutRoutingFields('bank', editableOnly('ifscCode'), {})).toEqual(['ifscCode']);
    });

    const base = {
      mandateMode: null,
      isRailAllowed: () => true,
    } as const;

    it('resolveReKycPayoutRail: requested usable rail wins; else live rail (when permitted); else null', () => {
      const stored = { accountNumber: '1', ifscCode: 'I' };
      expect(resolveReKycPayoutRail({ ...base, requestedMode: 'upi', editable: editableOnly('upiId'), stored })).toBe('upi');
      // upi unreachable (not editable, not stored) → live bank
      expect(resolveReKycPayoutRail({ ...base, requestedMode: 'upi', editable: editableOnly(), stored })).toBe('bank');
      // forbidden by the mandate / tenant gate → live bank
      expect(
        resolveReKycPayoutRail({ ...base, requestedMode: 'upi', isRailAllowed: (r) => r === 'bank', editable: all, stored }),
      ).toBe('bank');
      // no mode sent → the mandate
      expect(resolveReKycPayoutRail({ ...base, requestedMode: undefined, mandateMode: 'upi', editable: all, stored: {} })).toBe('upi');
      // nothing usable and no live rail → null
      expect(resolveReKycPayoutRail({ ...base, requestedMode: 'bank', editable: editableOnly('accountNumber'), stored: {} })).toBeNull();
      // live rail not permitted → null
      expect(
        resolveReKycPayoutRail({ ...base, requestedMode: undefined, isRailAllowed: (r) => r === 'bank', editable: editableOnly(), stored: { upiId: 'a@upi' } }),
      ).toBeNull();
    });

    it('resolveReKycPayout: stages only editable fields of C; payoutRail only when C routing is staged', () => {
      // Deoleo: UPI off (bank only), live bank, upiId flagged → nothing staged, nothing cleared, no error
      const deoleo = resolveReKycPayout({
        ...base, requestedMode: 'bank', mandateMode: 'bank', isRailAllowed: (r) => r === 'bank',
        editable: editableOnly('upiId'), submitted: { upiId: 'x@upi', accountNumber: '1', ifscCode: 'I' },
        stored: { accountNumber: '1', ifscCode: 'I' },
      });
      expect(deoleo).toEqual({ rail: 'bank', stageFields: [], payoutRail: null, error: null });
      // bankName-only → staged, no rail
      const bn = resolveReKycPayout({
        ...base, requestedMode: 'bank', editable: editableOnly('bankName'),
        submitted: { bankName: 'New' }, stored: { accountNumber: '1', ifscCode: 'I' },
      });
      expect(bn).toEqual({ rail: 'bank', stageFields: ['bankName'], payoutRail: null, error: null });
      // account-only flag with a stored IFSC → account staged, payoutRail=bank (IFSC never staged)
      const acct = resolveReKycPayout({
        ...base, requestedMode: 'bank', editable: editableOnly('accountNumber'),
        submitted: { accountNumber: '2', ifscCode: 'TAMPER' }, stored: { upiId: 'a@upi', ifscCode: 'I' },
      });
      expect(acct).toEqual({ rail: 'bank', stageFields: ['accountNumber'], payoutRail: 'bank', error: null });
      // reachable but an editable routing field left empty → error naming it
      const miss = resolveReKycPayout({
        ...base, requestedMode: 'bank', editable: editableOnly('accountNumber'),
        submitted: {}, stored: { ifscCode: 'I' },
      });
      expect(miss.error).toBe('Enter the account number');
    });
  });

  describe('effectiveProposedPayout — completeness merged over the LIVE partner', () => {
    it('a staged account number + the live IFSC → complete → clears UPI; without live → nothing', () => {
      const proposed = { payoutRail: 'bank', paymentMode: 'bank', bankAccountNumber: '2' };
      const withLive = effectiveProposedPayout(proposed, { accountNumber: true }, { ifscCode: 'HDFC0001', upiId: 'a@upi' });
      expect(withLive.rail).toBe('bank');
      expect(withLive.clears).toEqual({ upiId: null, upiCaptureMethod: null });
      expect(effectiveProposedPayout(proposed, { accountNumber: true }).rail).toBeNull();
    });

    it('FIX B (M3): an INCOMPLETE explicit rail drops its routing keys + paymentMode (non-routing kept), clears nothing', () => {
      const bank = effectiveProposedPayout(
        { payoutRail: 'bank', paymentMode: 'bank', bankName: 'HDFC', bankAccountHolder: 'H', bankAccountNumber: '2', gstNumber: 'G' },
        null, // no field flags → no legacy narrowing; only the M3 drop applies
        { upiId: 'a@upi', ifscCode: null },
      );
      expect(bank.rail).toBeNull();
      expect(bank.clears).toEqual({});
      expect(bank.proposal).toEqual({ payoutRail: 'bank', bankName: 'HDFC', bankAccountHolder: 'H', gstNumber: 'G' });
      const upi = effectiveProposedPayout(
        { payoutRail: 'upi', paymentMode: 'upi', upiId: ' ', upiCaptureMethod: 'QR' },
        null,
        { bankAccountNumber: '1', ifscCode: 'X' },
      );
      expect(upi.proposal).toEqual({ payoutRail: 'upi' });
      // A COMPLETE rail is untouched (paymentMode kept).
      expect(effectiveProposedPayout({ payoutRail: 'upi', paymentMode: 'upi', upiId: 'a@upi' }, null).proposal.paymentMode).toBe('upi');
    });
  });

  describe('resolveUpiCaptureMethod (R6/R7)', () => {
    it('an explicit QR always wins; an explicit MANUAL wins only while manual entry is allowed', () => {
      expect(resolveUpiCaptureMethod('QR', false, { upiCaptureMethod: 'MANUAL' })).toBe('QR');
      expect(resolveUpiCaptureMethod('MANUAL', true, { upiCaptureMethod: 'QR' })).toBe('MANUAL');
    });
    it('no method (old FE) / MANUAL-while-off on an unchanged or inherited UPI → the prior method', () => {
      expect(resolveUpiCaptureMethod(undefined, true, { upiCaptureMethod: 'QR' })).toBe('QR');
      expect(resolveUpiCaptureMethod('MANUAL', false, { upiCaptureMethod: 'QR' })).toBe('QR');
      expect(resolveUpiCaptureMethod(undefined, false, { upiCaptureMethod: null })).toBeNull();
    });
    it('no method and no prior → null (unknown)', () => {
      expect(resolveUpiCaptureMethod(undefined, true, null)).toBeNull();
      expect(resolveUpiCaptureMethod('bogus', true, null)).toBeNull();
    });
  });
});
