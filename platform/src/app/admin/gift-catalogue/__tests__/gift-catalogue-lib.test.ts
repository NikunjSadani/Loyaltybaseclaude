/// <reference types="vitest/globals" />
/**
 * Pure-helper unit tests for the gift-catalogue lib — the ₹→points derivation and the
 * form/tree validators the UI relies on. No rendering; fast + deterministic.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/gift-catalogue-lib.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  derivePointsCost,
  parseRupeesToPaise,
  parseImageUrls,
  validateGiftMasterForm,
  giftMasterFormToPayload,
  validateCategoryForm,
  categoryFormToPayload,
  buildCategoryTree,
  flattenCategoryTree,
  wouldCreateCycle,
  EMPTY_MASTER_FORM,
  EMPTY_CATEGORY_FORM,
  type GiftCategory,
} from '@/lib/gift-catalogue';

describe('derivePointsCost — ₹ selling price → points (rate = points-per-₹)', () => {
  it('multiplies rupees by the conversion rate and rounds', () => {
    // ₹1500 (150000 paise) at 2 points/₹ → 3000 points
    expect(derivePointsCost(150000, 2)).toBe(3000);
    // ₹100.50 at 1 point/₹ → round(100.5) = 101
    expect(derivePointsCost(10050, 1)).toBe(101);
  });

  it('returns null (never NaN/Infinity) for a missing/zero/invalid rate', () => {
    expect(derivePointsCost(150000, 0)).toBeNull();
    expect(derivePointsCost(150000, null)).toBeNull();
    expect(derivePointsCost(150000, undefined)).toBeNull();
    expect(derivePointsCost(150000, -1)).toBeNull();
  });

  it('returns null for a missing selling price', () => {
    expect(derivePointsCost(null, 2)).toBeNull();
    expect(derivePointsCost(undefined, 2)).toBeNull();
  });
});

describe('parseRupeesToPaise', () => {
  it('strips commas / ₹ / spaces and converts to integer paise', () => {
    expect(parseRupeesToPaise('1,499.50')).toBe(149950);
    expect(parseRupeesToPaise('₹ 2499')).toBe(249900);
  });
  it('rejects blank / negative / non-numeric', () => {
    expect(parseRupeesToPaise('')).toBeNull();
    expect(parseRupeesToPaise('-5')).toBeNull();
    expect(parseRupeesToPaise('abc')).toBeNull();
  });
});

describe('parseImageUrls', () => {
  it('splits on newlines and commas, trimming blanks', () => {
    expect(parseImageUrls('https://a.com/1.jpg\nhttps://a.com/2.jpg, https://a.com/3.jpg'))
      .toEqual(['https://a.com/1.jpg', 'https://a.com/2.jpg', 'https://a.com/3.jpg']);
    expect(parseImageUrls('')).toEqual([]);
  });
});

describe('validateGiftMasterForm', () => {
  it('flags every required field on a blank form', () => {
    const errs = validateGiftMasterForm(EMPTY_MASTER_FORM);
    expect(errs.join(' ')).toMatch(/Name is required/);
    expect(errs.join(' ')).toMatch(/Code is required/);
    expect(errs.join(' ')).toMatch(/Category is required/);
    expect(errs.join(' ')).toMatch(/MRP/);
  });

  it('passes a well-formed master', () => {
    const errs = validateGiftMasterForm({
      ...EMPTY_MASTER_FORM,
      name: 'JBL Speaker', code: 'GM-1', categoryId: 'c1', mrpRupees: '2499',
    });
    expect(errs).toEqual([]);
  });

  it('rejects a non-integer / negative stock and an invalid image URL', () => {
    const bad = validateGiftMasterForm({
      ...EMPTY_MASTER_FORM,
      name: 'x', code: 'y', categoryId: 'c1', mrpRupees: '10',
      stockQuantity: '-3', imageUrls: 'not-a-url',
    });
    expect(bad.some((e) => /Stock quantity/.test(e))).toBe(true);
    expect(bad.some((e) => /Image URL is not valid/.test(e))).toBe(true);
  });

  it('serialises to the wire payload (rupees → paise, blank stock → null unlimited)', () => {
    const payload = giftMasterFormToPayload({
      ...EMPTY_MASTER_FORM,
      name: ' JBL ', code: ' GM-1 ', categoryId: 'c1', mrpRupees: '2,499',
      stockQuantity: '', imageUrls: 'https://a.com/1.jpg',
    });
    expect(payload).toMatchObject({
      name: 'JBL', code: 'GM-1', categoryId: 'c1', mrpPaise: 249900,
      stockQuantity: null, imageUrls: ['https://a.com/1.jpg'],
      redemptionMode: 'PHYSICAL_GIFT', fulfilmentChannel: 'GIFSY_WAREHOUSE',
    });
  });
});

describe('validateCategoryForm + payload', () => {
  it('requires name + code', () => {
    const errs = validateCategoryForm(EMPTY_CATEGORY_FORM);
    expect(errs.some((e) => /Name is required/.test(e))).toBe(true);
    expect(errs.some((e) => /Code is required/.test(e))).toBe(true);
  });
  it('maps blank parent → null parentId', () => {
    const payload = categoryFormToPayload({
      ...EMPTY_CATEGORY_FORM, name: 'Electronics', code: 'ELEC', parentId: '',
    });
    expect(payload).toMatchObject({ name: 'Electronics', code: 'ELEC', parentId: null, isActive: true });
  });
});

describe('buildCategoryTree / cycle guard', () => {
  const list: GiftCategory[] = [
    { id: 'a', parentId: null, code: 'A', name: 'A', imageUrl: null, sortOrder: 1, isActive: true },
    { id: 'b', parentId: 'a', code: 'B', name: 'B', imageUrl: null, sortOrder: 1, isActive: true },
    { id: 'c', parentId: 'b', code: 'C', name: 'C', imageUrl: null, sortOrder: 1, isActive: true },
    { id: 'd', parentId: null, code: 'D', name: 'D', imageUrl: null, sortOrder: 0, isActive: true },
  ];

  it('nests children under parents and orders roots by sortOrder', () => {
    const tree = buildCategoryTree(list);
    // D (sort 0) before A (sort 1)
    expect(tree.map((n) => n.id)).toEqual(['d', 'a']);
    const flat = flattenCategoryTree(tree);
    expect(flat.map((n) => `${n.id}@${n.depth}`)).toEqual(['d@0', 'a@0', 'b@1', 'c@2']);
  });

  it('detects a cycle (a category under itself or a descendant)', () => {
    expect(wouldCreateCycle(list, 'a', 'a')).toBe(true); // self
    expect(wouldCreateCycle(list, 'a', 'c')).toBe(true); // c is a descendant of a
    expect(wouldCreateCycle(list, 'd', 'a')).toBe(false); // unrelated
  });
});
