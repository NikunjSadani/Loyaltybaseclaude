/// <reference types="vitest/globals" />
/**
 * vendors lib — pure helpers: grant filtering, tenant normalisation, ungranted-tenant
 * candidates, and the three form validators (vendor / grant / login).
 *
 * Run: npx vitest run src/lib/__tests__/vendors.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  activeGrants,
  normalizeTenantOptions,
  ungrantedTenants,
  isApprovalPolicyEnabled,
  isValidPhone,
  validateVendorForm,
  validateGrantForm,
  validateVendorUserForm,
  grantFormToPayload,
  vendorUserFormToPayload,
  type VendorGrant,
} from '@/lib/vendors';

const GRANTS: VendorGrant[] = [
  { id: 'g1', clientId: 'deoleo', clientName: 'Deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' },
  { id: 'g2', clientId: 'brit', clientName: 'Britannia', approvalPolicy: 'AUTO_LIVE', status: 'REVOKED' },
];

describe('activeGrants', () => {
  it('keeps only ACTIVE grants', () => {
    expect(activeGrants({ grants: GRANTS }).map((g) => g.id)).toEqual(['g1']);
  });
});

describe('normalizeTenantOptions', () => {
  it('tolerates {id,name} and {clientId,clientName}', () => {
    const out = normalizeTenantOptions([
      { id: 'a', name: 'Alpha' },
      { clientId: 'b', clientName: 'Beta' },
      { clientId: 'c' },      // name falls back to id
      { name: 'no-id' },      // dropped (no id)
    ]);
    expect(out).toEqual([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'c' },
    ]);
  });
  it('returns [] for a non-array', () => {
    expect(normalizeTenantOptions(null)).toEqual([]);
  });
});

describe('ungrantedTenants', () => {
  it('excludes any tenant already granted (any status)', () => {
    const tenants = [
      { id: 'deoleo', name: 'Deoleo' },
      { id: 'brit', name: 'Britannia' },
      { id: 'new', name: 'New Co' },
    ];
    // Both deoleo (active) and brit (revoked) are taken → only 'new' is a candidate.
    expect(ungrantedTenants(tenants, GRANTS).map((t) => t.id)).toEqual(['new']);
  });
});

describe('isApprovalPolicyEnabled', () => {
  it('enables only AUTO_LIVE + GIFSY_APPROVE in v1', () => {
    expect(isApprovalPolicyEnabled('AUTO_LIVE')).toBe(true);
    expect(isApprovalPolicyEnabled('GIFSY_APPROVE')).toBe(true);
    expect(isApprovalPolicyEnabled('TENANT_APPROVE')).toBe(false);
    expect(isApprovalPolicyEnabled('EITHER')).toBe(false);
  });
});

describe('isValidPhone', () => {
  it('accepts exactly 10 digits', () => {
    expect(isValidPhone('9830011252')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('98300112521')).toBe(false);
    expect(isValidPhone('abcdefghij')).toBe(false);
  });
});

describe('validateVendorForm', () => {
  it('requires a name of at least 2 chars', () => {
    expect(validateVendorForm({ name: '' })).toHaveLength(1);
    expect(validateVendorForm({ name: 'A' })).toHaveLength(1);
    expect(validateVendorForm({ name: 'Acme' })).toEqual([]);
  });
});

describe('validateGrantForm', () => {
  it('requires a tenant and an ENABLED policy', () => {
    expect(validateGrantForm({ clientId: '', approvalPolicy: 'GIFSY_APPROVE' })).toHaveLength(1);
    expect(validateGrantForm({ clientId: 'x', approvalPolicy: 'TENANT_APPROVE' })).toHaveLength(1);
    expect(validateGrantForm({ clientId: 'x', approvalPolicy: 'AUTO_LIVE' })).toEqual([]);
    expect(grantFormToPayload({ clientId: ' x ', approvalPolicy: 'AUTO_LIVE' })).toEqual({
      clientId: 'x', approvalPolicy: 'AUTO_LIVE',
    });
  });
});

describe('validateVendorUserForm', () => {
  it('blocks a login for a tenant without an active grant', () => {
    const errs = validateVendorUserForm(
      { name: 'Ops', phone: '9830011252', clientId: 'brit' },
      ['deoleo'], // brit not active
    );
    expect(errs.some((e) => /active grant/i.test(e))).toBe(true);
  });
  it('accepts a valid login for an active-grant tenant', () => {
    expect(
      validateVendorUserForm({ name: 'Ops', phone: '9830011252', clientId: 'deoleo' }, ['deoleo']),
    ).toEqual([]);
    expect(vendorUserFormToPayload({ name: ' Ops ', phone: ' 9830011252 ', clientId: ' deoleo ' })).toEqual({
      name: 'Ops', phone: '9830011252', clientId: 'deoleo',
    });
  });
});
