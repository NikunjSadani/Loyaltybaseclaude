'use client';

import { useState, useEffect } from 'react';
import { Users, Search, ShieldCheck, UserCog, Building2, Activity } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';

interface GifsyUser {
  id: string;
  name: string;
  email?: string | null;
  phone?: string;
  role: string;
  status: string;
  createdAt?: string;
}

const ROLE_META: Record<string, { label: string; color: string }> = {
  GIFSY_ADMIN:   { label: 'Gifsy Admin',   color: 'text-purple-400 bg-purple-500/20 border-purple-500/30' },
  CLIENT_ADMIN:  { label: 'Client Admin',  color: 'text-blue-400 bg-blue-500/20 border-blue-500/30'       },
  MIS_USER:      { label: 'MIS User',      color: 'text-amber-400 bg-amber-500/20 border-amber-500/30'    },
};

export default function GifsyUsersPage() {
  const [users, setUsers] = useState<GifsyUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/admin/users')
      .then(r => r.json())
      .then((json: { success: boolean; data?: { users: GifsyUser[] }; error?: string }) => {
        if (json.success && json.data) {
          setUsers(json.data.users);
        } else {
          setError(json.error ?? 'Failed to load users');
        }
      })
      .catch(() => setError('Failed to load users'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter((u) =>
    !search ||
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    (u.email ?? '').toLowerCase().includes(search.toLowerCase()) ||
    u.role.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Platform Users</h1>
          <p className="text-sm text-white/50 mt-0.5">GIFSY admins and client admins with platform-level access</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity opacity-50 cursor-not-allowed" disabled>
          + Invite User
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Gifsy Admins',  value: users.filter(u => u.role === 'GIFSY_ADMIN').length,  icon: ShieldCheck, color: 'text-purple-400' },
          { label: 'Client Admins', value: users.filter(u => u.role === 'CLIENT_ADMIN').length, icon: UserCog,     color: 'text-blue-400'   },
          { label: 'MIS Users',     value: users.filter(u => u.role === 'MIS_USER').length,     icon: Activity,    color: 'text-amber-400'  },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-3">
            <Icon className={`w-5 h-5 shrink-0 ${color}`} />
            <div>
              <p className="text-xl font-bold text-white">{value}</p>
              <p className="text-xs text-white/40">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
        <input
          type="text"
          placeholder="Search users…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
        />
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 text-center py-8">{error}</div>
      )}

      {/* Table */}
      {!loading && !error && (
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">User</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Role</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Client</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Last Login</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map((u) => {
              const roleMeta = ROLE_META[u.role] ?? { label: u.role, color: 'text-white/50 bg-white/10 border-white/20' };
              return (
                <tr key={u.id} className="hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{u.name}</p>
                    <p className="text-xs text-white/40">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${roleMeta.color}`}>
                      {roleMeta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-white/60 text-xs">
                      <Building2 className="w-3.5 h-3.5 shrink-0" />
                      —
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white/40 text-xs">
                    {u.createdAt ? u.createdAt.slice(0, 10) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-xs font-medium border border-green-500/30">
                      Active
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <p className="text-xs text-white/30 text-center">
        Platform user management (invite, role change, deactivate) coming in Phase 2 — DB integration required.
      </p>
    </div>
  );
}
