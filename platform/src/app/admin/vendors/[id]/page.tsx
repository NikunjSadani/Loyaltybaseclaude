'use client';

/**
 * /admin/vendors/[id] — vendor DETAIL (Gifsy-operator only).
 *
 * Manage one vendor: rename, suspend / reactivate (with the cascade warning), the
 * per-tenant grants table (add grant, change policy, revoke — cascade warning), and the
 * logins list (add a login pinned to ONE granted tenant, decision #12).
 *
 * Detail envelope: { success, data: VendorDetail } (detail → flat).
 * See src/lib/vendors.ts for the full endpoint/contract map (BE reconciliation).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertTriangle, Plus, Building2, Users, Pencil,
  Ban, RotateCcw, Trash2, CheckCircle2, XCircle, ShieldAlert,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  type VendorDetail,
  type VendorGrant,
  type TenantOption,
  type GrantFormState,
  type VendorUserFormState,
  type GiftApprovalPolicy,
  EMPTY_GRANT_FORM,
  EMPTY_VENDOR_USER_FORM,
  APPROVAL_POLICY_OPTIONS,
  APPROVAL_POLICY_LABEL,
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_BADGE,
  GRANT_STATUS_LABEL,
  GRANT_STATUS_BADGE,
  activeGrants,
  normalizeTenantOptions,
  ungrantedTenants,
  validateGrantForm,
  grantFormToPayload,
  validateVendorUserForm,
  vendorUserFormToPayload,
} from '@/lib/vendors';

type Toast = { msg: string; type: 'success' | 'error' };

const FIELD_CLS =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

/** The shared cascade warning shown on suspend + revoke — one honest copy block. */
const CASCADE_LINES = [
  "Hides all of the vendor's catalogue items from members immediately.",
  'Blocks the vendor’s logins from signing in.',
  'In-flight orders are NOT auto-cancelled — each needs a Gifsy cancel + refund (points returned to the member). The vendor is the sole fulfiller; there is no reassignment.',
];

export default function VendorDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);

  // Dialogs
  const [renameOpen, setRenameOpen] = useState(false);
  const [statusConfirm, setStatusConfirm] = useState<'suspend' | 'reactivate' | null>(null);
  const [addGrantOpen, setAddGrantOpen] = useState(false);
  const [revoking, setRevoking] = useState<VendorGrant | null>(null);
  const [addLoginOpen, setAddLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await api.get<VendorDetail>(`/api/admin/vendors/${id}`);
    if (res.success) setVendor(res.data);
    else setError(res.error);
    setLoading(false);
  }, [id]);

  // Tenants power the add-grant picker; a failure there is non-fatal (the rest of the
  // page still renders) — the add-grant dialog just shows a hint.
  const loadTenants = useCallback(async () => {
    const res = await api.get<{ items: unknown[] } | unknown[]>('/api/admin/tenants');
    if (res.success) {
      const raw = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      setTenants(normalizeTenantOptions(raw));
    }
  }, []);

  useEffect(() => { void load(); void loadTenants(); }, [load, loadTenants]);

  async function toggleStatus() {
    if (!vendor || busy) return;
    const nextStatus = statusConfirm === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    setBusy(true);
    const res = await api.patch<unknown>(`/api/admin/vendors/${vendor.id}`, { status: nextStatus });
    setBusy(false);
    if (res.success) {
      setStatusConfirm(null);
      showToast(nextStatus === 'SUSPENDED' ? 'Vendor suspended.' : 'Vendor reactivated.');
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  async function revokeGrant() {
    if (!vendor || !revoking || busy) return;
    setBusy(true);
    const res = await api.patch<unknown>(
      `/api/admin/vendors/${vendor.id}/grants/${revoking.id}`,
      { status: 'REVOKED' },
    );
    setBusy(false);
    if (res.success) {
      setRevoking(null);
      showToast(`Grant for "${revoking.clientName}" revoked.`);
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  async function changePolicy(grant: VendorGrant, policy: GiftApprovalPolicy) {
    if (!vendor || busy) return;
    setBusy(true);
    const res = await api.patch<unknown>(
      `/api/admin/vendors/${vendor.id}/grants/${grant.id}`,
      { approvalPolicy: policy },
    );
    setBusy(false);
    if (res.success) {
      showToast(`Policy updated for "${grant.clientName}".`);
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  if (loading) {
    return (
      <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
        Loading vendor…
      </div>
    );
  }

  if (error || !vendor) {
    return (
      <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="vendor-detail-error">
        <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
        <p className="text-red-700">{error ?? 'Vendor not found.'}</p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button onClick={() => void load()} className="px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Retry
          </button>
          <Link href="/admin/vendors" className="px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Back to vendors
          </Link>
        </div>
      </div>
    );
  }

  const grants = vendor.grants ?? [];
  const users = vendor.users ?? [];
  const activeGrantOptions = activeGrants(vendor);
  const candidateTenants = ungrantedTenants(tenants, grants);
  const suspended = vendor.status === 'SUSPENDED';

  return (
    <div className="space-y-6 fade-in">
      {/* Back + header */}
      <div>
        <Link href="/admin/vendors" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> All vendors
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Building2 className="w-5 h-5 text-[var(--brand-primary)]" />
              {vendor.name}
              <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${VENDOR_STATUS_BADGE[vendor.status]}`}>
                {VENDOR_STATUS_LABEL[vendor.status]}
              </span>
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {activeGrantOptions.length} active grant{activeGrantOptions.length !== 1 ? 's' : ''} · {users.length} login{users.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRenameOpen(true)}
              data-testid="rename-vendor-btn"
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold text-gray-600 border border-gray-300 hover:bg-gray-50"
            >
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            {suspended ? (
              <Button variant="primary" onClick={() => setStatusConfirm('reactivate')} data-testid="reactivate-btn">
                <RotateCcw className="w-4 h-4" /> Reactivate
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => setStatusConfirm('suspend')} data-testid="suspend-btn">
                <Ban className="w-4 h-4" /> Suspend
              </Button>
            )}
          </div>
        </div>
      </div>

      {suspended && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3 flex items-start gap-2 text-xs text-red-700" data-testid="suspended-banner">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            This vendor is suspended — its items are hidden from members and its logins are blocked.
            Any in-flight orders must be cancelled + refunded by Gifsy from the Gift Dispatch console.
          </span>
        </div>
      )}

      {/* Grants */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-gray-900">Tenant grants</h2>
          <button
            onClick={() => setAddGrantOpen(true)}
            data-testid="add-grant-btn"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--brand-primary)] border border-[var(--brand-primary)]/30 hover:bg-[var(--brand-primary)]/5"
          >
            <Plus className="w-3.5 h-3.5" /> Add grant
          </button>
        </div>

        {grants.length === 0 ? (
          <div className="border border-gray-200 bg-white rounded-xl px-4 py-10 text-center" data-testid="grants-empty">
            <p className="text-sm text-gray-500">
              No grants yet. Deny-by-default means this vendor can’t touch any tenant until granted.
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-left">
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Tenant</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Approval policy</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {grants.map((g) => {
                    const revoked = g.status === 'REVOKED';
                    return (
                      <tr key={g.id} className="hover:bg-gray-50 transition-colors" data-testid={`grant-row-${g.id}`}>
                        <td className="px-4 py-3 font-medium text-gray-900">{g.clientName}</td>
                        <td className="px-4 py-3">
                          {revoked ? (
                            <span className="text-gray-400 text-xs">{APPROVAL_POLICY_LABEL[g.approvalPolicy]}</span>
                          ) : (
                            <select
                              value={g.approvalPolicy}
                              data-testid={`policy-${g.id}`}
                              aria-label={`Approval policy for ${g.clientName}`}
                              onChange={(e) => void changePolicy(g, e.target.value as GiftApprovalPolicy)}
                              disabled={busy}
                              className="bg-white border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] disabled:opacity-50"
                            >
                              {APPROVAL_POLICY_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value} disabled={!o.enabled}>
                                  {o.label}{o.enabled ? '' : ' (coming soon)'}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${GRANT_STATUS_BADGE[g.status]}`}>
                            {GRANT_STATUS_LABEL[g.status]}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end">
                            {!revoked && (
                              <button
                                onClick={() => setRevoking(g)}
                                data-testid={`revoke-${g.id}`}
                                aria-label={`Revoke grant for ${g.clientName}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Revoke
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Logins */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
            <Users className="w-4 h-4 text-gray-500" /> Logins
          </h2>
          <button
            onClick={() => setAddLoginOpen(true)}
            disabled={activeGrantOptions.length === 0}
            title={activeGrantOptions.length === 0 ? 'Add an active grant first' : undefined}
            data-testid="add-login-btn"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--brand-primary)] border border-[var(--brand-primary)]/30 hover:bg-[var(--brand-primary)]/5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" /> Add login
          </button>
        </div>

        {users.length === 0 ? (
          <div className="border border-gray-200 bg-white rounded-xl px-4 py-10 text-center" data-testid="logins-empty">
            <p className="text-sm text-gray-500">
              No logins yet. Each login is pinned to a single granted tenant (a vendor serving
              multiple tenants gets one login per tenant).
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-left">
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Name</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Phone</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Tenant</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50 transition-colors" data-testid={`login-row-${u.id}`}>
                      <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                      <td className="px-4 py-3 tabular-nums text-gray-700">{u.phone}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {u.clientName ?? grants.find((g) => g.clientId === u.clientId)?.clientName ?? u.clientId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Rename modal */}
      {renameOpen && (
        <RenameVendorModal
          vendor={vendor}
          onClose={() => setRenameOpen(false)}
          onSaved={(msg) => { setRenameOpen(false); showToast(msg); void load(); }}
        />
      )}

      {/* Suspend / reactivate confirm */}
      {statusConfirm && (
        <Modal
          open
          onOpenChange={(o) => { if (!o) setStatusConfirm(null); }}
          title={statusConfirm === 'suspend' ? `Suspend “${vendor.name}”?` : `Reactivate “${vendor.name}”?`}
          className="max-w-md"
        >
          {statusConfirm === 'suspend' ? (
            <div className="space-y-3" data-testid="suspend-confirm">
              <p className="text-sm text-gray-700">Suspending this vendor has an immediate cascade:</p>
              <ul className="space-y-1.5">
                {CASCADE_LINES.map((l, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />{l}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-700" data-testid="reactivate-confirm">
              Reactivating restores the vendor’s logins and makes its approved, active items
              redeemable again. Grants that were revoked stay revoked.
            </p>
          )}
          <div className="flex items-center justify-end gap-2 mt-5">
            <button onClick={() => setStatusConfirm(null)} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">
              Cancel
            </button>
            <Button
              variant={statusConfirm === 'suspend' ? 'destructive' : 'primary'}
              onClick={() => { void toggleStatus(); }}
              loading={busy}
              data-testid="status-confirm-btn"
            >
              {statusConfirm === 'suspend' ? 'Suspend vendor' : 'Reactivate vendor'}
            </Button>
          </div>
        </Modal>
      )}

      {/* Add grant */}
      {addGrantOpen && (
        <AddGrantModal
          vendorId={vendor.id}
          candidateTenants={candidateTenants}
          tenantsLoaded={tenants.length > 0}
          onClose={() => setAddGrantOpen(false)}
          onAdded={(msg) => { setAddGrantOpen(false); showToast(msg); void load(); }}
        />
      )}

      {/* Revoke grant confirm */}
      {revoking && (
        <Modal
          open
          onOpenChange={(o) => { if (!o) setRevoking(null); }}
          title={`Revoke grant for “${revoking.clientName}”?`}
          className="max-w-md"
        >
          <div className="space-y-3" data-testid="revoke-confirm">
            <p className="text-sm text-gray-700">Revoking this grant has an immediate cascade for this tenant:</p>
            <ul className="space-y-1.5">
              {CASCADE_LINES.map((l, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />{l}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-end gap-2 mt-5">
            <button onClick={() => setRevoking(null)} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">
              Cancel
            </button>
            <Button variant="destructive" onClick={() => { void revokeGrant(); }} loading={busy} data-testid="revoke-confirm-btn">
              Revoke grant
            </Button>
          </div>
        </Modal>
      )}

      {/* Add login */}
      {addLoginOpen && (
        <AddLoginModal
          vendorId={vendor.id}
          activeGrants={activeGrantOptions}
          onClose={() => setAddLoginOpen(false)}
          onAdded={(msg) => { setAddLoginOpen(false); showToast(msg); void load(); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-[80] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Rename modal ──────────────────────────────────────────────────────────────

function RenameVendorModal({
  vendor, onClose, onSaved,
}: {
  vendor: VendorDetail;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(vendor.name);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function handleSave() {
    if (trimmed.length < 2 || saving) return;
    setSaving(true);
    setSaveError(null);
    const res = await api.patch<unknown>(`/api/admin/vendors/${vendor.id}`, { name: trimmed });
    setSaving(false);
    if (res.success) onSaved('Vendor renamed.');
    else setSaveError(res.error);
  }

  return (
    <Modal open onOpenChange={(o) => { if (!o) onClose(); }} title="Rename vendor" className="max-w-md">
      <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="rename-input">
        Vendor name<span className="text-[var(--brand-primary)]"> *</span>
      </label>
      <input
        id="rename-input"
        type="text"
        value={name}
        data-testid="rename-input"
        onChange={(e) => setName(e.target.value)}
        className={FIELD_CLS}
      />
      {saveError && (
        <p className="flex items-start gap-1.5 text-xs text-red-600 mt-3" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{saveError}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
        <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} disabled={trimmed.length < 2} data-testid="rename-save-btn">
          Save
        </Button>
      </div>
    </Modal>
  );
}

// ── Add grant modal ─────────────────────────────────────────────────────────────

function AddGrantModal({
  vendorId, candidateTenants, tenantsLoaded, onClose, onAdded,
}: {
  vendorId: string;
  candidateTenants: TenantOption[];
  tenantsLoaded: boolean;
  onClose: () => void;
  onAdded: (msg: string) => void;
}) {
  const [form, setForm] = useState<GrantFormState>(EMPTY_GRANT_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => { if (touched) setErrors(validateGrantForm(form)); }, [form, touched]);

  async function handleSave() {
    const errs = validateGrantForm(form);
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    const res = await api.post<unknown>(`/api/admin/vendors/${vendorId}/grants`, grantFormToPayload(form));
    setSaving(false);
    inFlight.current = false;
    if (res.success) {
      const name = candidateTenants.find((t) => t.id === form.clientId)?.name ?? 'tenant';
      onAdded(`Granted to "${name}".`);
    } else {
      setSaveError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Add tenant grant"
      description="Grant this vendor to a tenant and set how its items are moderated for that tenant."
      className="max-w-md"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="grant-tenant">
            Tenant<span className="text-[var(--brand-primary)]"> *</span>
          </label>
          <select
            id="grant-tenant"
            value={form.clientId}
            data-testid="grant-tenant-select"
            onChange={(e) => setForm((p) => ({ ...p, clientId: e.target.value }))}
            className={FIELD_CLS}
          >
            <option value="">Select a tenant…</option>
            {candidateTenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {tenantsLoaded && candidateTenants.length === 0 && (
            <p className="text-[11px] text-amber-600 mt-1">
              This vendor is already granted to every tenant.
            </p>
          )}
          {!tenantsLoaded && (
            <p className="text-[11px] text-amber-600 mt-1">
              Couldn’t load the tenant list — refresh and try again.
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="grant-policy">
            Approval policy<span className="text-[var(--brand-primary)]"> *</span>
          </label>
          <select
            id="grant-policy"
            value={form.approvalPolicy}
            data-testid="grant-policy-select"
            onChange={(e) => setForm((p) => ({ ...p, approvalPolicy: e.target.value as GiftApprovalPolicy }))}
            className={FIELD_CLS}
          >
            {APPROVAL_POLICY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={!o.enabled}>
                {o.label}{o.enabled ? '' : ' (coming soon)'}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            Gifsy-approve holds each item for review; Auto-live publishes within price bounds.
            Tenant-approve / Either arrive in a later release.
          </p>
        </div>

        {errors.length > 0 && (
          <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1" data-testid="grant-errors">
            {errors.map((e, i) => (
              <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-600">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{e}
              </p>
            ))}
          </div>
        )}
        {saveError && (
          <p className="flex items-start gap-1.5 text-xs text-red-600" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{saveError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
        <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="grant-save-btn">
          Add grant
        </Button>
      </div>
    </Modal>
  );
}

// ── Add login modal ─────────────────────────────────────────────────────────────

function AddLoginModal({
  vendorId, activeGrants: grants, onClose, onAdded,
}: {
  vendorId: string;
  activeGrants: VendorGrant[];
  onClose: () => void;
  onAdded: (msg: string) => void;
}) {
  const [form, setForm] = useState<VendorUserFormState>(() => ({
    ...EMPTY_VENDOR_USER_FORM,
    // Pre-select the only granted tenant so the common single-tenant case is one field less.
    clientId: grants.length === 1 ? grants[0].clientId : '',
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const activeGrantClientIds = useMemo(() => grants.map((g) => g.clientId), [grants]);

  useEffect(() => {
    if (touched) setErrors(validateVendorUserForm(form, activeGrantClientIds));
  }, [form, touched, activeGrantClientIds]);

  async function handleSave() {
    const errs = validateVendorUserForm(form, activeGrantClientIds);
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    const res = await api.post<unknown>(`/api/admin/vendors/${vendorId}/users`, vendorUserFormToPayload(form));
    setSaving(false);
    inFlight.current = false;
    if (res.success) onAdded(`Login created for "${form.name.trim()}".`);
    else setSaveError(res.error);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Add vendor login"
      description="Creates a login for ONE granted tenant. A vendor serving multiple tenants gets one login per tenant."
      className="max-w-md"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="login-name">
            Name<span className="text-[var(--brand-primary)]"> *</span>
          </label>
          <input
            id="login-name" type="text" value={form.name} data-testid="login-name-input"
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className={FIELD_CLS}
            placeholder="e.g. Acme Ops (Deoleo)"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="login-phone">
            Mobile (login)<span className="text-[var(--brand-primary)]"> *</span>
          </label>
          <input
            id="login-phone" type="text" inputMode="numeric" value={form.phone} data-testid="login-phone-input"
            onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
            className={FIELD_CLS} placeholder="10-digit mobile number"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="login-tenant">
            Serves tenant<span className="text-[var(--brand-primary)]"> *</span>
          </label>
          <select
            id="login-tenant" value={form.clientId} data-testid="login-tenant-select"
            onChange={(e) => setForm((p) => ({ ...p, clientId: e.target.value }))} className={FIELD_CLS}
          >
            <option value="">Select a granted tenant…</option>
            {grants.map((g) => (
              <option key={g.id} value={g.clientId}>{g.clientName}</option>
            ))}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            Only tenants with an active grant appear here (decision #12: one tenant per login).
          </p>
        </div>

        {errors.length > 0 && (
          <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1" data-testid="login-errors">
            {errors.map((e, i) => (
              <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-600">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{e}
              </p>
            ))}
          </div>
        )}
        {saveError && (
          <p className="flex items-start gap-1.5 text-xs text-red-600" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{saveError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
        <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="login-save-btn">
          Create login
        </Button>
      </div>
    </Modal>
  );
}
