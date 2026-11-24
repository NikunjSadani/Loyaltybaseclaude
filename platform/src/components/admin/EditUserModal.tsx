'use client';

import { useState, useMemo } from 'react';
import { X, AlertTriangle } from 'lucide-react';

// ── Shared admin-user types + edit modal ────────────────────────────────────────
//
// Extracted verbatim from admin/users/page.tsx so BOTH the User Accounts page and the
// Employee Hierarchy tab open the SAME edit form (one editor, one endpoint, one set of
// session-revocation warnings). Behaviour is unchanged — this is a move, not a rewrite.

export interface AdminUser {
  id:        string;
  name:      string;
  email?:    string | null;
  phone:     string;
  role:      string;
  status:    string;
  createdAt?: string;
  // Present when this user is a sales EMPLOYEE (has a linked SalesUser). Drives the
  // employee-aware edit form (Level + Reports-to instead of the raw Role dropdown).
  // employeeCode lets a caller match a fetched row to a hierarchy row exactly.
  salesUser?: {
    id: string;
    employeeCode?: string;
    hierarchyLevelId: string | null;
    reportingToId: string | null;
  } | null;
}

/** Dropdown sources for the employee edit form (GET /api/admin/sales-users/options). */
export interface EmployeeOptions {
  levels:   { id: string; code: string; name: string; level: number }[];
  managers: { id: string; name: string; employeeCode: string; hierarchyLevelId: string | null }[];
}

// Role display metadata (label + badge colours). Shared so the modal's role select and the
// User Accounts table's role badge stay in sync.
export const ROLE_META: Record<string, { label: string; color: string }> = {
  GIFSY_ADMIN:  { label: 'Gifsy Admin',   color: 'bg-purple-50 text-purple-700 border-purple-200' },
  CLIENT_ADMIN: { label: 'Client Admin',  color: 'bg-blue-50 text-blue-700 border-blue-200'       },
  MIS_USER:     { label: 'MIS User',      color: 'bg-amber-50 text-amber-700 border-amber-200'    },
};

/** The synthetic login phone a vacant hierarchy position carries (api hierarchy-persistence.ts). */
export const VACANT_PHONE_PREFIX = '__vacant__:';
export function isVacantPlaceholderPhone(phone: string | null | undefined): boolean {
  return typeof phone === 'string' && phone.startsWith(VACANT_PHONE_PREFIX);
}

/** Shown (and returned by the API) when only one of name / phone is cleared. */
export const VACATE_NEEDS_BOTH_MSG =
  'To mark this position vacant, clear both the name and the phone. Otherwise enter a 10-digit phone.';

export function EditUserModal({
  user,
  roles,
  employeeOptions,
  onClose,
  onSaved,
}: {
  user:            AdminUser;
  roles:           string[];
  employeeOptions: EmployeeOptions | null;
  onClose:         () => void;
  /** Called after a successful save; `warning` is set when the save committed with a problem to report. */
  onSaved:         (warning?: string) => void;
}) {
  // An employee is a user with a linked SalesUser. For employees we edit the HIERARCHY
  // (level + reports-to) instead of the raw login role — the backend updates User.role
  // from the level so the two can't drift. reports-to/level flow through the dedicated
  // employee endpoint (PATCH /admin/sales-users/:id); non-employees use /admin/users/:id.
  const isEmployee = !!user.salesUser;
  // A VACANT position (employee left / never filled) carries the synthetic placeholder login
  // ('__vacant__:<code>' phone, '(vacant) <code>' name). Show it as blank name + phone — typing
  // a new name + phone fills it with a new person.
  const isVacant = isEmployee && isVacantPlaceholderPhone(user.phone) && user.status !== 'ACTIVE';
  const initialName  = isVacant ? '' : user.name;
  const initialPhone = isVacant ? '' : user.phone;
  const [name,  setName]  = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  // Two-step save when the admin clears BOTH name and phone (marks the position vacant).
  const [confirmVacate, setConfirmVacate] = useState(false);
  const [email, setEmail] = useState(user.email ?? '');
  const [role,  setRole]  = useState(user.role);
  const [levelId, setLevelId] = useState(user.salesUser?.hierarchyLevelId ?? '');
  const [reportsTo, setReportsTo] = useState(user.salesUser?.reportingToId ?? '');
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
  const phoneChanged = phone.trim() !== initialPhone;
  const nameBlank    = name.trim() === '';
  const phoneBlank   = phone.trim() === '';
  // EMPLOYEE vacancy rules (mirrors the API): both blank = vacant; exactly one blank = invalid.
  const bothBlank    = isEmployee && nameBlank && phoneBlank;
  const oneBlank     = isEmployee && nameBlank !== phoneBlank;
  // Clearing both on a FILLED position marks it vacant (needs the confirmation step).
  const vacating     = bothBlank && !isVacant;
  // Require a valid phone only when it actually changed — so an employee's level / reports-to
  // can be edited even for a row whose stored phone is a non-standard placeholder (vacant slot).
  const canSubmit    = isEmployee
    ? (bothBlank || (!nameBlank && !phoneBlank && (phoneValid || !phoneChanged))) && !submitting
    : !nameBlank && (phoneValid || !phoneChanged) && !!role && !submitting;
  const positionLabel = (() => {
    const code = user.salesUser?.employeeCode;
    const level = employeeOptions?.levels?.find((l) => l.id === user.salesUser?.hierarchyLevelId)?.name;
    if (code && level) return `${level} ${code}`;
    return code ?? level ?? 'this position';
  })();

  // Reports-to options: the active managers, PLUS the current manager if it has since been
  // deactivated (otherwise the select would falsely read "None" for an employee who has one).
  const managerOptions = useMemo(() => {
    const list = employeeOptions?.managers ?? [];
    const cur = user.salesUser?.reportingToId ?? '';
    if (cur && !list.some((m) => m.id === cur)) {
      return [{ id: cur, name: 'Current manager (inactive)', employeeCode: '—', hierarchyLevelId: null }, ...list];
    }
    return list;
  }, [employeeOptions, user.salesUser?.reportingToId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    // Marking a position vacant signs the person out and frees their phone — confirm first.
    if (vacating && !confirmVacate) {
      setConfirmVacate(true);
      return;
    }
    await save();
  }

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      // EMPLOYEE: route through the dedicated endpoint that updates the login (User) and
      // hierarchy (SalesUser) rows atomically. Send level/reports-to only when changed.
      const res = isEmployee
        ? await fetch(`/api/admin/sales-users/${user.salesUser!.id}`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // Diff-send: only the fields that changed. This avoids resending a placeholder
            // phone (vacant slots) through the 10-digit validator and avoids needless
            // session revokes when only the level / reports-to is edited.
            // Vacate = send BOTH name and phone as '' (the API's vacate signal). Filling a vacant
            // position sends both (they both differ from the blank initial values).
            body:    JSON.stringify({
              ...(vacating
                ? { name: '', phone: '' }
                : {
                    ...(name.trim() !== initialName ? { name: name.trim() } : {}),
                    ...(phoneChanged ? { phone: phone.trim() } : {}),
                  }),
              ...((email.trim() || null) !== (user.email ?? null) ? { email: email.trim() ? email.trim() : null } : {}),
              ...(levelId && levelId !== (user.salesUser?.hierarchyLevelId ?? '') ? { hierarchyLevelId: levelId } : {}),
              ...(reportsTo !== (user.salesUser?.reportingToId ?? '')
                ? { reportingToId: reportsTo === '' ? null : reportsTo }
                : {}),
            }),
          })
        : await fetch(`/api/admin/users/${user.id}`, {
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
        // A committed vacate whose sign-out failed comes back with a message — surface it, never swallow.
        const warning: string | undefined = body?.data?.sessionRevokeFailures?.length ? body.data.message : undefined;
        if (warning) {
          setConfirmVacate(false);
          setError(warning);
          onSaved(warning);
          return;
        }
        onSaved();
        onClose();
      } else {
        setConfirmVacate(false);
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
          {isVacant && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              This position is vacant. Enter the new person&apos;s name and phone to fill it.
            </p>
          )}
          <div>
            <label htmlFor="edit-user-name" className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
            <input
              id="edit-user-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setConfirmVacate(false); }}
              placeholder="e.g. Priya Sharma"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
          </div>

          <div>
            <label htmlFor="edit-user-phone" className="block text-xs font-medium text-gray-600 mb-1">Phone (10 digits)</label>
            <input
              id="edit-user-phone"
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); setConfirmVacate(false); }}
              placeholder="9830011252"
              aria-describedby={isEmployee && !isVacant ? 'edit-user-phone-hint' : undefined}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
            />
            {phone.length > 0 && !phoneValid && (
              <p className="text-xs text-red-600 mt-1">Enter a valid 10-digit phone number.</p>
            )}
            {phoneValid && phoneChanged && !isVacant && (
              <p className="text-xs text-amber-600 mt-1">
                Changing the phone signs this user out on their next refresh.
              </p>
            )}
            {oneBlank && (
              <p role="alert" className="text-xs text-red-600 mt-1">{VACATE_NEEDS_BOTH_MSG}</p>
            )}
            {isEmployee && !isVacant && (
              <p id="edit-user-phone-hint" className="text-[11px] text-gray-400 mt-1">
                Leave name and phone blank to mark the position vacant (e.g. the employee left)
              </p>
            )}
          </div>

          {isEmployee ? (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Level</label>
                <select
                  value={levelId}
                  onChange={(e) => setLevelId(e.target.value)}
                  aria-label="Level"
                  disabled={!employeeOptions}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)] disabled:bg-gray-50"
                >
                  {!levelId && <option value="">Select a level…</option>}
                  {(employeeOptions?.levels ?? []).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-400 mt-1">Changing the level updates the employee&apos;s role and signs them out on next refresh.</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reports to</label>
                <select
                  value={reportsTo}
                  onChange={(e) => setReportsTo(e.target.value)}
                  aria-label="Reports to"
                  disabled={!employeeOptions}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)] disabled:bg-gray-50"
                >
                  <option value="">— None (top of hierarchy) —</option>
                  {managerOptions
                    .filter((m) => m.id !== user.salesUser?.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.name} ({m.employeeCode})</option>
                    ))}
                </select>
              </div>
            </>
          ) : (
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
          )}

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

          {confirmVacate && vacating && (
            <div
              role="alertdialog"
              aria-label="Confirm vacant position"
              data-testid="confirm-vacate"
              className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Mark {positionLabel} as vacant? {user.name} will be signed out and can no longer log in, and
                their phone number will be freed. The position keeps its place in the hierarchy.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={confirmVacate ? () => setConfirmVacate(false) : onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {confirmVacate ? 'Back' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving…' : confirmVacate ? 'Yes, mark vacant' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
