'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  UserPlus, Search, Building2, ShieldCheck, AlertTriangle, X, CheckCircle2, SquarePen,
} from 'lucide-react';
import { useAdminSession, type AdminRole } from '@/lib/admin-session';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { getAssumedBrand } from '@/lib/auth-client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminUser {
  id:        string;
  name:      string;
  email?:    string | null;
  phone:     string;
  role:      string;
  status:    string;
  createdAt?: string;
}

interface Pagination {
  page:        number;
  limit:       number;
  total:       number;
  pages:       number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

const PAGE_SIZE = 20;

// ── Role display + assignable matrix (UX gate only — backend is the real gate) ──

const ROLE_META: Record<string, { label: string; color: string }> = {
  GIFSY_ADMIN:  { label: 'Gifsy Admin',   color: 'bg-purple-50 text-purple-700 border-purple-200' },
  CLIENT_ADMIN: { label: 'Client Admin',  color: 'bg-blue-50 text-blue-700 border-blue-200'       },
  MIS_USER:     { label: 'MIS User',      color: 'bg-amber-50 text-amber-700 border-amber-200'    },
};

/**
 * Which roles the create form offers, by the CURRENT caller's role AND context. This
 * mirrors the backend `assertRoleAssignable` allow-list (admin-core.service.ts): only a
 * GIFSY_ADMIN in the PLATFORM (gifsy) context may mint a GIFSY_ADMIN. A GIFSY_ADMIN who
 * has assumed a tenant creates users stamped with that tenant's clientId, so minting a
 * GIFSY_ADMIN there would produce a mis-scoped operator — the backend blocks it, and we
 * hide the option to match. This is UX gating ONLY — the backend re-checks and 403s a
 * disallowed role regardless of what the form sends. Sales/partner roles are intentionally
 * excluded here; they have their own flows (/admin/sales + KYC).
 *
 * `clientId` is the caller's effective context: 'gifsy' at the platform level, or the
 * tenant slug when a GIFSY operator has assumed a brand.
 */
function assignableRoles(callerRole: AdminRole | string, clientId: string): string[] {
  if (callerRole === 'GIFSY_ADMIN') {
    return clientId === 'gifsy'
      ? ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'] // platform context
      : ['CLIENT_ADMIN', 'MIS_USER'];               // assumed into a tenant — no GIFSY_ADMIN
  }
  if (callerRole === 'CLIENT_ADMIN') return ['MIS_USER'];
  return []; // MIS_USER and any other admin role cannot create users
}

function roleBadge(role: string) {
  const meta = ROLE_META[role] ?? { label: role, color: 'bg-gray-50 text-gray-600 border-gray-200' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

// ── Create-User modal ───────────────────────────────────────────────────────────

function CreateUserModal({
  roles,
  tenantLabel,
  onClose,
  onCreated,
}: {
  roles:       string[];
  tenantLabel: string;
  onClose:     () => void;
  onCreated:   () => void;
}) {
  const [name,  setName]  = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [role,  setRole]  = useState(roles[0] ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneValid = /^\d{10}$/.test(phone);
  const canSubmit  = name.trim().length > 0 && phoneValid && !!role && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:  name.trim(),
          phone: phone.trim(),
          role,
          ...(email.trim() ? { email: email.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({ success: false, error: 'Unexpected response' }));
      if (res.ok && body.success) {
        onCreated();
        onClose();
      } else {
        // Surface the backend's real message (e.g. phone-exists 400, disallowed-role 403)
        // verbatim — never swallow it.
        setError(body?.error ?? `Could not create user (HTTP ${res.status})`);
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Create User</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Tenant context reminder inside the modal too */}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-xs text-blue-700">
            <Building2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
            <span>This user will be created in <strong>{tenantLabel}</strong>.</span>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma"
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
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
            {phone.length > 0 && !phoneValid && (
              <p className="text-xs text-red-600 mt-1">Enter a valid 10-digit phone number.</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
            >
              {roles.map((r) => (
                <option key={r} value={r}>{ROLE_META[r]?.label ?? r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@company.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit-User modal ───────────────────────────────────────────────────────────────

function EditUserModal({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user:    AdminUser;
  roles:   string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name,  setName]  = useState(user.name);
  const [phone, setPhone] = useState(user.phone);
  const [email, setEmail] = useState(user.email ?? '');
  const [role,  setRole]  = useState(user.role);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Role options = the caller-assignable set PLUS the user's CURRENT role (so a role the
  // caller can't assign still shows and can be KEPT). De-duped, current appended if absent.
  // Every non-current option is caller-assignable, so a plain select already enforces
  // "only assignable roles are pickable to switch to" while keeping the current always
  // selectable. Backend re-checks via assertRoleAssignable and 403s a disallowed change.
  const roleOptions = useMemo(
    () => (roles.includes(user.role) ? roles : [...roles, user.role]),
    [roles, user.role],
  );

  const phoneValid   = /^\d{10}$/.test(phone);
  const canSubmit    = name.trim().length > 0 && phoneValid && !!role && !submitting;
  const phoneChanged = phone.trim() !== user.phone;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:  name.trim(),
          phone: phone.trim(),
          // Send `role` ONLY when it actually changed. The backend runs its role-assignable
          // guard on PRESENCE (dto.role !== undefined), not on change — so always sending the
          // role would 403 a CLIENT_ADMIN who merely edited a fellow admin's name/email (their
          // current role, e.g. CLIENT_ADMIN, isn't in the tenant-assignable set).
          ...(role !== user.role ? { role } : {}),
          // Trimmed value, or null to clear. Never send `status` — the row toggle owns it.
          email: email.trim() ? email.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({ success: false, error: 'Unexpected response' }));
      if (res.ok && body.success) {
        onSaved();
        onClose();
      } else {
        // Surface the backend's real message (e.g. phone-clash 409, disallowed-role 403)
        // verbatim — never swallow it.
        setError(body?.error ?? `Could not save changes (HTTP ${res.status})`);
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Edit User</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma"
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
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
            {phone.length > 0 && !phoneValid && (
              <p className="text-xs text-red-600 mt-1">Enter a valid 10-digit phone number.</p>
            )}
            {phoneValid && phoneChanged && (
              <p className="text-xs text-amber-600 mt-1">
                Changing the phone signs this user out on their next refresh.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>{ROLE_META[r]?.label ?? r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@company.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const session      = useAdminSession();
  const clientConfig = useClientConfig();

  const [users,   setUsers]   = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [search,  setSearch]  = useState('');
  const [page,    setPage]    = useState(1);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [toast,   setToast]   = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  // "Revoke sessions" — the user whose sessions are being revoked (confirm modal),
  // plus an in-flight flag so the confirm button can't double-fire.
  const [revokeTarget, setRevokeTarget] = useState<AdminUser | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Tenant context shown near the Create button. A GIFSY operator who has assumed a
  // brand sees that brand's name (the same source the operator banner uses); otherwise
  // the resolved tenant's display name. So a CLIENT_ADMIN created here lands in the
  // CURRENTLY-ACTIVE tenant — exactly what the operator sees.
  const [assumedBrand, setAssumedBrand] = useState<string | null>(null);
  useEffect(() => { setAssumedBrand(getAssumedBrand()); }, []);
  const tenantLabel = assumedBrand ?? clientConfig.branding.displayName;

  // The caller's EFFECTIVE clientId for role-gating. session.clientId is 'gifsy' for any
  // GIFSY_ADMIN regardless of assumed brand, so it can't distinguish platform vs assumed-
  // tenant context on its own. A GIFSY operator who has assumed a brand (assumedBrand set)
  // is in a TENANT context — mirror the backend JWT clientId (the tenant slug) so the
  // GIFSY_ADMIN option is hidden there. Non-GIFSY admins are always tenant-scoped.
  const effectiveClientId =
    session.role === 'GIFSY_ADMIN'
      ? (assumedBrand ? 'tenant' : 'gifsy')
      : session.clientId;

  const roles = useMemo(
    () => assignableRoles(session.role, effectiveClientId),
    [session.role, effectiveClientId],
  );
  const canCreate = roles.length > 0;

  const loadUsers = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    fetch(`/api/admin/users?${params.toString()}`)
      .then((r) => r.json())
      .then((json: { success: boolean; data?: { users: AdminUser[]; pagination?: Pagination }; error?: string }) => {
        if (json.success && json.data) {
          setUsers(json.data.users);
          setPagination(json.data.pagination ?? null);
        } else {
          setError(json.error ?? 'Failed to load users');
        }
      })
      .catch(() => setError('Failed to load users'))
      .finally(() => setLoading(false));
  }, [search, page]);

  // Initial + search-debounced load. Re-runs when the search term or page changes.
  useEffect(() => {
    const t = setTimeout(loadUsers, 250);
    return () => clearTimeout(t);
  }, [loadUsers]);

  // A new search starts from page 1 (the previous page index is meaningless for a
  // different result set). loadUsers re-fires via its `page` dep.
  useEffect(() => {
    setPage(1);
  }, [search]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // Revoke every session for the target user. The backend kills the REFRESH path, so
  // the user is signed out within the session window / on their next refresh — not
  // instantly (a live access token stays valid until its TTL). Copy reflects that.
  async function confirmRevokeSessions() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/admin/users/${revokeTarget.id}/revoke-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        showToast('Sessions revoked — the user is signed out within the session window.');
      } else {
        showToast(body?.error ?? 'Could not revoke sessions.');
      }
    } catch {
      showToast('Network error revoking sessions.');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  }

  async function toggleStatus(u: AdminUser) {
    const next = u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setUpdatingId(u.id);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: next }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: next } : x)));
      } else {
        showToast(body?.error ?? 'Could not update user status.');
      }
    } catch {
      showToast('Network error updating user status.');
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">User Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Create and manage admin-tier accounts (Gifsy Admin, Client Admin, MIS User).
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            Create User
          </button>
        )}
      </div>

      {/* Tenant context */}
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-600 shadow-sm">
        <Building2 className="w-4 h-4 text-[var(--brand-primary)] shrink-0" />
        <span>
          Creating users in: <strong className="text-gray-900">{tenantLabel}</strong>
        </span>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
        <input
          type="text"
          placeholder="Search by name, phone, or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-[var(--brand-primary)]"
        />
      </div>

      {/* Table / states */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="divide-y divide-gray-100">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
                <div className="h-4 bg-gray-100 rounded w-40" />
                <div className="h-4 bg-gray-100 rounded w-28" />
                <div className="h-4 bg-gray-100 rounded w-24" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
            <p className="text-sm text-gray-600">{error}</p>
            <button
              onClick={loadUsers}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <ShieldCheck className="w-6 h-6 text-gray-300" />
            <p className="text-sm text-gray-500">No users yet.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Name</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Phone</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Role</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Status</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-gray-500" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3">
                    <p className="font-medium text-gray-900">{u.name}</p>
                    {u.email && <p className="text-xs text-gray-400">{u.email}</p>}
                  </td>
                  <td className="px-5 py-3 text-gray-600 font-mono text-xs">{u.phone}</td>
                  <td className="px-5 py-3">{roleBadge(u.role)}</td>
                  <td className="px-5 py-3">
                    {u.status === 'ACTIVE' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-xs font-medium border border-green-200">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs font-medium border border-gray-200">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {/* Never offer self-deactivation in the UI (the backend also guards it).
                        For the signed-in user's own row, show a muted dash instead. */}
                    {session.userId && u.id === session.userId ? (
                      <span className="text-xs text-gray-300">—</span>
                    ) : canCreate ? (
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => setEditTarget(u)}
                          className="text-gray-500 hover:text-[var(--brand-primary)] transition-colors"
                          aria-label={`Edit ${u.name}`}
                          title="Edit user"
                        >
                          <SquarePen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setRevokeTarget(u)}
                          className="text-xs font-medium text-gray-500 hover:text-[var(--brand-primary)] transition-colors"
                        >
                          Revoke sessions
                        </button>
                        <button
                          onClick={() => toggleStatus(u)}
                          disabled={updatingId === u.id}
                          className="text-xs font-medium text-gray-500 hover:text-[var(--brand-primary)] transition-colors disabled:opacity-50"
                        >
                          {updatingId === u.id
                            ? '…'
                            : u.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination controls */}
      {!loading && !error && pagination && pagination.pages > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-sm text-gray-500">
          <span>
            Page <strong className="text-gray-900">{pagination.page}</strong> of{' '}
            <strong className="text-gray-900">{pagination.pages}</strong> ·{' '}
            <strong className="text-gray-900">{pagination.total}</strong> total
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!pagination.hasPrevPage}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!pagination.hasNextPage}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showCreate && canCreate && (
        <CreateUserModal
          roles={roles}
          tenantLabel={tenantLabel}
          onClose={() => setShowCreate(false)}
          onCreated={() => { showToast('User created.'); loadUsers(); }}
        />
      )}

      {editTarget && canCreate && (
        <EditUserModal
          user={editTarget}
          roles={roles}
          onClose={() => setEditTarget(null)}
          onSaved={() => { showToast('User updated.'); loadUsers(); }}
        />
      )}

      {/* Revoke-sessions confirm modal */}
      {revokeTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => { if (!revoking) setRevokeTarget(null); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Log this user out of all devices?</h2>
              <button
                onClick={() => { if (!revoking) setRevokeTarget(null); }}
                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-600">
                This revokes all active sessions for{' '}
                <strong className="text-gray-900">{revokeTarget.name}</strong>. They are signed out
                within the session window (on their next refresh) — not instantly, as a currently
                valid access token stays usable until it expires.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setRevokeTarget(null)}
                  disabled={revoking}
                  className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRevokeSessions}
                  disabled={revoking}
                  className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {revoking ? 'Revoking…' : 'Revoke sessions'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Success toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          {toast}
        </div>
      )}
    </div>
  );
}
