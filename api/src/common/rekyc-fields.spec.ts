import {
  hasReKycFlags,
  flaggedDtoFields,
  allowedDocTypes,
  applyReKycTextLock,
} from './rekyc-fields';

describe('hasReKycFlags', () => {
  it('true when at least one field boolean is set', () => {
    expect(hasReKycFlags({ mobileNumber: true })).toBe(true);
    expect(hasReKycFlags({ gstCertificate: true, remarks: 'redo it' })).toBe(true);
  });

  it('false for blanket re-KYC (all-false keys) — no SPECIFIC field flagged', () => {
    expect(hasReKycFlags({ mobileNumber: false, remarks: '' })).toBe(false);
  });

  it('false for empty / null / undefined', () => {
    expect(hasReKycFlags({})).toBe(false);
    expect(hasReKycFlags(null)).toBe(false);
    expect(hasReKycFlags(undefined)).toBe(false);
  });
});

describe('flaggedDtoFields', () => {
  it('maps flag keys to their dtoField names (text fields only)', () => {
    expect(flaggedDtoFields({ mobileNumber: true, streetAddress: true })).toEqual(
      expect.arrayContaining(['mobile', 'address']),
    );
  });

  it('excludes document-only flags (no dtoField)', () => {
    expect(flaggedDtoFields({ gstCertificate: true })).toEqual([]);
  });
});

describe('allowedDocTypes', () => {
  it('returns null when no field flags (all docs allowed)', () => {
    expect(allowedDocTypes(null)).toBeNull();
    expect(allowedDocTypes({})).toBeNull();
    expect(allowedDocTypes({ mobileNumber: false })).toBeNull();
  });

  it('returns only the flagged document types', () => {
    const set = allowedDocTypes({ gstCertificate: true, ownerPhoto: true });
    expect(set).not.toBeNull();
    expect(set!.has('GST_CERTIFICATE')).toBe(true);
    expect(set!.has('SELFIE')).toBe(true);
    expect(set!.has('CANCELLED_CHEQUE')).toBe(false);
  });

  it('a text-only flag yields an EMPTY set (no doc types allowed → all docs skipped)', () => {
    const set = allowedDocTypes({ mobileNumber: true });
    expect(set).not.toBeNull();
    expect(set!.size).toBe(0);
  });
});

describe('applyReKycTextLock', () => {
  const stored = {
    partnerName: 'Old Owner',
    mobile: '9820100001',
    gstNumber: '27ABCDE1234F1ZK',
    address: '12 SV Road',
    city: 'Mumbai',
  };

  it('passes incoming through untouched when there are no field flags', () => {
    const incoming = { partnerName: 'New Owner', mobile: '9000000000' };
    const res = applyReKycTextLock(null, incoming, stored);
    expect(res.effective).toEqual(incoming);
    expect(res.blocked).toEqual([]);
  });

  it('accepts a change to a FLAGGED field', () => {
    const incoming = { partnerName: 'New Owner', mobile: '9820100001', gstNumber: '27ABCDE1234F1ZK' };
    // only ownerName (partnerName) is flagged → its change is kept.
    const res = applyReKycTextLock({ ownerName: true }, incoming, stored);
    expect(res.effective.partnerName).toBe('New Owner');
    expect(res.blocked).toEqual([]);
  });

  it('PINS a change to a NON-flagged field back to stored, and reports it as blocked', () => {
    // Only mobileNumber is flagged; the payload also tampers with partnerName (non-flagged).
    const incoming = { partnerName: 'Tampered', mobile: '9111111111' };
    const res = applyReKycTextLock({ mobileNumber: true }, incoming, stored);
    // flagged mobile change kept …
    expect(res.effective.mobile).toBe('9111111111');
    // … non-flagged partnerName pinned back to stored.
    expect(res.effective.partnerName).toBe('Old Owner');
    expect(res.blocked).toContain('partnerName');
  });

  it('does not report blocked when a non-flagged field matches stored (only formatting-identical)', () => {
    const incoming = { partnerName: 'Old Owner', mobile: '9111111111' };
    const res = applyReKycTextLock({ mobileNumber: true }, incoming, stored);
    expect(res.effective.partnerName).toBe('Old Owner');
    expect(res.blocked).not.toContain('partnerName');
  });

  it('normalises null/blank/whitespace on both sides (no false blocked)', () => {
    const res = applyReKycTextLock(
      { mobileNumber: true },
      { gstNumber: '  ', mobile: '9111111111' },
      { gstNumber: null as unknown as string, mobile: '9820100001' },
    );
    // '' vs null collapse → not blocked, pinned to stored (null).
    expect(res.blocked).not.toContain('gstNumber');
    expect(res.effective.gstNumber).toBeNull();
  });

  it('only pins fields the incoming payload actually carries', () => {
    const incoming = { mobile: '9111111111' }; // partnerName absent
    const res = applyReKycTextLock({ mobileNumber: true }, incoming, stored);
    expect('partnerName' in res.effective).toBe(false);
  });
});
