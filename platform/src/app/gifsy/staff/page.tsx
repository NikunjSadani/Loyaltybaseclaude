'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';

// ── Types ─────────────────────────────────────────────────────────────────────
// RBAC Option-X P3 — the Gifsy Staff Panel. Backend GET /api/gifsy/staff → /v1/gifsy/staff.
// A staff member is a platform user (GIFSY_STAFF tier) assigned a custom GifsyRole.
// RBAC Option-X P5 — a staff is also scoped to specific client brands ("assumable
// clients") they may assume, one at a time. The grants are brand SLUGS.

interface GifsyRole {
  id:   string;
  name: string;
}

interface StaffMember {
  id:          string;
  name:        string;
  phone:       string;
  email?:      string | null;
  status:      string;
  gifsyRoleId?: string | null;
  gifsyRole:   { id: string; name: string } | null;
  // P5: brand slugs this staff may assume. Omitted by older payloads → treat as [].
  assumableClientIds?: string[];
}

// A brand option for the "Assumable brands" grant control (from GET /api/gifsy/clients).
interface ClientBrand {
  slug:         string;
  internalName: string;
  displayName?: string;
  status:       'ACTIVE' | 'ONBOARDING' | 'INACTIVE';
}

const brandLabel = (c: ClientBrand) => c.displayName || c.internalName;

// Sort weight so ACTIVE brands read first, then ONBOARDING, then INACTIVE.
const rank = (status: ClientBrand['status']) =>
  status === 'ACTIVE' ? 0 : status === 'ONBOARDING' ? 1 : 2;

// ── Assumable-brands grant control (multi-select checkbox list) ──────────────────
// Light-styled to match the shared (white) Modal. Value + onChange are brand slugs.

function BrandGrantSelect({
  brands,
  value,
  onChange,
}: {
  brands:   ClientBrand[];
  value:    string[];
  onChange: (slugs: string[]) => void;
}) {
  const selected = new Set(value);
  const toggle = (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    onChange([...next]);
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        Assumable brands <span className="text-gray-400 font-normal">(optional)</span>
      </label>
      {brands.length === 0 ? (
        <p className="text-xs text-gray-400 border border-gray-200 rounded-lg px-3 py-2">
          No brands available to assign.
        </p>
      ) : (
        <div
          role="group"
          aria-label="Assumable brands"
          className="max-h-40 overflow-auto border border-gray-200 rounded-lg divide-y divide-gray-100"
        >
          {brands.map((b) => (
            <label
              key={b.slug}
              className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(b.slug)}
                onChange={() => toggle(b.slug)}
                aria-label={brandLabel(b)}
                className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
              />
              <span className="flex-1 min-w-0 truncate">{brandLabel(b)}</span>
              {b.status === 'ONBOARDING' && (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-px">
                  Onboarding
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-1">
        The staff member can assume (work in) only the brands you select.
      </p>
    </div>
  );
}

// ── Status badge (dark shell idiom) ─────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === 'ACTIVE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-xs font-medium border border-green-500/30">
        Active
      </span>
    );
  }
  if (status === 'SUSPENDED') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium border border-amber-500/30">
        Suspended
      </span>
    );
  }
  // INACTIVE (and any other terminal state)
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 text-white/50 text-xs font-medium border border-white/20">
      {status === 'INACTIVE' ? 'Inactive' : status}
    </span>
  );
}

// ── Add-staff modal ─────────────────────────────────────────────────────────────
// White dialog (shared Modal) — style form content light.

function AddStaffModal({
  roles,
  brands,
  onClose,
  onAdded,
}: {
  roles:   GifsyRole[];
  brands:  ClientBrand[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name,  setName]  = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gifsyRoleId, setGifsyRoleId] = useState('');
  const [assumableClientIds, setAssumableClientIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneValid = /^\d{10}$/.test(phone);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    // Client-side validation — block the request outright with a helpful message.
    if (!name.trim()) { setError('Enter the staff member’s name.'); return; }
    if (!phoneValid)  { setError('Enter a valid 10-digit phone number.'); return; }
    if (!gifsyRoleId) { setError('Select a role.'); return; }

    setSubmitting(true);
    setError(null);
    const res = await api.post<StaffMember>('/api/gifsy/staff', {
      name:  name.trim(),
      phone: phone.trim(),
      gifsyRoleId,
      assumableClientIds,
      ...(email.trim() ? { email: email.trim() } : {}),
    });
    setSubmitting(false);
    if (res.success) {
      onAdded();
      onClose();
    } else {
      // Surface the backend's real message (role-not-found / phone-in-use 400,
      // email-in-use 409) verbatim — never swallow it, never close on error.
      setError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title="Add staff member"
      description="Create a platform staff account and assign a role."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Priya Sharma"
            aria-label="Full name"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Phone (10 digits)</label>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="9830011252"
            aria-label="Phone"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
          {phone.length > 0 && !phoneValid && (
            <p role="alert" className="text-xs text-red-600 mt-1">Enter a valid 10-digit phone number.</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
          <select
            value={gifsyRoleId}
            onChange={(e) => setGifsyRoleId(e.target.value)}
            aria-label="Role"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value="" disabled>Select a role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Email <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@gifsy.in"
            aria-label="Email"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <BrandGrantSelect brands={brands} value={assumableClientIds} onChange={setAssumableClientIds} />

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>Add staff</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit-staff modal ─────────────────────────────────────────────────────────────

function EditStaffModal({
  staff,
  roles,
  brands,
  onClose,
  onSaved,
}: {
  staff:   StaffMember;
  roles:   GifsyRole[];
  brands:  ClientBrand[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const originalBrands = useMemo(() => staff.assumableClientIds ?? [], [staff.assumableClientIds]);

  const [name,  setName]  = useState(staff.name);
  const [phone, setPhone] = useState(staff.phone);
  const [email, setEmail] = useState(staff.email ?? '');
  const [gifsyRoleId, setGifsyRoleId] = useState(staff.gifsyRoleId ?? staff.gifsyRole?.id ?? '');
  const [assumableClientIds, setAssumableClientIds] = useState<string[]>(originalBrands);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noChange, setNoChange] = useState(false);

  const phoneValid   = /^\d{10}$/.test(phone);
  const originalRole = staff.gifsyRoleId ?? staff.gifsyRole?.id ?? '';
  const roleChanged  = gifsyRoleId !== originalRole;
  // Order-insensitive set comparison — a re-selection to the same set is not a change.
  const brandsChanged =
    assumableClientIds.length !== originalBrands.length ||
    [...assumableClientIds].sort().join(',') !== [...originalBrands].sort().join(',');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setNoChange(false);
    if (!name.trim()) { setError('Enter the staff member’s name.'); return; }
    if (!phoneValid)  { setError('Enter a valid 10-digit phone number.'); return; }
    if (!gifsyRoleId) { setError('Select a role.'); return; }

    // Send only the fields that actually changed — the backend runs its guards on
    // presence, so sending an unchanged reassign would revoke sessions needlessly.
    // (assumableClientIds is omitted unless changed → "omit = unchanged" per the contract.)
    const patch: Record<string, string | string[] | null> = {};
    if (name.trim() !== staff.name) patch.name = name.trim();
    if (phone.trim() !== staff.phone) patch.phone = phone.trim();
    const trimmedEmail = email.trim();
    if (trimmedEmail !== (staff.email ?? '')) patch.email = trimmedEmail || null;
    if (roleChanged) patch.gifsyRoleId = gifsyRoleId;
    if (brandsChanged) patch.assumableClientIds = assumableClientIds;

    // Nothing to save — give the user feedback instead of closing silently.
    if (Object.keys(patch).length === 0) { setNoChange(true); return; }

    setSubmitting(true);
    setError(null);
    const res = await api.patch<StaffMember>(`/api/gifsy/staff/${staff.id}`, patch);
    setSubmitting(false);
    if (res.success) {
      onSaved();
      onClose();
    } else {
      setError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title="Edit staff member"
      description="Update this staff member’s details or reassign their role."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Full name"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Phone (10 digits)</label>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            aria-label="Phone"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
          {phone.length > 0 && !phoneValid && (
            <p role="alert" className="text-xs text-red-600 mt-1">Enter a valid 10-digit phone number.</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
          <select
            value={gifsyRoleId}
            onChange={(e) => setGifsyRoleId(e.target.value)}
            aria-label="Role"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value="" disabled>Select a role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          {roleChanged && (
            <p className="text-xs text-amber-600 mt-1">
              Reassigning the role signs this staff member out of active sessions.
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Email <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <BrandGrantSelect brands={brands} value={assumableClientIds} onChange={setAssumableClientIds} />

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>Save changes</Button>
        </div>
        {noChange && (
          <p role="alert" className="text-xs text-gray-500 text-right">No changes to save.</p>
        )}
      </form>
    </Modal>
  );
}

// ── Deactivate confirm modal ─────────────────────────────────────────────────────

function DeactivateModal({
  staff,
  onClose,
  onDeactivated,
}: {
  staff:         StaffMember;
  onClose:       () => void;
  onDeactivated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await api.patch<StaffMember>(`/api/gifsy/staff/${staff.id}`, { status: 'INACTIVE' });
    setSubmitting(false);
    if (res.success) {
      onDeactivated();
      onClose();
    } else {
      setError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title="Deactivate staff member?"
      description="This signs the staff member out immediately."
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Deactivate <strong className="text-gray-900">{staff.name}</strong>? They will be signed out
          immediately and lose access to the platform.
        </p>

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={confirm} loading={submitting}>Deactivate</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function GifsyStaffPage() {
  const [staff,   setStaff]   = useState<StaffMember[]>([]);
  const [roles,   setRoles]   = useState<GifsyRole[]>([]);
  const [brands,  setBrands]  = useState<ClientBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const [showAdd,          setShowAdd]          = useState(false);
  const [editTarget,       setEditTarget]       = useState<StaffMember | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<StaffMember | null>(null);
  const [reactivatingId,   setReactivatingId]   = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Clients feed the "Assumable brands" grant control + the slug→name mapping in the
    // list. GET /api/gifsy/clients returns { clients: [...] } (owner has tenancy:read).
    const [staffRes, rolesRes, clientsRes] = await Promise.all([
      api.get<StaffMember[]>('/api/gifsy/staff'),
      api.get<GifsyRole[]>('/api/gifsy/roles'),
      api.get<{ clients: ClientBrand[] }>('/api/gifsy/clients'),
    ]);
    if (!staffRes.success) {
      setError(staffRes.error || 'Failed to load staff');
      setLoading(false);
      return;
    }
    setStaff(staffRes.data ?? []);
    setRoles(rolesRes.success ? (rolesRes.data ?? []) : []);
    // ACTIVE/ONBOARDING first (assignable), then the rest; INACTIVE stays selectable so
    // an existing grant to a now-inactive brand still renders, but sinks to the bottom.
    const clientList = clientsRes.success ? (clientsRes.data?.clients ?? []) : [];
    setBrands(
      [...clientList].sort((a, b) => rank(a.status) - rank(b.status)),
    );
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Map a brand slug → its display name for the list. Falls back to the slug if a grant
  // points at a brand we can't see (e.g. filtered/removed) so the row never renders blank.
  const brandName = useMemo(() => {
    const m = new Map(brands.map((b) => [b.slug, brandLabel(b)]));
    return (slug: string) => m.get(slug) ?? slug;
  }, [brands]);

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // Reactivate is a direct PATCH (no confirm). It may 400 if the phone was reclaimed
  // while the staff member was inactive — surface that message verbatim.
  async function reactivate(s: StaffMember) {
    setReactivatingId(s.id);
    const res = await api.patch<StaffMember>(`/api/gifsy/staff/${s.id}`, { status: 'ACTIVE' });
    setReactivatingId(null);
    if (res.success) {
      showToast('Staff reactivated.');
      load();
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Gifsy Staff</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Platform staff accounts and their assigned roles
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setShowAdd(true)}
          className="rounded-lg"
        >
          <Plus className="w-4 h-4" />
          Add staff
        </Button>
      </div>

      {/* Table */}
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Phone</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Role</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Brands</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {!loading && !error && staff.map((s) => (
              <tr key={s.id} className="hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 font-medium text-white">{s.name}</td>
                <td className="px-4 py-3 text-white/60 font-mono text-xs">{s.phone}</td>
                <td className="px-4 py-3 text-white/50 text-xs">{s.email || '—'}</td>
                <td className="px-4 py-3 text-white/70 text-xs">{s.gifsyRole?.name ?? '— none —'}</td>
                <td className="px-4 py-3 text-white/60 text-xs">
                  {(s.assumableClientIds ?? []).length === 0 ? (
                    <span className="text-white/30">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1 max-w-[16rem]">
                      {(s.assumableClientIds ?? []).map((slug) => (
                        <span
                          key={slug}
                          className="inline-flex items-center rounded-full bg-white/10 border border-white/15 px-2 py-0.5 text-[11px] text-white/70"
                        >
                          {brandName(slug)}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-center"><StatusBadge status={s.status} /></td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-3 justify-end">
                    <button
                      onClick={() => setEditTarget(s)}
                      className="text-xs font-medium text-white/50 hover:text-white transition-colors"
                    >
                      Edit
                    </button>
                    {s.status === 'ACTIVE' ? (
                      <button
                        onClick={() => setDeactivateTarget(s)}
                        className="text-xs font-medium text-white/50 hover:text-red-400 transition-colors"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        onClick={() => reactivate(s)}
                        disabled={reactivatingId === s.id}
                        className="text-xs font-medium text-white/50 hover:text-green-400 transition-colors disabled:opacity-50"
                      >
                        {reactivatingId === s.id ? '…' : 'Reactivate'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={7} className="px-4 py-12 text-center">
                <div className="flex items-center justify-center">
                  <Spinner size="lg" />
                </div>
              </td></tr>
            )}
            {error && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-red-400 text-sm">
                <div className="flex flex-col items-center gap-3">
                  <span>{error}</span>
                  <button
                    onClick={load}
                    className="px-3 py-1.5 text-xs font-medium border border-white/20 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </td></tr>
            )}
            {!loading && !error && staff.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-white/30 text-sm">
                No staff yet — add one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddStaffModal
          roles={roles}
          brands={brands}
          onClose={() => setShowAdd(false)}
          onAdded={() => { showToast('Staff member added.'); load(); }}
        />
      )}

      {editTarget && (
        <EditStaffModal
          staff={editTarget}
          roles={roles}
          brands={brands}
          onClose={() => setEditTarget(null)}
          onSaved={() => { showToast('Staff updated.'); load(); }}
        />
      )}

      {deactivateTarget && (
        <DeactivateModal
          staff={deactivateTarget}
          onClose={() => setDeactivateTarget(null)}
          onDeactivated={() => { showToast('Staff deactivated.'); load(); }}
        />
      )}

      {/* Success / error toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}
