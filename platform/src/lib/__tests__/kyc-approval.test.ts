/**
 * TDD tests for backend KYC approval logic.
 *
 * Pure functions — no Prisma, no DB, no HTTP.
 *
 * Covers:
 *  A) backendRoleToSalesRole  — maps DB UserRole → SalesRole
 *  B) canFirstApprove         — which backend role can act on which KYC status
 *  C) nextStatusAfterFirstApprove — what status results from a first-approval
 *  D) initialKycStatus        — what status is set when a KYC is submitted
 *                               (wraps resolveApprover + statusForApprover)
 */

import { describe, it, expect } from 'vitest';
import {
  backendRoleToSalesRole,
  canFirstApprove,
  nextStatusAfterFirstApprove,
  initialKycStatus,
} from '../kyc-approval';
import type { RolePhones } from '../sales-role';

/* ─── Fixtures ──────────────────────────────────────────────────────────────── */

const ALL_PRESENT: RolePhones = {
  XSR: '9900000041', SO: '9900000028', ASM: '9900000007',
  RSM: '9900000003', ZM: '9900000002', NM: '9900000001',
};
const SO_RESIGNED: RolePhones  = { ...ALL_PRESENT, SO: '' };
const ASM_RESIGNED: RolePhones = { ...ALL_PRESENT, ASM: '' };
const SO_AND_ASM_RESIGNED: RolePhones = { ...ALL_PRESENT, SO: '', ASM: '' };

/* ─── A: backendRoleToSalesRole ─────────────────────────────────────────────── */

describe('backendRoleToSalesRole', () => {
  it('maps SALES_ISR → XSR', () => {
    expect(backendRoleToSalesRole('SALES_ISR')).toBe('XSR');
  });
  it('maps SALES_SO → SO', () => {
    expect(backendRoleToSalesRole('SALES_SO')).toBe('SO');
  });
  it('maps SALES_ASM → ASM', () => {
    expect(backendRoleToSalesRole('SALES_ASM')).toBe('ASM');
  });
  it('maps SALES_STATE_HEAD → RSM', () => {
    expect(backendRoleToSalesRole('SALES_STATE_HEAD')).toBe('RSM');
  });
  it('maps SALES_HO → NSM', () => {
    expect(backendRoleToSalesRole('SALES_HO')).toBe('NSM');
  });
  it('returns null for non-sales roles', () => {
    expect(backendRoleToSalesRole('GIFSY_ADMIN')).toBeNull();
    expect(backendRoleToSalesRole('SSS')).toBeNull();
  });
});

/* ─── B: canFirstApprove ────────────────────────────────────────────────────── */

describe('canFirstApprove', () => {
  it('SO can approve PENDING_SO_APPROVAL', () => {
    expect(canFirstApprove('SALES_SO', 'PENDING_SO_APPROVAL')).toBe(true);
  });
  it('SO cannot approve PENDING_ASM_APPROVAL', () => {
    expect(canFirstApprove('SALES_SO', 'PENDING_ASM_APPROVAL')).toBe(false);
  });
  it('SO cannot approve PENDING_RSM_APPROVAL', () => {
    expect(canFirstApprove('SALES_SO', 'PENDING_RSM_APPROVAL')).toBe(false);
  });

  it('ASM can approve PENDING_ASM_APPROVAL', () => {
    expect(canFirstApprove('SALES_ASM', 'PENDING_ASM_APPROVAL')).toBe(true);
  });
  it('ASM cannot approve PENDING_SO_APPROVAL', () => {
    expect(canFirstApprove('SALES_ASM', 'PENDING_SO_APPROVAL')).toBe(false);
  });
  it('ASM cannot approve PENDING_RSM_APPROVAL', () => {
    expect(canFirstApprove('SALES_ASM', 'PENDING_RSM_APPROVAL')).toBe(false);
  });

  it('RSM (SALES_STATE_HEAD) can approve PENDING_RSM_APPROVAL', () => {
    expect(canFirstApprove('SALES_STATE_HEAD', 'PENDING_RSM_APPROVAL')).toBe(true);
  });
  it('RSM cannot approve PENDING_SO_APPROVAL', () => {
    expect(canFirstApprove('SALES_STATE_HEAD', 'PENDING_SO_APPROVAL')).toBe(false);
  });
  it('RSM cannot approve PENDING_ASM_APPROVAL', () => {
    expect(canFirstApprove('SALES_STATE_HEAD', 'PENDING_ASM_APPROVAL')).toBe(false);
  });

  it('GIFSY_ADMIN cannot first-approve (uses the final-approve endpoint)', () => {
    expect(canFirstApprove('GIFSY_ADMIN', 'PENDING_SO_APPROVAL')).toBe(false);
    expect(canFirstApprove('GIFSY_ADMIN', 'PENDING_GIFSY')).toBe(false);
  });
  it('XSR (SALES_ISR) cannot approve anything', () => {
    expect(canFirstApprove('SALES_ISR', 'PENDING_SO_APPROVAL')).toBe(false);
  });
  it('returns false for non-pending statuses', () => {
    expect(canFirstApprove('SALES_SO', 'APPROVED')).toBe(false);
    expect(canFirstApprove('SALES_SO', 'REJECTED')).toBe(false);
    expect(canFirstApprove('SALES_ASM', 'PENDING_GIFSY')).toBe(false);
  });
});

/* ─── C: nextStatusAfterFirstApprove ───────────────────────────────────────── */

describe('nextStatusAfterFirstApprove', () => {
  it('PENDING_SO_APPROVAL → PENDING_GIFSY', () => {
    expect(nextStatusAfterFirstApprove('PENDING_SO_APPROVAL')).toBe('PENDING_GIFSY');
  });
  it('PENDING_ASM_APPROVAL → PENDING_GIFSY', () => {
    expect(nextStatusAfterFirstApprove('PENDING_ASM_APPROVAL')).toBe('PENDING_GIFSY');
  });
  it('PENDING_RSM_APPROVAL → PENDING_GIFSY', () => {
    expect(nextStatusAfterFirstApprove('PENDING_RSM_APPROVAL')).toBe('PENDING_GIFSY');
  });
});

/* ─── D: initialKycStatus ───────────────────────────────────────────────────── */

describe('initialKycStatus — from backend role + phone table', () => {
  it('SALES_ISR submits, all present → PENDING_SO_APPROVAL', () => {
    expect(initialKycStatus('SALES_ISR', ALL_PRESENT)).toBe('PENDING_SO_APPROVAL');
  });
  it('SALES_ISR submits, SO resigned → PENDING_ASM_APPROVAL', () => {
    expect(initialKycStatus('SALES_ISR', SO_RESIGNED)).toBe('PENDING_ASM_APPROVAL');
  });
  it('SALES_ISR submits, SO+ASM resigned → PENDING_RSM_APPROVAL', () => {
    expect(initialKycStatus('SALES_ISR', SO_AND_ASM_RESIGNED)).toBe('PENDING_RSM_APPROVAL');
  });
  it('SALES_SO submits, ASM present → PENDING_ASM_APPROVAL', () => {
    expect(initialKycStatus('SALES_SO', ALL_PRESENT)).toBe('PENDING_ASM_APPROVAL');
  });
  it('SALES_SO submits, ASM resigned → PENDING_RSM_APPROVAL', () => {
    expect(initialKycStatus('SALES_SO', ASM_RESIGNED)).toBe('PENDING_RSM_APPROVAL');
  });
  it('unknown/non-submitter role → SUBMITTED (safe fallback)', () => {
    expect(initialKycStatus('GIFSY_ADMIN', ALL_PRESENT)).toBe('SUBMITTED');
    expect(initialKycStatus('SSS', ALL_PRESENT)).toBe('SUBMITTED');
  });
});
