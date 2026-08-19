'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Loader2, ShieldCheck, Lock, Pencil, Trash2, AlertTriangle, CheckCircle2, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

// ── Types (mirror the RBAC Option-X backend envelopes) ──────────────────────────

interface PermissionItem {
  key: string;
  reserved: boolean;
}
interface PermissionGroup {
  key: string;
  label: string;
  capabilityContext: string;
  permissions: PermissionItem[];
}
interface PermissionCatalog {
  groups: PermissionGroup[];
  reserved: string[];
}
interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
  usersCount: number;
}

// Which editor is open: null = closed, { role: null } = create, { role } = edit.
type EditorState = { role: Role | null } | null;

// ── Page ────────────────────────────────────────────────────────────────────────

export default function GifsyRolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [rolesRes, catRes] = await Promise.all([
      api.get<Role[]>('/api/gifsy/roles'),
      api.get<PermissionCatalog>('/api/gifsy/permissions'),
    ]);
    if (rolesRes.success && catRes.success) {
      setRoles(rolesRes.data);
      setCatalog(catRes.data);
    } else {
      setError(
        (!rolesRes.success && rolesRes.error) ||
        (!catRes.success && catRes.error) ||
        'Could not load roles',
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Gifsy Roles</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Define staff roles and the permissions each one grants.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setEditor({ role: null })}
          disabled={!catalog}
        >
          <Plus className="w-4 h-4" />
          New role
        </Button>
      </div>

      {/* Table */}
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Description</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Permissions</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Assigned staff</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">System</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {!loading && !error && roles.map((r) => (
              <tr key={r.id} className="hover:bg-white/5 transition-colors group">
                <td className="px-4 py-3">
                  <p className="font-semibold text-white">{r.name}</p>
                </td>
                <td className="px-4 py-3 text-white/50 text-xs max-w-xs truncate">
                  {r.description || '—'}
                </td>
                <td className="px-4 py-3 text-center text-white/60 text-xs">
                  {r.permissions.length} {r.permissions.length === 1 ? 'permission' : 'permissions'}
                </td>
                <td className="px-4 py-3 text-center text-white/60 text-xs">
                  {r.usersCount}
                </td>
                <td className="px-4 py-3 text-center">
                  {r.isSystem && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 text-xs font-medium">
                      <ShieldCheck className="w-3 h-3" />System
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-3 justify-end">
                    <button
                      onClick={() => setEditor({ role: r })}
                      className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/80 transition-colors"
                      aria-label={`Edit ${r.name}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />Edit
                    </button>
                    <button
                      onClick={() => setDeleteTarget(r)}
                      disabled={r.isSystem}
                      title={r.isSystem ? "System roles can't be deleted" : undefined}
                      className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-white/40"
                      aria-label={`Delete ${r.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {loading && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-white/40 text-sm">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />Loading roles…
              </td></tr>
            )}
            {!loading && error && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-sm">
                <p className="text-red-400">{error}</p>
                <button
                  onClick={() => { void load(); }}
                  className="mt-3 px-4 py-1.5 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
                >
                  Retry
                </button>
              </td></tr>
            )}
            {!loading && !error && roles.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-white/30 text-sm">
                No roles yet — create one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Editor modal (create + edit) */}
      {editor && catalog && (
        <RoleEditorModal
          role={editor.role}
          catalog={catalog}
          onClose={() => setEditor(null)}
          onSaved={(msg) => { setEditor(null); showToast(msg); void load(); }}
        />
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <DeleteRoleModal
          role={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); showToast('Role deleted.'); void load(); }}
        />
      )}

      {/* Toast */}
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

// ── Editor modal ────────────────────────────────────────────────────────────────
// Mounted only while open, so its state initialises fresh on every open (create vs
// edit vs a different role) without needing a reset effect.

function RoleEditorModal({
  role,
  catalog,
  onClose,
  onSaved,
}: {
  role: Role | null;
  catalog: PermissionCatalog;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!role;
  const reservedSet = useMemo(() => new Set(catalog.reserved), [catalog.reserved]);

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  // Start with the ack ON when editing a role that already carries reserved grants, so
  // those checkboxes are visible + editable instead of stuck disabled.
  const [allowReserved, setAllowReserved] = useState<boolean>(
    () => (role?.permissions ?? []).some((k) => reservedSet.has(k)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyReservedSelected = useMemo(
    () => [...selected].some((k) => reservedSet.has(k)),
    [selected, reservedSet],
  );

  function togglePermission(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAllowReserved(on: boolean) {
    setAllowReserved(on);
    // Turning the ack OFF removes any already-selected reserved keys, keeping the
    // selection consistent with the disabled checkboxes.
    if (!on) {
      setSelected((prev) => new Set([...prev].filter((k) => !reservedSet.has(k))));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim(),
      permissions: [...selected],
    };
    // Lock-1: only send the override flag when a reserved key is actually selected.
    if (anyReservedSelected) body.allowReserved = true;

    const res = isEdit
      ? await api.patch<Role>(`/api/gifsy/roles/${role!.id}`, body)
      : await api.post<Role>('/api/gifsy/roles', body);

    setSubmitting(false);
    if (res.success) {
      onSaved(isEdit ? 'Role updated.' : 'Role created.');
    } else {
      setError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title={isEdit ? 'Edit role' : 'New role'}
      description="Grant only the permissions this role needs."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Role name"
            placeholder="e.g. Operations Manager"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Description <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Role description"
            rows={2}
            placeholder="What this role is for"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        {/* Reserved-permission acknowledgement (Lock-1 warn-to-grant) */}
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 mt-0.5 rounded accent-[var(--brand-primary)]"
              checked={allowReserved}
              onChange={(e) => toggleAllowReserved(e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700">
              Allow granting reserved (sensitive) permissions — money, tenancy, and role administration
            </span>
          </label>
          {allowReserved && (
            <div className="flex items-start gap-2 mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Reserved permissions let staff perform sensitive actions. Grant only what you intend.</span>
            </div>
          )}
        </div>

        {/* Permission matrix */}
        <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
          {catalog.groups.map((group) => (
            <Card key={group.key} className="border-gray-200 shadow-none">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-sm">{group.label}</CardTitle>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{group.capabilityContext}</p>
              </CardHeader>
              <CardContent className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {group.permissions.map((p) => {
                  const isReservedKey = reservedSet.has(p.key);
                  const disabled = isReservedKey && !allowReserved;
                  return (
                    <label
                      key={p.key}
                      className={`flex items-center gap-2 ${
                        isReservedKey ? 'text-amber-600' : 'text-gray-700'
                      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                      title={isReservedKey ? 'Reserved — sensitive; requires explicit override' : undefined}
                    >
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-[var(--brand-primary)]"
                        checked={selected.has(p.key)}
                        disabled={disabled}
                        onChange={() => togglePermission(p.key)}
                      />
                      <span className="font-mono text-xs">{p.key}</span>
                      {isReservedKey && <Lock className="w-3 h-3 shrink-0 text-amber-500" />}
                    </label>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!name.trim()}>
            {isEdit ? 'Save changes' : 'Create role'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Delete confirm modal ──────────────────────────────────────────────────────────

function DeleteRoleModal({
  role,
  onClose,
  onDeleted,
}: {
  role: Role;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    const res = await api.del<{ id: string; deleted: boolean }>(`/api/gifsy/roles/${role.id}`);
    setSubmitting(false);
    if (res.success) onDeleted();
    else setError(res.error);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title={`Delete role "${role.name}"?`}
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Any staff assigned to this role must be reassigned before it can be deleted.
          This can&apos;t be undone.
        </p>

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" variant="destructive" loading={submitting} onClick={handleDelete}>
            Delete role
          </Button>
        </div>
      </div>
    </Modal>
  );
}
