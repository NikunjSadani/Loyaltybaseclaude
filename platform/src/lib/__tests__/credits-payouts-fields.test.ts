/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: Field Configuration
 *
 * Groups:
 *   A — Source exports
 *   B — createField
 *   C — deactivateField / reactivateField
 *   D — getActiveFields / getAllFields
 *   E — ordering invariant
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — credits-payouts-fields.ts: exports', () => {
  const code = src('lib/credits-payouts-fields.ts');

  it('A1: createField is exported', () => {
    expect(code).toMatch(/export\s+function\s+createField/);
  });

  it('A2: deactivateField is exported', () => {
    expect(code).toMatch(/export\s+function\s+deactivateField/);
  });

  it('A3: reactivateField is exported', () => {
    expect(code).toMatch(/export\s+function\s+reactivateField/);
  });

  it('A4: getActiveFields is exported', () => {
    expect(code).toMatch(/export\s+function\s+getActiveFields/);
  });

  it('A5: getAllFields is exported', () => {
    expect(code).toMatch(/export\s+function\s+getAllFields/);
  });

  it('A6: CreditField referenced (from @/types)', () => {
    expect(code).toMatch(/CreditField/);
  });

  it('A7: DEMO_CREDIT_FIELDS seed is exported', () => {
    expect(code).toMatch(/export\s+const\s+DEMO_CREDIT_FIELDS/);
  });

  it('A8: resetFields is exported (for testing)', () => {
    expect(code).toMatch(/export\s+function\s+resetFields/);
  });
});

// ─── B — createField ─────────────────────────────────────────────────────────

describe('B — createField', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B1: creates a field with isActive=true', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Test Field');
    expect(f.isActive).toBe(true);
    expect(f.name).toBe('Test Field');
  });

  it('B2: isSeparatePayout defaults to false', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Test Field');
    expect(f.isSeparatePayout).toBe(false);
  });

  it('B3: isSeparatePayout can be set to true', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Separate Field', { isSeparatePayout: true });
    expect(f.isSeparatePayout).toBe(true);
  });

  it('B4: throws on empty name', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    expect(() => createField('')).toThrow();
    expect(() => createField('   ')).toThrow();
  });

  it('B5: trims whitespace from name', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('  Field With Spaces  ');
    expect(f.name).toBe('Field With Spaces');
  });

  it('B6: assigns incrementing order values', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f1 = createField('Alpha');
    const f2 = createField('Beta');
    const f3 = createField('Gamma');
    expect(f2.order).toBeGreaterThan(f1.order);
    expect(f3.order).toBeGreaterThan(f2.order);
  });

  it('B7: default outletTypeAwards maps WHOLESALER→POINTS, SSS→PAYOUT', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Volume');
    expect(f.outletTypeAwards['WHOLESALER']).toBe('POINTS');
    expect(f.outletTypeAwards['SSS']).toBe('PAYOUT');
    expect(f.outletTypeAwards['SUB_STOCKIST']).toBe('PAYOUT');
    expect(f.outletTypeAwards['SSS_TOT']).toBe('PAYOUT');
  });

  it('B8: custom outletTypeAwards are accepted', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Custom', {
      outletTypeAwards: { WHOLESALER: 'NA', SSS: 'POINTS' },
    });
    expect(f.outletTypeAwards['WHOLESALER']).toBe('NA');
    expect(f.outletTypeAwards['SSS']).toBe('POINTS');
  });

  it('B9: created field has a createdAt ISO string', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('With Date');
    expect(() => new Date(f.createdAt).toISOString()).not.toThrow();
  });

  it('B10: created field has a unique id', async () => {
    const { createField, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    const f1 = createField('One');
    const f2 = createField('Two');
    expect(f1.id).not.toBe(f2.id);
  });
});

// ─── C — deactivateField / reactivateField ────────────────────────────────────

describe('C — deactivateField / reactivateField', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('C1: deactivateField sets isActive=false', async () => {
    const { createField, deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('To Deactivate');
    deactivateField(f.id);
    const updated = getAllFields().find((x) => x.id === f.id);
    expect(updated?.isActive).toBe(false);
  });

  it('C2: deactivateField preserves the order value', async () => {
    const { createField, deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Order Preserved');
    const orderBefore = f.order;
    deactivateField(f.id);
    const updated = getAllFields().find((x) => x.id === f.id);
    expect(updated?.order).toBe(orderBefore);
  });

  it('C3: reactivateField sets isActive=true', async () => {
    const { createField, deactivateField, reactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('To Reactivate');
    deactivateField(f.id);
    reactivateField(f.id);
    const updated = getAllFields().find((x) => x.id === f.id);
    expect(updated?.isActive).toBe(true);
  });

  it('C4: deactivating a non-existent id is a no-op', async () => {
    const { deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    expect(() => deactivateField('no_such_id')).not.toThrow();
    expect(getAllFields()).toHaveLength(0);
  });
});

// ─── D — getActiveFields / getAllFields ───────────────────────────────────────

describe('D — getActiveFields / getAllFields', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('D1: getActiveFields returns only active fields', async () => {
    const { createField, deactivateField, getActiveFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f1 = createField('Active');
    const f2 = createField('Inactive');
    deactivateField(f2.id);
    const active = getActiveFields();
    expect(active.some((f) => f.id === f1.id)).toBe(true);
    expect(active.some((f) => f.id === f2.id)).toBe(false);
  });

  it('D2: getAllFields returns all fields regardless of isActive', async () => {
    const { createField, deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f1 = createField('Active');
    const f2 = createField('Inactive');
    deactivateField(f2.id);
    const all = getAllFields();
    expect(all.some((f) => f.id === f1.id)).toBe(true);
    expect(all.some((f) => f.id === f2.id)).toBe(true);
  });

  it('D3: getActiveFields returns empty array when all deactivated', async () => {
    const { createField, deactivateField, getActiveFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f = createField('Only One');
    deactivateField(f.id);
    expect(getActiveFields()).toHaveLength(0);
  });
});

// ─── E — Ordering invariant ───────────────────────────────────────────────────

describe('E — Ordering invariant', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('E1: getAllFields returns fields in creation order (ascending order)', async () => {
    const { createField, getAllFields, resetFields } = await import('../credits-payouts-fields');
    resetFields([]);
    createField('Alpha');
    createField('Beta');
    createField('Gamma');
    const all = getAllFields();
    const orders = all.map((f) => f.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('E2: deactivating does not change the order of remaining fields', async () => {
    const { createField, deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    createField('F1');
    const f2 = createField('F2');
    createField('F3');
    deactivateField(f2.id);
    const all = getAllFields();
    const orders = all.map((f) => f.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('E3: new fields created after deactivation get higher order numbers', async () => {
    const { createField, deactivateField, getAllFields, resetFields } =
      await import('../credits-payouts-fields');
    resetFields([]);
    const f1 = createField('First');
    deactivateField(f1.id);
    const f2 = createField('Second');
    expect(f2.order).toBeGreaterThan(f1.order);
    expect(getAllFields()).toHaveLength(2);
  });

  it('E4: DEMO_CREDIT_FIELDS has fields in ascending order', async () => {
    const { DEMO_CREDIT_FIELDS } = await import('../credits-payouts-fields');
    const orders = DEMO_CREDIT_FIELDS.map((f) => f.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});
