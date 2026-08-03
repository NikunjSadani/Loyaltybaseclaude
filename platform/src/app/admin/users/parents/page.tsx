'use client';

/**
 * Admin — Parent Owner-Groups management (Partner → Multiple Outlets).
 *
 * Manages the PARENT owner-group entities that child outlets attach to via the
 * `parentId` (a.k.a. "Parent ID") column of the outlet-master upload. A parent is
 * an owner group: one owner (with optional identity + payout details) that a set of
 * child outlets belong to. This page lets an admin:
 *   - list + search existing parents,
 *   - create a new parent (only `partnerCode` is required),
 *   - approve a pending parent (GIFSY-only — mirrors the layout's `canManageSchemes` gate),
 *   - expand a parent to see its child outlets + un-group individual children,
 *   - deactivate a childless parent.
 *
 * Backend (all live) — every response is the `data` inside the `{ success, data }`
 * envelope, unwrapped by `apiJson()`:
 *   GET  /api/admin/parents                         → { parents }
 *   GET  /api/admin/parents/:id                     → { parent, children }
 *   POST /api/admin/parents                         → { parent, pendingGifsyApproval }
 *   POST /api/admin/parents/:id/approve   (GIFSY)   → { parent, approved }
 *   POST /api/admin/parents/:id/deactivate          → { id, deactivated }   (400 if it has children)
 *   POST /api/admin/outlets/:outletCode/ungroup     → { outletCode, ungrouped } (400 if a detail is shared)
 *
 * Auth = the httpOnly token cookie (same-origin fetch); authHeader() is a no-op kept
 * for call-site parity with the other admin pages. Backend 400 messages are surfaced
 * VERBATIM (duplicate code, uniqueness collisions, still-has-children, shared-detail).
 */

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import {
  Users2, Plus, Search, X, ChevronDown, ChevronRight, AlertTriangle,
  XCircle, CheckCircle2, BadgeCheck, Building2, Info, Unlink, Loader2,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { useAdminSession } from '@/lib/admin-session';

/* ─── Backend shapes ─────────────────────────────────────────────────────────── */

interface ParentRow {
  id:                  string;
  partnerCode:         string;
  businessName?:       string | null;
  ownerName?:          string | null;
  phone?:              string | null;
  gstNumber?:          string | null;
  panNumber?:          string | null;
  bankAccountNumber?:  string | null;
  upiId?:              string | null;
  isActive:            boolean;
  onboardedAt?:        string | null;
  childOutletCount:    number;
  pendingApproval:     boolean;
}

interface ChildOutlet {
  outletCode:         string;
  name?:              string | null;
  kycStatus?:         string | null;
  isActive:           boolean;
  canUngroup:         boolean;
  ungroupBlockReason: string | null;
}

interface ParentDetail {
  parent:   ParentRow;
  children: ChildOutlet[];
}

/* ─── Generic fetch helper (unwraps {success,data}) ──────────────────────────── */

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const hasJsonBody = init?.body != null && typeof init.body === 'string';
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(),
      ...(init?.headers as Record<string, string> | undefined ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({ success: false, error: 'Unexpected response' }))) as {
    success?: boolean; data?: T; error?: string;
  };
  if (!res.ok || json.success === false) {
    throw new Error(json.error ?? `Request failed (HTTP ${res.status}) [${method} ${url}]`);
  }
  return json.data as T;
}

/* ─── Status badge ───────────────────────────────────────────────────────────── */

function StatusBadge({ parent }: { parent: ParentRow }) {
  if (parent.pendingApproval) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium border border-amber-200">
        Pending Gifsy approval
      </span>
    );
  }
  if (parent.isActive) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-xs font-medium border border-green-200">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium border border-gray-200">
      Inactive
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Create-Parent modal
   ════════════════════════════════════════════════════════════════════════════ */

interface CreateForm {
  partnerCode:        string;
  businessName:       string;
  ownerName:          string;
  phone:              string;
  email:              string;
  gstNumber:          string;
  panNumber:          string;
  bankName:           string;
  bankAccountNumber:  string;
  bankAccountHolder:  string;
  ifscCode:           string;
  upiId:              string;
}

const BLANK_FORM: CreateForm = {
  partnerCode: '', businessName: '', ownerName: '', phone: '', email: '',
  gstNumber: '', panNumber: '', bankName: '', bankAccountNumber: '',
  bankAccountHolder: '', ifscCode: '', upiId: '',
};

function CreateParentModal({
  onClose, onCreated, isGifsy,
}: {
  onClose:   () => void;
  onCreated: (result: { pendingGifsyApproval: boolean }) => void;
  /** GIFSY creators skip the approval step; a CLIENT_ADMIN's group starts Pending. */
  isGifsy:   boolean;
}) {
  const [form, setForm] = useState<CreateForm>(BLANK_FORM);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const canSubmit = form.partnerCode.trim().length > 0 && !saving;

  const submit = async () => {
    if (!form.partnerCode.trim()) { setError('Parent code is required'); return; }
    setSaving(true); setError('');
    // Send only non-empty optional fields; partnerCode is always sent.
    const body: Record<string, string> = { partnerCode: form.partnerCode.trim() };
    (Object.keys(form) as (keyof CreateForm)[]).forEach((k) => {
      if (k === 'partnerCode') return;
      const v = form[k].trim();
      if (v) body[k] = v;
    });
    try {
      const result = await apiJson<{ parent: ParentRow; pendingGifsyApproval: boolean }>(
        '/api/admin/parents',
        { method: 'POST', body: JSON.stringify(body) },
      );
      onCreated({ pendingGifsyApproval: !!result.pendingGifsyApproval });
    } catch (e) {
      // Surface the backend 400 verbatim (duplicate code, uniqueness collisions).
      setError(e instanceof Error ? e.message : 'Could not create parent');
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

  const optionalField = (label: string, key: keyof CreateForm, placeholder = '') => (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-600">{label}</label>
      <input
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Create Owner Group (Parent)</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-xs text-blue-700">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
            <span>
              After creating the group, set its <strong>Parent ID</strong> ({'='} the code below) in the
              <strong> Parent ID column</strong> of the outlet-master upload to attach child outlets to it.
            </span>
          </div>

          {!isGifsy && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                New owner groups need <strong>Gifsy approval</strong> before they go active. Once created, this
                group shows as <strong>Pending Gifsy approval</strong> until a Gifsy admin approves it.
              </span>
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600">Parent code *</label>
            <input
              value={form.partnerCode}
              onChange={(e) => set('partnerCode', e.target.value)}
              placeholder="e.g. OWNER-GRP-001"
              className={inputCls}
              autoFocus
            />
            <p className="text-[11px] text-gray-400">The unique code child outlets reference as their Parent ID.</p>
          </div>

          {/* Collapsible optional identity + payout section */}
          <div className="rounded-xl border border-gray-100">
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 rounded-xl"
            >
              <span className="text-sm font-medium text-gray-700">Identity &amp; payout details (optional)</span>
              <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
            </button>
            {detailsOpen && (
              <div className="border-t border-gray-100 p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {optionalField('Business name', 'businessName')}
                  {optionalField('Owner name', 'ownerName')}
                  {optionalField('Phone', 'phone')}
                  {optionalField('Email', 'email')}
                  {optionalField('GST number', 'gstNumber')}
                  {optionalField('PAN number', 'panNumber')}
                </div>
                <div className="pt-1">
                  <p className="text-xs font-semibold text-gray-500 mb-2">Payout details</p>
                  <div className="grid grid-cols-2 gap-3">
                    {optionalField('Bank name', 'bankName')}
                    {optionalField('Account number', 'bankAccountNumber')}
                    {optionalField('Account holder', 'bankAccountHolder')}
                    {optionalField('IFSC code', 'ifscCode')}
                    {optionalField('UPI ID', 'upiId')}
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Creating…' : 'Create Parent'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Deactivate confirm modal
   ════════════════════════════════════════════════════════════════════════════ */

function DeactivateModal({
  parent, busy, error, onConfirm, onClose,
}: {
  parent:    ParentRow;
  busy:      boolean;
  error:     string;
  onConfirm: () => void;
  onClose:   () => void;
}) {
  const hasChildren = parent.childOutletCount > 0;
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus the Cancel button on open (a11y: keyboard lands inside the dialog). L4.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Escape-to-close, guarded so it never cancels a deactivation already in flight. Mirrors the
  // RST-L4 idiom in SchemeAudienceEditor; kept separate from focus so a `busy` flip can't re-steal
  // focus. L4.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Deactivate owner group?</h2>
          <button onClick={() => { if (!busy) onClose(); }} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            This deactivates <strong className="text-gray-900">{parent.businessName || parent.partnerCode}</strong>.
          </p>
          {hasChildren && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                This group still has <strong>{parent.childOutletCount}</strong> child outlet(s). Un-group them first —
                the deactivation will be rejected otherwise.
              </span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              ref={cancelRef}
              onClick={() => { if (!busy) onClose(); }}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? 'Deactivating…' : 'Deactivate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Un-group confirm modal (mirrors DeactivateModal — un-grouping reverts a child
   to a standalone partner with its own identity/uniqueness, so it deserves the
   same friction as Deactivate).
   ════════════════════════════════════════════════════════════════════════════ */

function UngroupModal({
  child, busy, error, onConfirm, onClose,
}: {
  child:     ChildOutlet;
  busy:      boolean;
  error:     string;
  onConfirm: () => void;
  onClose:   () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus the Cancel button on open (a11y: keyboard lands inside the dialog). L4.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Escape-to-close, guarded so it never cancels an un-group already in flight. Mirrors the
  // RST-L4 idiom in SchemeAudienceEditor; kept separate from focus so a `busy` flip can't re-steal
  // focus. L4.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Un-group this outlet?</h2>
          <button onClick={() => { if (!busy) onClose(); }} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            This removes <strong className="text-gray-900">{child.name || child.outletCode}</strong> from the group.
          </p>
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>This reverts the outlet to a standalone partner (its own identity/uniqueness).</span>
          </div>
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              ref={cancelRef}
              onClick={() => { if (!busy) onClose(); }}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? 'Un-grouping…' : 'Un-group'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Expanded child-outlets panel (fetched on expand)
   ════════════════════════════════════════════════════════════════════════════ */

function ChildOutletsPanel({
  parentId, reloadKey, onUngrouped,
}: {
  parentId:    string;
  /** Bumped by the parent to force a refetch after an un-group. */
  reloadKey:   number;
  onUngrouped: () => void;
}) {
  const [detail, setDetail] = useState<ParentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ungrouping, setUngrouping] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  // Confirm gate — un-grouping reverts a child to a standalone partner, so it is
  // confirmed (mirrors the Deactivate flow) rather than firing on a single click.
  const [ungroupTarget, setUngroupTarget] = useState<ChildOutlet | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiJson<ParentDetail>(`/api/admin/parents/${parentId}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load child outlets');
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const ungroup = async (child: ChildOutlet) => {
    setUngrouping(child.outletCode); setRowError('');
    try {
      await apiJson(`/api/admin/outlets/${encodeURIComponent(child.outletCode)}/ungroup`, { method: 'POST' });
      setUngroupTarget(null);   // close the confirm on success
      await load();       // refresh this group's children
      onUngrouped();      // refresh the parent list (childOutletCount)
    } catch (e) {
      // Surface the 400 verbatim (child still shares a detail) — keep the modal open.
      setRowError(e instanceof Error ? e.message : 'Could not un-group outlet');
    } finally {
      setUngrouping(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading child outlets…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-4">
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={load} className="ml-auto text-xs font-medium underline hover:no-underline">Retry</button>
        </div>
      </div>
    );
  }
  const children = detail?.children ?? [];

  return (
    <div className="px-4 py-4 space-y-3">
      {children.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">
          No child outlets in this group yet. Attach outlets by setting this group&apos;s code as their Parent ID in the outlet-master upload.
        </p>
      ) : (
        <div className="border border-gray-100 rounded-xl overflow-x-auto bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-2.5 font-medium">Outlet Code</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">KYC Status</th>
                <th className="px-4 py-2.5 font-medium">Active</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {children.map((c) => (
                <tr key={c.outletCode} className="hover:bg-gray-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-600">{c.outletCode}</td>
                  <td className="px-4 py-2.5 text-gray-900">{c.name ?? '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{c.kycStatus ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    {c.isActive ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[10px] font-medium border border-green-200">Active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] font-medium border border-gray-200">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <button
                        onClick={() => { setRowError(''); setUngroupTarget(c); }}
                        disabled={!c.canUngroup || ungrouping === c.outletCode}
                        title={c.canUngroup ? 'Remove this outlet from the group' : (c.ungroupBlockReason ?? 'Cannot un-group this outlet')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {ungrouping === c.outletCode
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Unlink className="w-3.5 h-3.5" />}
                        Un-group
                      </button>
                      {!c.canUngroup && (
                        <span className="text-[10px] text-gray-400 max-w-[220px] text-right">
                          {c.ungroupBlockReason ?? 'Cannot un-group this outlet'}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ungroupTarget && (
        <UngroupModal
          child={ungroupTarget}
          busy={ungrouping === ungroupTarget.outletCode}
          error={rowError}
          onConfirm={() => ungroup(ungroupTarget)}
          onClose={() => {
            if (ungrouping) return;   // don't dismiss mid-request
            setUngroupTarget(null);
            setRowError('');
          }}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Page
   ════════════════════════════════════════════════════════════════════════════ */

export default function AdminParentsPage() {
  const session = useAdminSession();
  // GIFSY is detected exactly as the admin layout gates its `gifsyOnly` items:
  // `canManageSchemes` is derived true only for GIFSY_ADMIN (admin-session.ts).
  const isGifsy = session.canManageSchemes;

  const [parents, setParents] = useState<ParentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Bumped per-parent to force the expanded child panel to refetch after an un-group.
  const [childReloadKey, setChildReloadKey] = useState(0);

  const [approvingId, setApprovingId] = useState<string | null>(null);
  // Persistent inline approve-error banner (per parent row). A long backend message
  // must not vanish with the ~3.5s toast, so it stays until dismissed / next action. M5.
  const [approveError, setApproveError] = useState<{ id: string; msg: string } | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<ParentRow | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    // Clear any stale per-row approve error (L3): a refresh (successful approve on another
    // row, or a search clear) must not leave a dead banner pinned to an unrelated row.
    setLoading(true); setError(''); setApproveError(null);
    try {
      const data = await apiJson<{ parents: ParentRow[] }>('/api/admin/parents');
      setParents(data.parents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load owner groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parents;
    return parents.filter((p) =>
      p.partnerCode.toLowerCase().includes(q) ||
      (p.businessName ?? '').toLowerCase().includes(q) ||
      (p.ownerName ?? '').toLowerCase().includes(q),
    );
  }, [parents, search]);

  const approve = async (parent: ParentRow) => {
    setApprovingId(parent.id); setApproveError(null);
    try {
      await apiJson(`/api/admin/parents/${parent.id}/approve`, { method: 'POST' });
      showToast(`Approved ${parent.businessName || parent.partnerCode}.`);
      await load();
    } catch (e) {
      // Persist the (possibly long) backend message in an inline banner — the toast
      // alone auto-dismisses before an admin can read it. M5.
      setApproveError({ id: parent.id, msg: e instanceof Error ? e.message : 'Could not approve owner group.' });
    } finally {
      setApprovingId(null);
    }
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true); setDeactivateError('');
    try {
      await apiJson(`/api/admin/parents/${deactivateTarget.id}/deactivate`, { method: 'POST' });
      showToast(`Deactivated ${deactivateTarget.businessName || deactivateTarget.partnerCode}.`);
      setDeactivateTarget(null);
      await load();
    } catch (e) {
      // Surface the 400 verbatim ("Cannot deactivate — … still has N child outlet(s). …").
      setDeactivateError(e instanceof Error ? e.message : 'Could not deactivate owner group.');
    } finally {
      setDeactivating(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  };

  return (
    <div className="space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Owner Groups (Parents)</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage parent owner-groups for the Partner → Multiple Outlets feature. Child outlets attach to a
            group via its code in the Parent ID column of the outlet-master upload.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity shrink-0"
        >
          <Plus className="w-4 h-4" />
          Create Parent
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
        <input
          type="text"
          placeholder="Search by code, business, or owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-[var(--brand-primary)]"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={load} className="ml-auto text-xs font-medium underline hover:no-underline">Retry</button>
        </div>
      )}

      {/* Table / states */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gray-100">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
                <div className="h-4 bg-gray-100 rounded w-40" />
                <div className="h-4 bg-gray-100 rounded w-28" />
                <div className="h-4 bg-gray-100 rounded w-24" />
                <div className="h-4 bg-gray-100 rounded w-16" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center px-6">
            <Users2 className="w-7 h-7 text-gray-300" />
            {parents.length === 0 ? (
              <>
                <p className="text-sm font-medium text-gray-600">No owner groups yet</p>
                <p className="text-sm text-gray-400 max-w-md">
                  Create one, then set its code in the <strong>Parent ID</strong> column of the outlet-master
                  upload to attach child outlets to it.
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500">No owner groups match “{search}”.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium w-8" />
                  <th className="px-4 py-3 font-medium">Parent Code</th>
                  <th className="px-4 py-3 font-medium">Business Name</th>
                  <th className="px-4 py-3 font-medium">Owner Name</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium text-center"># Child Outlets</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((p) => {
                  const expanded = expandedId === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => toggleExpand(p.id)}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                            aria-label={expanded ? 'Collapse child outlets' : 'Expand child outlets'}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-700">{p.partnerCode}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-gray-900">
                            <Building2 className="w-3.5 h-3.5 text-gray-300" />
                            {p.businessName || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{p.ownerName || '—'}</td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">{p.phone || '—'}</td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => toggleExpand(p.id)}
                            className="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-full bg-gray-50 text-gray-700 text-xs font-semibold border border-gray-200 hover:bg-gray-100"
                          >
                            {p.childOutletCount}
                          </button>
                        </td>
                        <td className="px-4 py-3"><StatusBadge parent={p} /></td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* Approve — GIFSY-only, only for a pending parent. */}
                            {p.pendingApproval && isGifsy && (
                              <button
                                onClick={() => approve(p)}
                                disabled={approvingId === p.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {approvingId === p.id
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <BadgeCheck className="w-3.5 h-3.5" />}
                                Approve
                              </button>
                            )}
                            {/* Deactivate — enabled only for a childless active group;
                                the backend re-checks and 400s otherwise. */}
                            {p.isActive && !p.pendingApproval && (
                              <button
                                onClick={() => { setApproveError(null); setDeactivateError(''); setDeactivateTarget(p); }}
                                disabled={p.childOutletCount > 0}
                                title={p.childOutletCount > 0
                                  ? 'Un-group all child outlets before deactivating'
                                  : 'Deactivate this owner group'}
                                className="text-xs font-medium text-gray-500 hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-500"
                              >
                                Deactivate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {approveError && approveError.id === p.id && (
                        <tr>
                          <td colSpan={8} className="px-4 pb-3 pt-0 bg-white">
                            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
                              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                              <span className="flex-1">{approveError.msg}</span>
                              <button
                                onClick={() => setApproveError(null)}
                                className="shrink-0 text-xs font-medium underline hover:no-underline"
                              >
                                Dismiss
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {expanded && (
                        <tr>
                          <td colSpan={8} className="bg-gray-50/70 p-0">
                            <ChildOutletsPanel
                              parentId={p.id}
                              reloadKey={childReloadKey}
                              onUngrouped={() => { setChildReloadKey((k) => k + 1); load(); }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <CreateParentModal
          isGifsy={isGifsy}
          onClose={() => setShowCreate(false)}
          onCreated={({ pendingGifsyApproval }) => {
            setShowCreate(false);
            showToast(pendingGifsyApproval
              ? 'Owner group created — it now needs Gifsy approval before it goes active.'
              : 'Owner group created.');
            load();
          }}
        />
      )}

      {deactivateTarget && (
        <DeactivateModal
          parent={deactivateTarget}
          busy={deactivating}
          error={deactivateError}
          onConfirm={confirmDeactivate}
          onClose={() => { if (!deactivating) { setDeactivateTarget(null); setDeactivateError(''); } }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          {toast}
        </div>
      )}
    </div>
  );
}
