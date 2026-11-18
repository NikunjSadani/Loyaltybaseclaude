/**
 * K2 — outlet-row KYC links: detail when there is one, START wizard only when the owner has none, and NO link
 * (note instead) when the owner's KYC was filed via another outlet the caller cannot open.
 */
import { describe, it, expect } from 'vitest';
import { kycHrefFor, kycTaskHrefFor, kycFiledViaNote } from '../sales-kyc-link';

describe('sales-kyc-link', () => {
  it('a row with a kycId deep-links to the detail', () => {
    expect(kycHrefFor({ id: 'o1', kycId: 'k1' })).toBe('/sales/kyc/k1');
  });

  it('a row with no KYC at all opens the START wizard on that outlet', () => {
    expect(kycHrefFor({ id: 'o1', kycId: '' })).toBe('/sales/kyc/new?outletId=o1');
  });

  it('a KYC filed via another outlet → no link, the note, and task lists go to that outlet card', () => {
    const o = { id: 'o2', kycId: '', kycFiledViaOutletCode: 'OUT-1', outletCode: 'OUT-2', name: 'Shop' };
    expect(kycHrefFor(o)).toBeNull();
    expect(kycFiledViaNote(o)).toBe('KYC filed via outlet OUT-1');
    expect(kycTaskHrefFor(o)).toBe('/sales/outlets?q=OUT-2');
  });

  it('no note for a normal row', () => {
    expect(kycFiledViaNote({ id: 'o1', kycId: 'k1' })).toBeNull();
  });
});
