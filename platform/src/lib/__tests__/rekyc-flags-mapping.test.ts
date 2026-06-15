/**
 * Re-KYC flag mapping — Pure Logic Tests
 *
 * Covers the row → ReKYCFlags mapping used by POST /api/admin/outlets/rekyc-flag:
 *   buildReKycFlags(row)  — map-driven over REKYC_KEY_TO_FLAG
 *   isReKycFlagsEmpty(flags) — all-false detection (drives the clear-vs-flag decision)
 *
 * These are pure (no DB), so the route's persistence decision is testable in isolation.
 */

import { describe, it, expect } from 'vitest';
import { buildReKycFlags, isReKycFlagsEmpty } from '@/lib/outlet-upload';
import type { ReKYCFlagRow } from '@/types';

/** A fully-blank parsed row — every field empty. Tests override specific cells. */
function blankRow(overrides: Partial<ReKYCFlagRow> = {}): ReKYCFlagRow {
  return {
    rowNum:           2,
    outletId:         'OUT-1',
    outletName:       '',
    ownerName:        '',
    mobileNumber:     '',
    gstNumber:        '',
    panNumber:        '',
    streetAddress:    '',
    city:             '',
    pincode:          '',
    state:            '',
    bankName:         '',
    accountHolderName:'',
    accountNumber:    '',
    ifscCode:         '',
    upiId:            '',
    gstCertificate:   '',
    ownerPhoto:       '',
    addressProof:     '',
    storeBoardPhoto:  '',
    cancelledCheque:  '',
    selfDeclaration:  '',
    remarks:          '',
    ...overrides,
  };
}

describe('buildReKycFlags', () => {
  it('sets the flagged fields true, leaves the rest false, and carries remarks through', () => {
    const flags = buildReKycFlags(blankRow({
      ownerName:  'Yes',
      mobileNumber: 'yes',   // case-insensitive
      ownerPhoto: 'YES',     // document field
      remarks:    'Owner changed — re-capture name, mobile, photo',
    }));

    // flagged
    expect(flags.ownerName).toBe(true);
    expect(flags.mobileNumber).toBe(true);
    expect(flags.ownerPhoto).toBe(true);
    // a sample of the rest stay false
    expect(flags.outletName).toBe(false);
    expect(flags.gstNumber).toBe(false);
    expect(flags.selfDeclaration).toBe(false);
    // remarks verbatim
    expect(flags.remarks).toBe('Owner changed — re-capture name, mobile, photo');
  });

  it('produces the full 20-boolean shape with all flags false for an all-blank row', () => {
    const flags = buildReKycFlags(blankRow());

    const booleanValues = Object.entries(flags)
      .filter(([k]) => k !== 'remarks')
      .map(([, v]) => v);
    expect(booleanValues).toHaveLength(20);
    expect(booleanValues.every(v => v === false)).toBe(true);
    expect(flags.remarks).toBe('');
  });

  it('ignores unknown/extra columns on the row (only mapped flags are written)', () => {
    const row = blankRow({ gstNumber: 'Yes' });
    // simulate an extra property that is not part of REKYC_KEY_TO_FLAG
    (row as unknown as Record<string, string>)['somethingElse'] = 'Yes';

    const flags = buildReKycFlags(row);

    expect(flags.gstNumber).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(flags, 'somethingElse')).toBe(false);
    // still exactly 20 booleans + remarks
    expect(Object.keys(flags).filter(k => k !== 'remarks')).toHaveLength(20);
  });

  it('treats non-"yes" strings (e.g. "No", "y", "true") as false', () => {
    const flags = buildReKycFlags(blankRow({ city: 'No', state: 'y', pincode: 'true' }));
    expect(flags.city).toBe(false);
    expect(flags.state).toBe(false);
    expect(flags.pincode).toBe(false);
  });
});

describe('isReKycFlagsEmpty', () => {
  it('is true when no field is flagged (all-false row)', () => {
    expect(isReKycFlagsEmpty(buildReKycFlags(blankRow({ remarks: 'note only' })))).toBe(true);
  });

  it('is false when at least one field is flagged', () => {
    expect(isReKycFlagsEmpty(buildReKycFlags(blankRow({ panNumber: 'Yes' })))).toBe(false);
  });
});
