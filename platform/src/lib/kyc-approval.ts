/**
 * kyc-approval.ts
 *
 * Pure, side-effect-free functions for KYC approval routing.
 * Shared between API routes (backend) and tests.
 * No Prisma, no browser APIs — safe to import anywhere.
 */

import { resolveApprover, statusForApprover, type RolePhones, type SalesRole } from './sales-role';

// ─── Role mapping ─────────────────────────────────────────────────────────────

/**
 * Maps a Prisma UserRole string to the frontend SalesRole used by resolveApprover.
 * Returns null for roles that are not part of the field sales hierarchy
 * (e.g. GIFSY_ADMIN, RETAILER).
 */
export function backendRoleToSalesRole(backendRole: string): SalesRole | null {
  const MAP: Record<string, SalesRole> = {
    SALES_ISR:        'XSR',
    SALES_SO:         'SO',
    SALES_ASM:        'ASM',
    SALES_STATE_HEAD: 'RSM',
    SALES_HO:         'NSM',
  };
  return MAP[backendRole] ?? null;
}

// ─── First-approval gate ──────────────────────────────────────────────────────

/**
 * Returns true when `backendRole` is the correct approver for `kycStatus`.
 *
 * Mapping:
 *   SALES_SO         → PENDING_SO_APPROVAL
 *   SALES_ASM        → PENDING_ASM_APPROVAL
 *   SALES_STATE_HEAD → PENDING_RSM_APPROVAL
 *
 * All other combinations (including GIFSY_ADMIN, XSR, RETAILER) return false —
 * they use separate endpoints or cannot approve.
 */
export function canFirstApprove(backendRole: string, kycStatus: string): boolean {
  return (
    (backendRole === 'SALES_SO'         && kycStatus === 'PENDING_SO_APPROVAL')  ||
    (backendRole === 'SALES_ASM'        && kycStatus === 'PENDING_ASM_APPROVAL') ||
    (backendRole === 'SALES_STATE_HEAD' && kycStatus === 'PENDING_RSM_APPROVAL')
  );
}

// ─── Status transition ────────────────────────────────────────────────────────

/**
 * Given the current KYC status (one of the PENDING_X_APPROVAL values), returns
 * the next status after the first approver acts.
 * All first-approval decisions funnel into PENDING_GIFSY for the final Gifsy check.
 */
export function nextStatusAfterFirstApprove(currentStatus: string): string {
  const FIRST_APPROVAL_STATUSES = new Set([
    'PENDING_SO_APPROVAL',
    'PENDING_ASM_APPROVAL',
    'PENDING_RSM_APPROVAL',
  ]);
  if (FIRST_APPROVAL_STATUSES.has(currentStatus)) return 'PENDING_GIFSY';
  // Caller should guard against invalid statuses, but return a safe value.
  return currentStatus;
}

// ─── Initial status on submission ────────────────────────────────────────────

/**
 * Determines which KYC status to set when a sales user submits a KYC form.
 *
 * Combines:
 *  1. backendRoleToSalesRole  — who is the submitter?
 *  2. resolveApprover         — who should approve (skipping resigned managers)?
 *  3. statusForApprover       — what KYC status string represents "waiting for them"?
 *
 * Falls back to 'SUBMITTED' for roles that should not be submitting KYCs
 * (GIFSY_ADMIN, RETAILER, etc.) so the DB entry is still created but the
 * caller can detect the anomaly.
 *
 * @param submitterBackendRole  - the Prisma UserRole of the person submitting
 * @param phones                - phone table to check for resignations
 *                                (defaults to the module-level ROLE_PHONES in sales-role.ts)
 */
export function initialKycStatus(
  submitterBackendRole: string,
  phones?: RolePhones,
): string {
  const salesRole = backendRoleToSalesRole(submitterBackendRole);
  if (!salesRole) return 'SUBMITTED'; // safe fallback for non-field roles

  const approver = phones
    ? resolveApprover(salesRole, phones)
    : resolveApprover(salesRole);

  return statusForApprover(approver);
}
