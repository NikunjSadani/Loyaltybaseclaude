/* ─── Gift VENDORS (Wave-2) — shared types + pure helpers ─────────────────────
   The Gifsy-operator vendor-management surface (/admin/vendors, GIFSY_ADMIN only):
   platform vendor entities, per-tenant grants (deny-by-default, mirroring the RBAC
   *TenantGrant pattern), per-grant approvalPolicy, and one-tenant-per-login vendor
   users (decision #12).

   Design source of truth: platform/docs/plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md
   (§1 decisions #6/#7/#9/#12, §3 data model, §12 suspend/revoke cascade).

   Kept pure (no fetch/DOM) so validation + payload builders are unit-testable
   without rendering — mirrors src/lib/gift-catalogue.ts / src/lib/gift-orders.ts.

   BE reconciliation (endpoints consumed; FE `/api/*` → backend `/v1/*`):
     GET   /api/admin/vendors                    → { items: VendorSummary[] }
     GET   /api/admin/vendors/:id                → flat VendorDetail (grants + users)
     POST  /api/admin/vendors            { name }
     PATCH /api/admin/vendors/:id        { name?, status? }
     POST  /api/admin/vendors/:id/grants { clientId, approvalPolicy }
     PATCH /api/admin/vendors/:id/grants/:grantId { approvalPolicy?, status? }
     POST  /api/admin/vendors/:id/users  { phone, name, clientId }
     GET   /api/admin/tenants                    → { items: TenantOption[] }  (add-grant picker; FLAGGED — see below)
────────────────────────────────────────────────────────────────────────────── */

// ── Enums (mirror the additive Prisma enums in §3) ─────────────────────────────

export type VendorStatus = 'ACTIVE' | 'SUSPENDED';
export type VendorGrantStatus = 'ACTIVE' | 'REVOKED';

/** Per-grant moderation policy (§1 decision #7). v1 implements AUTO_LIVE + GIFSY_APPROVE;
 *  TENANT_APPROVE / EITHER are enum-declared but not yet built (shown disabled = "coming soon"). */
export type GiftApprovalPolicy = 'AUTO_LIVE' | 'GIFSY_APPROVE' | 'TENANT_APPROVE' | 'EITHER';

export const VENDOR_STATUS_LABEL: Record<VendorStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};

export const VENDOR_STATUS_BADGE: Record<VendorStatus, string> = {
  ACTIVE: 'bg-green-50 text-green-700 border-green-100',
  SUSPENDED: 'bg-red-50 text-red-600 border-red-100',
};

export const GRANT_STATUS_LABEL: Record<VendorGrantStatus, string> = {
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
};

export const GRANT_STATUS_BADGE: Record<VendorGrantStatus, string> = {
  ACTIVE: 'bg-green-50 text-green-700 border-green-100',
  REVOKED: 'bg-gray-50 text-gray-500 border-gray-200',
};

export const APPROVAL_POLICY_LABEL: Record<GiftApprovalPolicy, string> = {
  AUTO_LIVE: 'Auto-live (no review)',
  GIFSY_APPROVE: 'Gifsy approves each item',
  TENANT_APPROVE: 'Tenant approves',
  EITHER: 'Either (hybrid)',
};

/** The approval-policy picker options. `enabled:false` renders disabled with a "coming soon"
 *  hint — v1 only supports AUTO_LIVE + GIFSY_APPROVE (§1 decision #7). */
export const APPROVAL_POLICY_OPTIONS: {
  value: GiftApprovalPolicy;
  label: string;
  enabled: boolean;
}[] = [
  { value: 'GIFSY_APPROVE', label: APPROVAL_POLICY_LABEL.GIFSY_APPROVE, enabled: true },
  { value: 'AUTO_LIVE', label: APPROVAL_POLICY_LABEL.AUTO_LIVE, enabled: true },
  { value: 'TENANT_APPROVE', label: APPROVAL_POLICY_LABEL.TENANT_APPROVE, enabled: false },
  { value: 'EITHER', label: APPROVAL_POLICY_LABEL.EITHER, enabled: false },
];

export function isApprovalPolicyEnabled(p: GiftApprovalPolicy): boolean {
  return APPROVAL_POLICY_OPTIONS.find((o) => o.value === p)?.enabled ?? false;
}

// ── Wire contracts (flag any BE mismatch; do not silently guess) ───────────────

/** One per-tenant grant on a vendor. */
export interface VendorGrant {
  id: string;
  clientId: string;
  clientName: string;
  approvalPolicy: GiftApprovalPolicy;
  status: VendorGrantStatus;
}

/** GET /api/admin/vendors → { items: VendorSummary[] } (list → { items }). */
export interface VendorSummary {
  id: string;
  name: string;
  status: VendorStatus;
  grants: VendorGrant[];
  userCount: number;
}

/** A vendor login (reuses the User model with role=VENDOR + vendorId; §3). Pinned to
 *  ONE tenant per login (decision #12). */
export interface VendorUser {
  id: string;
  name: string;
  phone: string;
  clientId: string;
  clientName?: string | null;
  status?: string | null;
}

/** GET /api/admin/vendors/:id → flat VendorDetail (detail → flat).
 *  Extends the summary with the login list. FLAGGED for BE: the detail GET must return
 *  `users` (the summary only carries `userCount`). */
export interface VendorDetail extends VendorSummary {
  users: VendorUser[];
  createdAt?: string | null;
}

/** GET /api/admin/tenants → { items: TenantOption[] } — candidate tenants for a new grant.
 *  FLAGGED for BE: no dedicated tenants-list endpoint was found in the FE today. If a
 *  different path/shape exists, point this GET at it. Both `{id}`/`{clientId}` and
 *  `{name}`/`{clientName}` key spellings are tolerated by `normalizeTenantOptions`. */
export interface TenantOption {
  id: string;
  name: string;
}

// ── Add / edit form state ──────────────────────────────────────────────────────

export interface VendorFormState {
  name: string;
}

export const EMPTY_VENDOR_FORM: VendorFormState = { name: '' };

export interface GrantFormState {
  clientId: string;
  approvalPolicy: GiftApprovalPolicy;
}

export const EMPTY_GRANT_FORM: GrantFormState = {
  clientId: '',
  approvalPolicy: 'GIFSY_APPROVE',
};

export interface VendorUserFormState {
  name: string;
  phone: string;
  clientId: string;
}

export const EMPTY_VENDOR_USER_FORM: VendorUserFormState = {
  name: '',
  phone: '',
  clientId: '',
};

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** Only the ACTIVE grants — the tenants a vendor may currently act for (login target set). */
export function activeGrants(v: Pick<VendorSummary, 'grants'>): VendorGrant[] {
  return (v.grants ?? []).filter((g) => g.status === 'ACTIVE');
}

/** Tolerate both `{id,name}` and `{clientId,clientName}` shapes from the tenants endpoint. */
export function normalizeTenantOptions(raw: unknown): TenantOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = r as Record<string, unknown>;
      const id = (o.id ?? o.clientId) as string | undefined;
      const name = (o.name ?? o.clientName) as string | undefined;
      return id ? { id, name: name ?? id } : null;
    })
    .filter((x): x is TenantOption => x != null);
}

/** Tenants NOT already granted (any status) — candidates for a NEW grant. Prevents a
 *  duplicate `@@unique([vendorId, clientId])` collision at the BE. */
export function ungrantedTenants(
  tenants: TenantOption[],
  grants: VendorGrant[],
): TenantOption[] {
  const taken = new Set((grants ?? []).map((g) => g.clientId));
  return tenants.filter((t) => !taken.has(t.id));
}

export function validateVendorForm(form: VendorFormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Vendor name is required.');
  else if (form.name.trim().length < 2) errors.push('Vendor name is too short.');
  return errors;
}

export function vendorFormToPayload(form: VendorFormState): Record<string, unknown> {
  return { name: form.name.trim() };
}

export function validateGrantForm(form: GrantFormState): string[] {
  const errors: string[] = [];
  if (!form.clientId.trim()) errors.push('Pick a tenant to grant.');
  if (!isApprovalPolicyEnabled(form.approvalPolicy)) {
    errors.push('That approval policy is not available yet — pick Gifsy-approve or Auto-live.');
  }
  return errors;
}

export function grantFormToPayload(form: GrantFormState): Record<string, unknown> {
  return { clientId: form.clientId.trim(), approvalPolicy: form.approvalPolicy };
}

/** A 10-digit Indian mobile (the login handle). Mirrors the redeem/KYC phone rule. */
export function isValidPhone(phone: string): boolean {
  return /^\d{10}$/.test(phone.trim());
}

export function validateVendorUserForm(
  form: VendorUserFormState,
  activeGrantClientIds: string[],
): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Login name is required.');
  if (!isValidPhone(form.phone)) errors.push('Enter a valid 10-digit mobile number.');
  if (!form.clientId.trim()) {
    errors.push('Pick the tenant this login serves.');
  } else if (!activeGrantClientIds.includes(form.clientId.trim())) {
    // Guard #12 + the deny-by-default grant model: a login can only be created for a
    // tenant the vendor holds an ACTIVE grant for. The BE re-validates; this is the
    // fast, honest client-side block so we never POST a doomed request.
    errors.push('This login can only be created for a tenant with an active grant.');
  }
  return errors;
}

export function vendorUserFormToPayload(form: VendorUserFormState): Record<string, unknown> {
  return { name: form.name.trim(), phone: form.phone.trim(), clientId: form.clientId.trim() };
}
