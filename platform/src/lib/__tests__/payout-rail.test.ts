import { describe, it, expect } from 'vitest';
import {
  isPayoutFieldEditable, isRailReachable, reachableRails, allowedRails, railHasFlaggedRouting,
  decidePayoutRail, isRemovalConsistent, asPayoutRail, REMOVED_RAIL_NOTICE,
  type PayoutRailContext,
} from '../payout-rail';

const BANK_STORED = { accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: '' };
const UPI_STORED = { accountNumber: '', ifscCode: '', upiId: 'verma@okaxis' };
const BOTH: PayoutRailContext['permittedRails'] = ['bank', 'upi'];

const ctx = (o: Partial<PayoutRailContext>): PayoutRailContext => ({
  isNewKyc: false, flags: null, stored: null, liveRail: null, permittedRails: BOTH, ...o,
});

describe('isPayoutFieldEditable', () => {
  it('brand-new KYC → every field editable, even with stray flags', () => {
    expect(isPayoutFieldEditable('upiId', { isNewKyc: true, flags: { gstNumber: true } })).toBe(true);
  });
  it('blanket re-KYC (no field booleans, remarks only) → editable', () => {
    expect(isPayoutFieldEditable('accountNumber', { isNewKyc: false, flags: { remarks: 'x' } })).toBe(true);
    expect(isPayoutFieldEditable('ifscCode', { isNewKyc: false, flags: null })).toBe(true);
  });
  it('field-flagged re-KYC → only the flagged field (and cheque maps to cancelledCheque)', () => {
    const f = { isNewKyc: false, flags: { upiId: true, cancelledCheque: true } };
    expect(isPayoutFieldEditable('upiId', f)).toBe(true);
    expect(isPayoutFieldEditable('cheque', f)).toBe(true);
    expect(isPayoutFieldEditable('accountNumber', f)).toBe(false);
    expect(isPayoutFieldEditable('bankName', f)).toBe(false);
  });
});

describe('reachability', () => {
  it('a rail is reachable when every routing field is editable OR stored', () => {
    // upiId flagged on a live-bank partner: UPI editable, bank stored → both reachable.
    const c = ctx({ flags: { upiId: true }, stored: BANK_STORED, liveRail: 'bank' });
    expect(isRailReachable('upi', c)).toBe(true);
    expect(isRailReachable('bank', c)).toBe(true);
    expect(reachableRails(c)).toEqual(['bank', 'upi']);
  });
  it('bank needs BOTH accountNumber and ifscCode: one editable + the other empty → unreachable', () => {
    const c = ctx({ flags: { accountNumber: true }, stored: UPI_STORED, liveRail: 'upi' });
    expect(isRailReachable('bank', c)).toBe(false);
    expect(isRailReachable('upi', c)).toBe(true);
  });
  it('whitespace-only stored values do not count', () => {
    const c = ctx({ flags: { bankName: true }, stored: { upiId: '   ' } });
    expect(isRailReachable('upi', c)).toBe(false);
  });
  it('allowed = reachable ∩ permitted', () => {
    const c = ctx({ flags: { upiId: true }, stored: BANK_STORED, permittedRails: ['bank'] });
    expect(allowedRails(c)).toEqual(['bank']);
  });
  it('railHasFlaggedRouting ignores new / blanket KYCs', () => {
    expect(railHasFlaggedRouting('upi', { isNewKyc: false, flags: { upiId: true } })).toBe(true);
    expect(railHasFlaggedRouting('bank', { isNewKyc: false, flags: { ifscCode: true } })).toBe(true);
    expect(railHasFlaggedRouting('bank', { isNewKyc: false, flags: { bankName: true } })).toBe(false);
    expect(railHasFlaggedRouting('upi', { isNewKyc: true, flags: { upiId: true } })).toBe(false);
  });
});

describe('decidePayoutRail', () => {
  it('Deoleo-like: UPI off (bank only), live bank, upiId flagged → locked to bank, NOT a re-KYC lock', () => {
    const d = decidePayoutRail(ctx({ flags: { upiId: true }, stored: BANK_STORED, liveRail: 'bank', permittedRails: ['bank'] }));
    expect(d).toEqual({ allowed: ['bank'], lockedRail: 'bank', lockedByReKyc: false, defaultRail: 'bank' });
  });
  it('upiId flagged, live bank, UPI on → free, default UPI', () => {
    const d = decidePayoutRail(ctx({ flags: { upiId: true }, stored: BANK_STORED, liveRail: 'bank' }));
    expect(d).toEqual({ allowed: ['bank', 'upi'], lockedRail: null, lockedByReKyc: false, defaultRail: 'upi' });
  });
  it('upiId flagged, live bank but NO stored IFSC → bank unreachable → locked to UPI (re-KYC lock)', () => {
    const d = decidePayoutRail(ctx({
      flags: { upiId: true }, stored: { accountNumber: '123456789012', ifscCode: '' }, liveRail: 'bank',
    }));
    expect(d.lockedRail).toBe('upi');
    expect(d.lockedByReKyc).toBe(true);
    expect(d.defaultRail).toBe('upi');
  });
  it('accountNumber-only flagged on a live-UPI partner with no stored IFSC → locked to UPI', () => {
    const d = decidePayoutRail(ctx({ flags: { accountNumber: true }, stored: UPI_STORED, liveRail: 'upi' }));
    expect(d).toEqual({ allowed: ['upi'], lockedRail: 'upi', lockedByReKyc: true, defaultRail: 'upi' });
  });
  it('accountNumber + ifscCode flagged on a live-UPI partner → free, default bank', () => {
    const d = decidePayoutRail(ctx({ flags: { accountNumber: true, ifscCode: true }, stored: UPI_STORED, liveRail: 'upi' }));
    expect(d).toEqual({ allowed: ['bank', 'upi'], lockedRail: null, lockedByReKyc: false, defaultRail: 'bank' });
  });
  it('routing flagged on BOTH rails → free, default liveRail', () => {
    const d = decidePayoutRail(ctx({ flags: { upiId: true, accountNumber: true, ifscCode: true }, stored: BANK_STORED, liveRail: 'bank' }));
    expect(d.lockedRail).toBeNull();
    expect(d.defaultRail).toBe('bank');
  });
  it('blanket re-KYC → free, default liveRail', () => {
    const d = decidePayoutRail(ctx({ flags: { remarks: 'redo' }, stored: UPI_STORED, liveRail: 'upi' }));
    expect(d).toEqual({ allowed: ['bank', 'upi'], lockedRail: null, lockedByReKyc: false, defaultRail: 'upi' });
  });
  it('brand-new KYC → free, default first allowed (bank)', () => {
    const d = decidePayoutRail(ctx({ isNewKyc: true }));
    expect(d).toEqual({ allowed: ['bank', 'upi'], lockedRail: null, lockedByReKyc: false, defaultRail: 'bank' });
  });
  it('a flagged rail that is NOT permitted is never the default (outlet mandate UPI → upi only)', () => {
    const d = decidePayoutRail(ctx({ flags: { accountNumber: true, ifscCode: true }, stored: UPI_STORED, liveRail: 'upi', permittedRails: ['upi'] }));
    expect(d.lockedRail).toBe('upi');
    expect(d.lockedByReKyc).toBe(false);
  });
  it('zero allowed (both permitted) → locked to liveRail, as a re-KYC lock', () => {
    // Only bankName flagged; stored IFSC missing and no UPI → neither rail reachable.
    const d = decidePayoutRail(ctx({ flags: { bankName: true }, stored: { accountNumber: '1234', ifscCode: '' }, liveRail: 'upi' }));
    expect(d.allowed).toEqual([]);
    expect(d.lockedRail).toBe('upi');
    expect(d.lockedByReKyc).toBe(true);
  });
  it('zero allowed, no liveRail → bank', () => {
    const d = decidePayoutRail(ctx({ flags: { bankName: true }, stored: null, liveRail: null }));
    expect(d.lockedRail).toBe('bank');
  });
  it('zero allowed under a mandate → the mandated rail (never a non-permitted liveRail)', () => {
    const d = decidePayoutRail(ctx({ flags: { bankName: true }, stored: UPI_STORED, liveRail: 'upi', permittedRails: ['bank'] }));
    expect(d.allowed).toEqual([]);
    expect(d.lockedRail).toBe('bank');
    expect(d.lockedByReKyc).toBe(false);
  });
});

describe('removed-rail helpers', () => {
  it('asPayoutRail narrows', () => {
    expect(asPayoutRail('upi')).toBe('upi');
    expect(asPayoutRail('bank')).toBe('bank');
    expect(asPayoutRail('BANK')).toBeNull();
    expect(asPayoutRail(undefined)).toBeNull();
  });
  it('notice texts are value-free', () => {
    expect(REMOVED_RAIL_NOTICE.upi).toMatch(/current UPI ID will be removed on approval/);
    expect(REMOVED_RAIL_NOTICE.bank).toMatch(/current bank details will be removed on approval/);
  });
  it('isRemovalConsistent: removedRail is authoritative when present', () => {
    expect(isRemovalConsistent('upiId', false, null)).toBe(true); // older backend → unchanged
    expect(isRemovalConsistent('upiId', true, 'upi')).toBe(true);
    expect(isRemovalConsistent('ifscCode', true, 'upi')).toBe(false);
    expect(isRemovalConsistent('bankAccountHolder', true, 'bank')).toBe(true);
    expect(isRemovalConsistent('upiId', true, null)).toBe(false);
  });
});
