/// <reference types="vitest/globals" />
/**
 * Vendor portal — PURE helper unit tests (no render).
 *
 * V1  validateVendorItemForm: price + MRP rules (required, >0, price ≤ MRP)
 * V2  vendorItemFormToPayload: rupees → paise + image parsing
 * V3  isMaterialEdit / willResubmitForApproval: the re-approval rule
 * V4  reapprovalNote: honest copy per policy
 * V5  vendorNextStatusOptions: RESTRICTED — only PROCESSING/DISPATCHED/DELIVERED, never
 *     CANCELLED / RETURNED / FAILED / REVERSED, from any status
 * V6  isBlockedError: 403 / suspend detection
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_VENDOR_ITEM_FORM,
  type VendorItemFormState,
  type VendorCatalogueDetail,
  validateVendorItemForm,
  vendorItemFormToPayload,
  vendorDetailToForm,
  isMaterialEdit,
  willResubmitForApproval,
  reapprovalNote,
  policyRequiresApproval,
  vendorNextStatusOptions,
  isVendorTerminal,
  isVendorAllowedTarget,
  VENDOR_ALLOWED_TARGET_STATUSES,
  vendorConfirmCopy,
  isBlockedError,
} from './vendor';

function form(overrides: Partial<VendorItemFormState> = {}): VendorItemFormState {
  return {
    ...EMPTY_VENDOR_ITEM_FORM,
    name: 'JBL Speaker',
    categoryId: 'cat-1',
    sellingRupees: '1999',
    mrpRupees: '2499',
    ...overrides,
  };
}

describe('validateVendorItemForm (V1)', () => {
  it('accepts a well-formed item', () => {
    expect(validateVendorItemForm(form())).toEqual([]);
  });

  it('requires a name and a category', () => {
    const errs = validateVendorItemForm(form({ name: '  ', categoryId: '' }));
    expect(errs).toContain('Name is required.');
    expect(errs).toContain('Category is required.');
  });

  it('requires a valid selling price > ₹0', () => {
    expect(validateVendorItemForm(form({ sellingRupees: '' }))).toContain(
      'Selling price must be a valid amount in ₹.',
    );
    expect(validateVendorItemForm(form({ sellingRupees: '0' }))).toContain(
      'Selling price must be greater than ₹0.',
    );
  });

  it('requires an MRP (it is mandatory on vendor items)', () => {
    expect(validateVendorItemForm(form({ mrpRupees: '' }))).toContain(
      'MRP is required and must be a valid amount in ₹.',
    );
  });

  it('blocks a selling price above the MRP (194R integrity)', () => {
    expect(validateVendorItemForm(form({ sellingRupees: '3000', mrpRupees: '2499' }))).toContain(
      'Selling price cannot exceed the MRP.',
    );
  });

  it('rejects a non-integer / negative stock', () => {
    expect(validateVendorItemForm(form({ stockQuantity: '-4' }))).toContain(
      'Stock quantity must be a whole number (0 or more), or blank for unlimited.',
    );
    // blank stock is allowed (= unlimited)
    expect(validateVendorItemForm(form({ stockQuantity: '' }))).toEqual([]);
  });

  it('rejects a malformed image URL', () => {
    const errs = validateVendorItemForm(form({ imageUrls: 'not-a-url' }));
    expect(errs.some((e) => e.startsWith('Image URL is not valid'))).toBe(true);
  });
});

describe('vendorItemFormToPayload (V2)', () => {
  it('converts rupees → paise and parses images + stock', () => {
    const payload = vendorItemFormToPayload(
      form({ sellingRupees: '1999', mrpRupees: '2499', stockQuantity: '10', imageUrls: 'https://x/a.jpg\nhttps://x/b.jpg' }),
    );
    expect(payload).toMatchObject({
      name: 'JBL Speaker',
      categoryId: 'cat-1',
      sellingValuePaise: 199900,
      mrpPaise: 249900,
      stockQuantity: 10,
      imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'],
    });
  });

  it('sends null stock for blank (= unlimited)', () => {
    expect(vendorItemFormToPayload(form({ stockQuantity: '' })).stockQuantity).toBeNull();
  });
});

describe('material edit + re-approval (V3)', () => {
  const approved: VendorCatalogueDetail = {
    id: 'i1',
    name: 'JBL Speaker',
    categoryId: 'cat-1',
    sellingValuePaise: 199900,
    mrpPaise: 249900,
    moderationStatus: 'APPROVED',
    stockQuantity: 10,
    imageUrls: ['https://x/a.jpg'],
    description: 'Nice speaker',
  };

  it('a price change is a material edit', () => {
    const f = vendorDetailToForm(approved);
    expect(isMaterialEdit(approved, f)).toBe(false); // unchanged
    expect(isMaterialEdit(approved, { ...f, sellingRupees: '1500' })).toBe(true);
  });

  it('a description-only change is NOT material', () => {
    const f = { ...vendorDetailToForm(approved), description: 'Different copy' };
    expect(isMaterialEdit(approved, f)).toBe(false);
  });

  it('an image reorder/change is material', () => {
    const f = { ...vendorDetailToForm(approved), imageUrls: 'https://x/a.jpg\nhttps://x/c.jpg' };
    expect(isMaterialEdit(approved, f)).toBe(true);
  });

  it('willResubmit: APPROVED + material change + non-AUTO policy', () => {
    const f = { ...vendorDetailToForm(approved), sellingRupees: '1500' };
    expect(willResubmitForApproval(approved, f, 'GIFSY_APPROVE')).toBe(true);
  });

  it('willResubmit: NOT under AUTO_LIVE (no approval step at all)', () => {
    const f = { ...vendorDetailToForm(approved), sellingRupees: '1500' };
    expect(willResubmitForApproval(approved, f, 'AUTO_LIVE')).toBe(false);
  });

  it('willResubmit: NOT for a non-material change', () => {
    const f = { ...vendorDetailToForm(approved), description: 'x' };
    expect(willResubmitForApproval(approved, f, 'GIFSY_APPROVE')).toBe(false);
  });

  it('willResubmit: NOT when the item is not currently APPROVED', () => {
    const pending = { ...approved, moderationStatus: 'PENDING' as const };
    const f = { ...vendorDetailToForm(pending), sellingRupees: '1500' };
    expect(willResubmitForApproval(pending, f, 'GIFSY_APPROVE')).toBe(false);
  });
});

describe('reapprovalNote + policyRequiresApproval (V4)', () => {
  it('AUTO_LIVE explains items go live immediately', () => {
    expect(reapprovalNote('AUTO_LIVE')).toMatch(/immediately|automatically/i);
    expect(policyRequiresApproval('AUTO_LIVE')).toBe(false);
  });
  it('GIFSY_APPROVE explains material edits re-submit for approval', () => {
    expect(reapprovalNote('GIFSY_APPROVE')).toMatch(/approval/i);
    expect(policyRequiresApproval('GIFSY_APPROVE')).toBe(true);
  });
});

describe('vendorNextStatusOptions — RESTRICTED edge-map (V5)', () => {
  it('PENDING/CONFIRMED → PROCESSING', () => {
    expect(vendorNextStatusOptions('PENDING')).toEqual(['PROCESSING']);
    expect(vendorNextStatusOptions('CONFIRMED')).toEqual(['PROCESSING']);
  });
  it('PROCESSING → DISPATCHED, DISPATCHED → DELIVERED', () => {
    expect(vendorNextStatusOptions('PROCESSING')).toEqual(['DISPATCHED']);
    expect(vendorNextStatusOptions('DISPATCHED')).toEqual(['DELIVERED']);
  });
  it('DELIVERED is terminal for the vendor (no return/reversal edge)', () => {
    expect(vendorNextStatusOptions('DELIVERED')).toEqual([]);
    expect(isVendorTerminal('DELIVERED')).toBe(true);
  });

  it('NEVER offers cancel / return / failed / reversed from ANY status', () => {
    const forbidden = ['CANCELLED', 'RETURNED', 'FAILED', 'REVERSED'];
    for (const from of ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'RETURNED']) {
      for (const to of vendorNextStatusOptions(from)) {
        expect(forbidden).not.toContain(to);
        expect(isVendorAllowedTarget(to)).toBe(true);
      }
    }
  });

  it('the allowed target set is exactly the three fulfilment states', () => {
    expect(VENDOR_ALLOWED_TARGET_STATUSES).toEqual(['PROCESSING', 'DISPATCHED', 'DELIVERED']);
    expect(isVendorAllowedTarget('CANCELLED')).toBe(false);
    expect(isVendorAllowedTarget('RETURNED')).toBe(false);
  });

  it('confirm copy has no wallet/refund language and is honest about dispatch', () => {
    expect(vendorConfirmCopy('DISPATCHED').description).toMatch(/shipped|dispatch/i);
    for (const to of VENDOR_ALLOWED_TARGET_STATUSES) {
      expect(vendorConfirmCopy(to).description).not.toMatch(/refund|wallet/i);
    }
  });
});

describe('isBlockedError (V6)', () => {
  it('treats a real HTTP 403 as blocked regardless of the message', () => {
    expect(isBlockedError("You don't have permission to do that", 403)).toBe(true);
    expect(isBlockedError('anything', 403)).toBe(true);
  });
  it('matches genuine suspension / revocation wording when no status is available', () => {
    expect(isBlockedError('Vendor is suspended')).toBe(true);
    expect(isBlockedError('Your grant was revoked')).toBe(true);
    expect(isBlockedError('Access has been removed')).toBe(true);
  });
  it('does NOT over-match a non-403 error that merely mentions permission/forbidden', () => {
    // The old broad regex flipped these into a permanent suspended panel — no longer.
    expect(isBlockedError('You don\'t have permission to do that')).toBe(false);
    expect(isBlockedError('Forbidden')).toBe(false);
    expect(isBlockedError('Upstream forbidden the request', 500)).toBe(false);
  });
  it('does not match an ordinary network error', () => {
    expect(isBlockedError('Network error')).toBe(false);
    expect(isBlockedError(null)).toBe(false);
  });
});
