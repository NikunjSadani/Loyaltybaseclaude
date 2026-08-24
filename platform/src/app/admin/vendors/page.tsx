'use client';

/**
 * /admin/vendors — vendor LIST (Gifsy-operator only).
 *
 * Lists platform vendors with their per-tenant grants + login count. Create a vendor
 * here; click through to a vendor to manage grants, logins, and suspend/reactivate.
 *
 * List envelope: { success, data: { items: VendorSummary[] } } (list → { items }).
 * See src/lib/vendors.ts for the full endpoint/contract map (BE reconciliation).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Building2, Plus, Loader2, AlertTriangle, Search, ChevronRight,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  type VendorSummary,
  type VendorFormState,
  type VendorStatus,
  EMPTY_VENDOR_FORM,
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_BADGE,
  activeGrants,
  validateVendorForm,
  vendorFormToPayload,
} from '@/lib/vendors';

type Toast = { msg: string; type: 'success' | 'error' };

export default function VendorListPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<VendorSummary[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | VendorStatus>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<{ items: VendorSummary[] } | VendorSummary[]>('/api/admin/vendors');
    if (res.success) {
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((v) => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        (v.grants ?? []).some((g) => g.clientName.toLowerCase().includes(q))
      );
    });
  }, [items, query, statusFilter]);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-[var(--brand-primary)]" />
            Vendors
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Third-party fulfilment partners. Grant a vendor to specific tenants, set its
            per-tenant moderation policy, and create its logins. Deny-by-default: no grant,
            no access.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)} data-testid="new-vendor-btn">
          <Plus className="w-4 h-4" />
          New vendor
        </Button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by vendor or tenant…"
            aria-label="Search vendors"
            data-testid="vendor-search"
            className="w-full bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | VendorStatus)}
          aria-label="Filter by status"
          data-testid="vendor-status-filter"
          className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)]"
        >
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </div>

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading vendors…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="vendor-error">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button onClick={() => void load()} className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && visible.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center" data-testid="vendor-empty">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Building2 className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">
            {items.length === 0 ? 'No vendors yet' : 'No matches'}
          </h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {items.length === 0
              ? 'Create your first vendor, then grant it to the tenants it will fulfil for.'
              : 'Try a different search or status filter.'}
          </p>
          {items.length === 0 && (
            <Button variant="primary" onClick={() => setCreateOpen(true)} className="mt-4">
              <Plus className="w-4 h-4" />
              New vendor
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      {!loading && !error && visible.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Vendor</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Granted tenants</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Logins</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((v) => {
                  const active = activeGrants(v);
                  return (
                    <tr key={v.id} className="hover:bg-gray-50 transition-colors" data-testid={`vendor-row-${v.id}`}>
                      <td className="px-4 py-3">
                        <Link href={`/admin/vendors/${v.id}`} className="font-semibold text-gray-900 hover:text-[var(--brand-primary)]">
                          {v.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {active.length === 0 ? (
                          <span className="text-gray-400">No active grants</span>
                        ) : (
                          <span>
                            {active.slice(0, 3).map((g) => g.clientName).join(', ')}
                            {active.length > 3 ? ` +${active.length - 3} more` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                        {(v.userCount ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${VENDOR_STATUS_BADGE[v.status]}`}>
                          {VENDOR_STATUS_LABEL[v.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          <Link
                            href={`/admin/vendors/${v.id}`}
                            data-testid={`manage-${v.id}`}
                            aria-label={`Manage ${v.name}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-[var(--brand-primary)]"
                          >
                            Manage
                            <ChevronRight className="w-3.5 h-3.5" />
                          </Link>
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

      {/* Create vendor modal */}
      {createOpen && (
        <CreateVendorModal
          onClose={() => setCreateOpen(false)}
          onCreated={(msg) => {
            setCreateOpen(false);
            showToast(msg);
            void load();
          }}
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

// ── Create vendor modal ─────────────────────────────────────────────────────────

const FIELD_CLS =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

function CreateVendorModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  const [form, setForm] = useState<VendorFormState>(EMPTY_VENDOR_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (touched) setErrors(validateVendorForm(form));
  }, [form, touched]);

  async function handleSave() {
    const errs = validateVendorForm(form);
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    const res = await api.post<unknown>('/api/admin/vendors', vendorFormToPayload(form));
    setSaving(false);
    inFlight.current = false;
    if (res.success) onCreated(`Vendor "${form.name.trim()}" created.`);
    else setSaveError(res.error);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="New vendor"
      description="Create a platform vendor. Grant it to tenants and add logins from its detail page."
      className="max-w-md"
    >
      <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="vendor-name">
        Vendor name<span className="text-[var(--brand-primary)]"> *</span>
      </label>
      <input
        id="vendor-name"
        type="text"
        value={form.name}
        data-testid="vendor-name-input"
        onChange={(e) => setForm({ name: e.target.value })}
        className={FIELD_CLS}
        placeholder="e.g. Acme Fulfilment Pvt Ltd"
      />
      <p className="text-[11px] text-gray-400 mt-1">
        No GST / PAN / bank / KYC is collected — onboarding is credentials + grant only.
      </p>

      {errors.length > 0 && (
        <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1 mt-3" data-testid="vendor-errors">
          {errors.map((e, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-600">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{e}
            </p>
          ))}
        </div>
      )}
      {saveError && (
        <p className="flex items-start gap-1.5 text-xs text-red-600 mt-3" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{saveError}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">
          Cancel
        </button>
        <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="create-vendor-btn">
          Create vendor
        </Button>
      </div>
    </Modal>
  );
}
