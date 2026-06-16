/**
 * kyc-approval.helper.ts
 *
 * Pure, side-effect-free KYC approval routing logic — ported from
 * platform/src/lib/kyc-approval.ts (+ the routing parts of lib/sales-role.ts).
 * No Prisma, no I/O. Shared by KycService and its unit tests.
 *
 * The field-sales hierarchy is XSR → SO → ASM → RSM → ZNM → NSM.
 * Initial-status routing is now DB-backed (KycService.resolveInitialRouting),
 * walking the real SalesUser reporting tree (the former hardcoded constant is retired)
 * constant. The pure helpers here handle everything that happens AFTER a
 * submission exists (first-approve gate, status transitions, role mapping).
 */

export type SalesRole = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZNM' | 'NSM';

/**
 * Maps a Prisma UserRole string to the field SalesRole. Returns null for roles
 * outside the field-sales hierarchy (e.g. GIFSY_ADMIN, RETAILER).
 */
export function backendRoleToSalesRole(backendRole: string): SalesRole | null {
  const MAP: Record<string, SalesRole> = {
    SALES_ISR: 'XSR',
    SALES_SO: 'SO',
    SALES_ASM: 'ASM',
    SALES_STATE_HEAD: 'RSM',
    SALES_HO: 'NSM',
  };
  return MAP[backendRole] ?? null;
}

/**
 * Map a hierarchy level code → the KycStatus value meaning "awaiting that level".
 * RSM, ZNM, NSM all collapse to PENDING_RSM_APPROVAL (the single RSM bucket).
 * Exported so KycService.resolveInitialRouting can reuse it without duplicating
 * the mapping logic.
 */
export function statusForApproverCode(levelCode: string): string {
  const map: Record<string, string> = {
    SO: 'PENDING_SO_APPROVAL',
    ASM: 'PENDING_ASM_APPROVAL',
    RSM: 'PENDING_RSM_APPROVAL',
    ZNM: 'PENDING_RSM_APPROVAL',
    NSM: 'PENDING_RSM_APPROVAL',
  };
  return map[levelCode] ?? 'PENDING_SO_APPROVAL';
}

/**
 * Returns true when `backendRole` is the correct first-approver for `kycStatus`.
 *   SALES_SO         → PENDING_SO_APPROVAL
 *   SALES_ASM        → PENDING_ASM_APPROVAL
 *   SALES_STATE_HEAD → PENDING_RSM_APPROVAL
 */
export function canFirstApprove(backendRole: string, kycStatus: string): boolean {
  return (
    (backendRole === 'SALES_SO' && kycStatus === 'PENDING_SO_APPROVAL') ||
    (backendRole === 'SALES_ASM' && kycStatus === 'PENDING_ASM_APPROVAL') ||
    (backendRole === 'SALES_STATE_HEAD' && kycStatus === 'PENDING_RSM_APPROVAL')
  );
}

/**
 * Given the current PENDING_X_APPROVAL status, returns the next status after the
 * first approver acts. All first-approval decisions funnel into PENDING_GIFSY.
 */
export function nextStatusAfterFirstApprove(currentStatus: string): string {
  const FIRST_APPROVAL_STATUSES = new Set([
    'PENDING_SO_APPROVAL',
    'PENDING_ASM_APPROVAL',
    'PENDING_RSM_APPROVAL',
  ]);
  if (FIRST_APPROVAL_STATUSES.has(currentStatus)) return 'PENDING_GIFSY';
  return currentStatus;
}
