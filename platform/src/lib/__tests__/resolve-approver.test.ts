/**
 * TDD tests for KYC approval escalation logic.
 *
 * Signal: blank phone number in ROLE_PHONES = that person has resigned.
 * resolveApprover(submitterRole, phones) walks REPORTS_TO chain upward and
 * returns the first non-resigned approver role.
 *
 * statusForApprover(approverRole) maps an approver role → KYCStatus pending value.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveApprover,
  statusForApprover,
  type RolePhones,
} from '../sales-role';

/* ─── Fixtures ──────────────────────────────────────────────────────────────── */

const ALL_PRESENT: RolePhones = {
  XSR: '9900000041',
  SO:  '9900000028',
  ASM: '9900000007',
  RSM: '9900000003',
  ZM:  '9900000002',
  NM:  '9900000001',
};

const SO_RESIGNED: RolePhones  = { ...ALL_PRESENT, SO: '' };
const ASM_RESIGNED: RolePhones = { ...ALL_PRESENT, ASM: '' };
const SO_AND_ASM_RESIGNED: RolePhones = { ...ALL_PRESENT, SO: '', ASM: '' };

/* ─── resolveApprover ───────────────────────────────────────────────────────── */

describe('resolveApprover — XSR submitter', () => {
  it('returns SO when SO has a phone (normal case)', () => {
    expect(resolveApprover('XSR', ALL_PRESENT)).toBe('SO');
  });

  it('returns ASM when SO phone is blank (SO resigned)', () => {
    expect(resolveApprover('XSR', SO_RESIGNED)).toBe('ASM');
  });

  it('returns RSM when SO and ASM are both blank', () => {
    expect(resolveApprover('XSR', SO_AND_ASM_RESIGNED)).toBe('RSM');
  });
});

describe('resolveApprover — SO submitter', () => {
  it('returns ASM when ASM has a phone (normal case)', () => {
    expect(resolveApprover('SO', ALL_PRESENT)).toBe('ASM');
  });

  it('returns RSM when ASM phone is blank (ASM resigned)', () => {
    expect(resolveApprover('SO', ASM_RESIGNED)).toBe('RSM');
  });
});

describe('resolveApprover — higher submitters', () => {
  it('returns RSM when ASM submits (normal case)', () => {
    expect(resolveApprover('ASM', ALL_PRESENT)).toBe('RSM');
  });

  it('returns ZM when ASM submits and RSM is resigned', () => {
    const RSM_RESIGNED: RolePhones = { ...ALL_PRESENT, RSM: '' };
    expect(resolveApprover('ASM', RSM_RESIGNED)).toBe('ZM');
  });
});

/* ─── statusForApprover ─────────────────────────────────────────────────────── */

describe('statusForApprover', () => {
  it('maps SO → PENDING_SO_APPROVAL', () => {
    expect(statusForApprover('SO')).toBe('PENDING_SO_APPROVAL');
  });

  it('maps ASM → PENDING_ASM_APPROVAL', () => {
    expect(statusForApprover('ASM')).toBe('PENDING_ASM_APPROVAL');
  });

  it('maps RSM → PENDING_RSM_APPROVAL', () => {
    expect(statusForApprover('RSM')).toBe('PENDING_RSM_APPROVAL');
  });
});

/* ─── Integration: resolveApprover + statusForApprover ─────────────────────── */

describe('Escalation end-to-end status routing', () => {
  it('XSR + all present → PENDING_SO_APPROVAL', () => {
    expect(statusForApprover(resolveApprover('XSR', ALL_PRESENT))).toBe('PENDING_SO_APPROVAL');
  });

  it('XSR + SO resigned → PENDING_ASM_APPROVAL', () => {
    expect(statusForApprover(resolveApprover('XSR', SO_RESIGNED))).toBe('PENDING_ASM_APPROVAL');
  });

  it('XSR + SO & ASM resigned → PENDING_RSM_APPROVAL', () => {
    expect(statusForApprover(resolveApprover('XSR', SO_AND_ASM_RESIGNED))).toBe('PENDING_RSM_APPROVAL');
  });

  it('SO + all present → PENDING_ASM_APPROVAL', () => {
    expect(statusForApprover(resolveApprover('SO', ALL_PRESENT))).toBe('PENDING_ASM_APPROVAL');
  });

  it('SO + ASM resigned → PENDING_RSM_APPROVAL', () => {
    expect(statusForApprover(resolveApprover('SO', ASM_RESIGNED))).toBe('PENDING_RSM_APPROVAL');
  });
});
