'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
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
  // Outlet/partner logins only (GET /admin/users list): the client's outlet code of the
  // PRIMARY outlet, plus how many further outlets this login owns (shown as " +N"). Null/0
  // for admin / MIS / sales rows. Optional — absent on older API responses and other sources.
  outletCode?: string | null;
  additionalOutletCount?: number;
}

/** Dropdown sources for the employee edit form (GET /api/admin/sales-users/options). */
export interface EmployeeOptions {
  levels:   { id: string; code: string; name: string; level: number }[];
  /** `vacant` = a vacant position (name is already "Vacant (code)"). */
  managers: { id: string; name: string; employeeCode: string; hierarchyLevelId: string | null; vacant?: boolean }[];
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

/**
 * Display label for a login that carries the synthetic placeholder phone (never shown raw):
 * still linked to a position → "Vacant position <code>"; a closed record of someone who left
 * (the position has since been filled by a new login) → "Former employee <code>". Null for a real login.
 */
export function vacantLoginLabel(u: Pick<AdminUser, 'phone' | 'salesUser'>): string | null {
  if (!isVacantPlaceholderPhone(u.phone)) return null;
  const code = u.salesUser?.employeeCode ?? u.phone.slice(VACANT_PHONE_PREFIX.length);
  return u.salesUser ? `Vacant position ${code}` : `Former employee ${code}`;
}

/** Shown (and returned by the API) when only one of name / phone is cleared. */
export const VACATE_NEEDS_BOTH_MSG =
  'To mark this position vacant, clear both the name and the phone. Otherwise enter a 10-digit phone.';
/** Shown (and returned by the API) when a vacant position is being filled without both fields. */
export const FILL_VACANT_NEEDS_BOTH_MSG =
  "To fill this vacant position, enter both the new person's name and a 10-digit phone.";
/** Shown (and returned by the API) when User Accounts tries to reactivate a vacant login. */
export const VACANT_LOGIN_REACTIVATE_MSG =
  'This login belongs to a vacant position and cannot be reactivated. To give the position to someone, use "Fill vacant position" on the Employee Hierarchy page.';

/** Delay before the "Yes, mark vacant" button accepts a click — a double-click on Save can't confirm. */
export const CONFIRM_ARM_MS = 600;

/** What the caller shows after a save: a specific success message, or a WARNING (never a green tick). */
export interface EditUserSaveResult {
  message?: string;
  warning?: string;
}

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
  /** Called after a save that COMMITTED (the list should refresh). */
  onSaved:         (result?: EditUserSaveResult) => void;
}) {
  // An employee is a user with a linked SalesUser. For employees we edit the HIERARCHY
  // (level + reports-to) instead of the raw login role — the backend updates User.role
  // from the level so the two can't drift. reports-to/level flow through the dedicated
  // employee endpoint (PATCH /admin/sales-users/:id); non-employees use /admin/users/:id.
  const isEmployee = !!user.salesUser;
  // A VACANT position carries the synthetic placeholder login. Show it with blank name, phone
  // AND email — typing a new name + phone fills it with a brand-new login for the new person.
  const isVacant = isEmployee && isVacantPlaceholderPhone(user.phone) && user.status !== 'ACTIVE';
  const initialName  = isVacant ? '' : user.name;
  const initialPhone = isVacant ? '' : user.phone;
  const initialEmail = isVacant ? '' : (user.email ?? '');
  const [name,  setName]  = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [email, setEmail] = useState(initialEmail);
  const [role,  setRole]  = useState(user.role);
  const [levelId, setLevelId] = useState(user.salesUser?.hierarchyLevelId ?? '');
  const [reportsTo, setReportsTo] = useState(user.salesUser?.reportingToId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Name/phone rule error — shown only after a Save attempt (never flashes while typing).
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Two-step save when the admin clears BOTH name and phone (marks the position vacant).
  const [confirmVacate, setConfirmVacate] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);
  // A committed vacate / fill whose sign-out failed: the message + the login to retry.
  const [signOutWarning, setSignOutWarning] = useState<{ message: string; userId: string; success: string } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);

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
  const filling      = isVacant && !nameBlank && !phoneBlank;
  // Save stays enabled for the one-blank case so the admin gets the contextual message on Save.
  const saveDisabled =
    submitting ||
    !!signOutWarning ||
    (!isEmployee && (nameBlank || !role)) ||
    (!phoneBlank && phoneChanged && !phoneValid);
  const levelName = employeeOptions?.levels?.find((l) => l.id === user.salesUser?.hierarchyLevelId)?.name;
  const positionLabel = (() => {
    const code = user.salesUser?.employeeCode;
    if (code && levelName) return `${levelName} ${code}`;
    return code ?? levelName ?? 'this position';
  })();

  // Reports-to options: active managers AND vacant positions (shown "Vacant (code)"), PLUS the
  // current manager if it has since been deactivated (otherwise the select would falsely read "None").
  const managerOptions = useMemo(() => {
    const list = employeeOptions?.managers ?? [];
    const cur = user.salesUser?.reportingToId ?? '';
    if (cur && !list.some((m) => m.id === cur)) {
      return [{ id: cur, name: 'Current manager (inactive)', employeeCode: '—', hierarchyLevelId: null }, ...list];
    }
    return list;
  }, [employeeOptions, user.salesUser?.reportingToId]);

  // Confirm step: announce + focus it, and arm the confirm button only after a short delay so a
  // double-click / double-Enter on Save can never confirm by accident.
  useEffect(() => {
    if (!confirmVacate) { setConfirmArmed(false); return; }
    confirmRef.current?.focus();
    const t = setTimeout(() => setConfirmArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [confirmVacate]);

  function cancelConfirm(returnFocus = true) {
    setConfirmVacate(false);
    if (returnFocus) setTimeout(() => saveBtnRef.current?.focus(), 0);
  }

  // Any field change cancels a pending confirmation and clears the rule error.
  function edited() {
    if (confirmVacate) cancelConfirm(false);
    setFieldError(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (confirmVacate) cancelConfirm();
    else if (!submitting && !retrying) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // While the confirmation is open, Enter never confirms — only its own button does.
    if (confirmVacate || saveDisabled) return;
    if (oneBlank) {
      setFieldError(isVacant ? FILL_VACANT_NEEDS_BOTH_MSG : VACATE_NEEDS_BOTH_MSG);
      return;
    }
    // Marking a position vacant signs the person out and frees their phone — confirm first.
    if (vacating) {
      setConfirmVacate(true);
      return;
    }
    await save();
  }

  async function save() {
    setSubmitting(true);
    setError(null);
    const successMessage = vacating
      ? `${positionLabel} marked vacant`
      : filling
        ? `${positionLabel} filled — ${name.trim()}`
        : undefined;
    try {
      // EMPLOYEE: route through the dedicated endpoint that updates the login (User) and
      // hierarchy (SalesUser) rows atomically. Send level/reports-to only when changed.
      const res = isEmployee
        ? await fetch(`/api/admin/sales-users/${user.salesUser!.id}`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // Diff-send: only the fields that changed. Vacate = name and phone both '' (the API's
            // vacate signal; the API also clears the email). Filling sends both new values.
            body:    JSON.stringify({
              ...(vacating
                ? { name: '', phone: '' }
                : {
                    ...(name.trim() !== initialName ? { name: name.trim() } : {}),
                    ...(phoneChanged ? { phone: phone.trim() } : {}),
                    ...((email.trim() || null) !== (initialEmail || null) ? { email: email.trim() ? email.trim() : null } : {}),
                  }),
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
      setConfirmVacate(false);
      if (res.ok && body.success) {
        // A committed vacate / fill whose sign-out failed: keep the dialog open with a working
        // "Retry sign-out", and tell the caller it's a WARNING (the list still refreshes).
        const d = body?.data;
        if (d?.sessionRevokeFailures?.length && d?.signOutUserId) {
          const message: string = d.message ?? 'Saved, but the previous login could not be signed out yet.';
          setSignOutWarning({ message, userId: d.signOutUserId, success: successMessage ?? 'Employee updated.' });
          onSaved({ warning: message });
          return;
        }
        onSaved(successMessage ? { message: successMessage } : undefined);
        onClose();
      } else {
        // Surface the backend's real message (e.g. phone-clash 409, "changed by someone else"
        // 409, disallowed-role 403) verbatim — never swallow it.
        setError(body?.error ?? `Could not save changes (HTTP ${res.status})`);
      }
    } catch {
      setConfirmVacate(false);
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function retrySignOut() {
    if (!signOutWarning || !user.salesUser) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/admin/sales-users/${user.salesUser.id}/revoke-sessions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: signOutWarning.userId }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        onSaved({ message: `${signOutWarning.success} — previous login signed out` });
        onClose();
        return;
      }
      setSignOutWarning((w) => w && { ...w, message: body?.error ?? 'Still could not sign out the previous login — try again in a moment.' });
    } catch {
      setSignOutWarning((w) => w && { ...w, message: 'Network error — the previous login is still not signed out. Try again.' });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-user-title"
      onKeyDown={onKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 id="edit-user-title" className="text-base font-semibold text-gray-900">
            {isVacant ? `Fill vacant position ${positionLabel}` : 'Edit User'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4" noValidate>
          {isVacant && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              This position is vacant. Enter the new person&apos;s name and phone to fill it — they get their own new login.
            </p>
          )}
          <div>
            <label htmlFor="edit-user-name" className="block text-xs font-medium text-gray-600 mb-1">Full name</label>
            <input
              id="edit-user-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); edited(); }}
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
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); edited(); }}
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
            {fieldError && (
              <p role="alert" className="text-xs text-red-600 mt-1">{fieldError}</p>
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
                  onChange={(e) => { setLevelId(e.target.value); edited(); }}
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
                  onChange={(e) => { setReportsTo(e.target.value); edited(); }}
                  aria-label="Reports to"
                  disabled={!employeeOptions}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)] disabled:bg-gray-50"
                >
                  <option value="">— None (top of hierarchy) —</option>
                  {managerOptions
                    .filter((m) => m.id !== user.salesUser?.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.vacant ? m.name : `${m.name} (${m.employeeCode})`}
                      </option>
                    ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
              <select
                value={role}
                onChange={(e) => { setRole(e.target.value); edited(); }}
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
            <label htmlFor="edit-user-email" className="block text-xs font-medium text-gray-600 mb-1">Email <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              id="edit-user-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); edited(); }}
              placeholder="user@company.com"
              disabled={vacating}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)] disabled:bg-gray-50 disabled:text-gray-400"
            />
            {vacating && (
              <p className="text-[11px] text-gray-400 mt-1">The email is cleared when the position is marked vacant.</p>
            )}
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {signOutWarning && (
            <div role="alert" data-testid="signout-warning" className="space-y-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{signOutWarning.message}</span>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs font-medium border border-amber-200 bg-white rounded-lg hover:bg-amber-50"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={retrySignOut}
                  disabled={retrying}
                  className="px-3 py-1.5 text-xs font-semibold bg-amber-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                >
                  {retrying ? 'Signing out…' : 'Retry sign-out'}
                </button>
              </div>
            </div>
          )}

          {confirmVacate && vacating ? (
            // Separate confirmation step: its own buttons, LEFT-aligned (Save sat on the right),
            // focused + announced on open; the confirm button is armed only after a short delay.
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="alertdialog"
              aria-labelledby="confirm-vacate-title"
              aria-describedby="confirm-vacate-text"
              data-testid="confirm-vacate"
              className="space-y-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-3 text-xs text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-300"
            >
              <p id="confirm-vacate-title" className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Mark {positionLabel} as vacant?
              </p>
              <p id="confirm-vacate-text">
                {user.name} will be signed out and can no longer log in, and their phone number will be
                freed. The position keeps its place in the hierarchy.
              </p>
              <div className="flex items-center justify-start gap-2">
                <button
                  type="button"
                  onClick={confirmArmed && !submitting ? () => { void save(); } : undefined}
                  disabled={!confirmArmed || submitting}
                  className="px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Saving…' : 'Yes, mark vacant'}
                </button>
                <button
                  ref={backBtnRef}
                  type="button"
                  onClick={() => cancelConfirm()}
                  disabled={submitting}
                  className="px-3 py-1.5 text-xs font-medium border border-amber-200 bg-white rounded-lg hover:bg-amber-50"
                >
                  Back
                </button>
              </div>
            </div>
          ) : !signOutWarning && (
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                ref={saveBtnRef}
                type="submit"
                disabled={saveDisabled}
                className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
