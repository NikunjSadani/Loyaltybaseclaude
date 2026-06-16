/**
 * kyc-approval.helper.ts
 *
 * Pure, side-effect-free KYC approval routing logic — ported from
 * platform/src/lib/kyc-approval.ts (+ the routing parts of lib/sales-role.ts).
 * No Prisma, no I/O. Shared by KycService and its unit tests.
 *
 * The field-sales hierarchy is XSR → SO → ASM → RSM → ZNM → NSM. A submission
 * routes to the first non-resigned manager above the submitter; resignation is
 * signalled by a blank phone in ROLE_PHONES (the org-chain seam preserved from
 * the source; in production this table would come from the backend).
 */

export type SalesRole = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZNM' | 'NSM';

export type RolePhones = Record<SalesRole, string>;

/** Role immediately above in the hierarchy (for KYC approval routing). */
const REPORTS_TO: Partial<Record<SalesRole, SalesRole>> = {
  XSR: 'SO',
  SO: 'ASM',
  ASM: 'RSM',
  RSM: 'ZNM',
  ZNM: 'NSM',
};

/**
 * Phone numbers per role in the approval chain. A blank string ('') signals a
 * resigned manager who must be skipped during routing.
 */
export const ROLE_PHONES: RolePhones = {
  XSR: '9900000041',
  SO: '9900000028',
  ASM: '9900000007',
  RSM: '9900000003',
  ZNM: '9900000002',
  NSM: '9900000001',
};

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
 * Walk up the REPORTS_TO chain from the immediate superior of `submitterRole`,
 * skipping any role whose phone is blank (resigned). Returns the first
 * non-resigned approver; falls back to NSM.
 */
export function resolveApprover(
  submitterRole: SalesRole,
  phones: RolePhones = ROLE_PHONES,
): SalesRole {
  let current: SalesRole | undefined = REPORTS_TO[submitterRole];
  while (current) {
    if (phones[current] !== '') return current;
    current = REPORTS_TO[current];
  }
  return 'NSM';
}

/** Map a resolved approver role → the KycStatus value meaning "awaiting them". */
export function statusForApprover(approverRole: SalesRole): string {
  const map: Partial<Record<SalesRole, string>> = {
    SO: 'PENDING_SO_APPROVAL',
    ASM: 'PENDING_ASM_APPROVAL',
    RSM: 'PENDING_RSM_APPROVAL',
    ZNM: 'PENDING_RSM_APPROVAL',
    NSM: 'PENDING_RSM_APPROVAL',
  };
  return map[approverRole] ?? 'PENDING_SO_APPROVAL';
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

/**
 * Determines the initial KYC status when a sales user submits a KYC form.
 * Falls back to 'SUBMITTED' for non-field roles (GIFSY_ADMIN, RETAILER, etc.).
 */
export function initialKycStatus(submitterBackendRole: string, phones?: RolePhones): string {
  const salesRole = backendRoleToSalesRole(submitterBackendRole);
  if (!salesRole) return 'SUBMITTED';

  const approver = phones ? resolveApprover(salesRole, phones) : resolveApprover(salesRole);
  return statusForApprover(approver);
}

/**
 * Detects whether an approval level was skipped due to resignation, returning
 * the skipped role label for the status-history note (or null). Preserved from
 * the source POST /api/kyc route handler.
 */
export function detectEscalation(backendRole: string, resolvedStatus: string): string | null {
  const SKIPPED_ROLE: Record<string, string> = {
    'SALES_ISR:PENDING_ASM_APPROVAL': 'SO',
    'SALES_ISR:PENDING_RSM_APPROVAL': 'SO',
    'SALES_SO:PENDING_RSM_APPROVAL': 'ASM',
  };
  const key = `${backendRole}:${resolvedStatus}`;
  return SKIPPED_ROLE[key] ?? null;
}
