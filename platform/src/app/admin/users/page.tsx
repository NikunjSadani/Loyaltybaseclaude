'use client';

import { useState } from 'react';
import {
  Search,
  Plus,
  UserCheck,
  UserX,
  MoreVertical,
  X,
  ChevronDown,
} from 'lucide-react';

type TabType = 'sales' | 'partners' | 'admin';

interface UserRow {
  id: string;
  name: string;
  mobile: string;
  email?: string;
  role: string;
  region?: string;
  territory?: string;
  partnerClass?: string;
  isActive: boolean;
  createdAt: string;
  lastLogin?: string;
}

const SALES_USERS: UserRow[] = [
  { id: 'U001', name: 'Rohit Verma', mobile: '9820001234', email: 'rohit.v@parleagro.com', role: 'TERRITORY_SALES_OFFICER', region: 'West India', territory: 'Mumbai West', isActive: true, createdAt: '2024-01-15', lastLogin: '2025-04-30' },
  { id: 'U002', name: 'Sanjay Kumar', mobile: '9811002345', email: 'sanjay.k@parleagro.com', role: 'TERRITORY_SALES_OFFICER', region: 'North India', territory: 'Delhi NCR', isActive: true, createdAt: '2024-02-20', lastLogin: '2025-04-29' },
  { id: 'U003', name: 'Anita Patel', mobile: '9898003456', email: 'anita.p@parleagro.com', role: 'SALES_EXECUTIVE', region: 'West India', territory: 'Ahmedabad', isActive: true, createdAt: '2024-03-10', lastLogin: '2025-04-28' },
  { id: 'U004', name: 'Kiran Rao', mobile: '9945004567', email: 'kiran.r@parleagro.com', role: 'AREA_SALES_MANAGER', region: 'South India', territory: 'Bengaluru', isActive: true, createdAt: '2023-11-05', lastLogin: '2025-04-30' },
  { id: 'U005', name: 'Prasad N.', mobile: '9533005678', email: 'prasad.n@parleagro.com', role: 'TERRITORY_SALES_OFFICER', region: 'South India', territory: 'Hyderabad', isActive: false, createdAt: '2024-01-22', lastLogin: '2025-03-15' },
  { id: 'U006', name: 'Tanmoy Das', mobile: '9830006789', email: 'tanmoy.d@parleagro.com', role: 'SALES_MANAGER', region: 'East India', territory: 'Kolkata', isActive: true, createdAt: '2023-09-14', lastLogin: '2025-04-29' },
];

const PARTNER_USERS: UserRow[] = [
  { id: 'P001', name: 'Rakesh Sharma', mobile: '9820184321', role: 'RETAILER', partnerClass: 'GOLD', territory: 'Mumbai West', isActive: true, createdAt: '2024-04-01', lastLogin: '2025-04-28' },
  { id: 'P002', name: 'Ramesh Gupta', mobile: '9811034021', role: 'WHOLESALER', partnerClass: 'SILVER', territory: 'Delhi NCR', isActive: true, createdAt: '2024-03-15', lastLogin: '2025-04-25' },
  { id: 'P003', name: 'Vijay Patel', mobile: '9898123456', role: 'RETAILER', partnerClass: 'BRONZE', territory: 'Ahmedabad', isActive: true, createdAt: '2024-05-10', lastLogin: '2025-04-20' },
  { id: 'P004', name: 'Lalitha Devi', mobile: '9945223311', role: 'RETAILER', partnerClass: 'GOLD', territory: 'Bengaluru', isActive: false, createdAt: '2024-02-28', lastLogin: '2025-02-10' },
  { id: 'P005', name: 'K. Krishnamurthy', mobile: '9444181920', role: 'SUB_STOCKIST', partnerClass: 'PLATINUM', territory: 'Chennai', isActive: true, createdAt: '2023-12-01', lastLogin: '2025-04-30' },
];

const ADMIN_USERS: UserRow[] = [
  { id: 'A001', name: 'Rahul Agarwal', mobile: '9820999001', email: 'rahul.a@parleagro.com', role: 'CLIENT_ADMIN', isActive: true, createdAt: '2023-06-01', lastLogin: '2025-04-30' },
  { id: 'A002', name: 'Priya Menon', mobile: '9444999002', email: 'priya.m@parleagro.com', role: 'MIS_USER', isActive: true, createdAt: '2023-08-15', lastLogin: '2025-04-29' },
  { id: 'A003', name: 'Amit Khanna', mobile: '9311999003', email: 'amit.k@parleagro.com', role: 'MIS_USER', isActive: true, createdAt: '2024-01-10', lastLogin: '2025-04-28' },
];

const ROLE_LABELS: Record<string, string> = {
  GIFSY_ADMIN: 'Gifsy Admin',
  CLIENT_ADMIN: 'Client Admin',
  MIS_USER: 'MIS User',
  SALES_MANAGER: 'Sales Manager',
  AREA_SALES_MANAGER: 'Area Sales Manager',
  TERRITORY_SALES_OFFICER: 'TSO',
  SALES_EXECUTIVE: 'Sales Executive',
  RETAILER: 'Retailer',
  WHOLESALER: 'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
};

const ROLE_COLORS: Record<string, string> = {
  GIFSY_ADMIN: 'bg-red-100 text-red-700',
  CLIENT_ADMIN: 'bg-purple-100 text-purple-700',
  MIS_USER: 'bg-blue-100 text-blue-700',
  SALES_MANAGER: 'bg-indigo-100 text-indigo-700',
  AREA_SALES_MANAGER: 'bg-cyan-100 text-cyan-700',
  TERRITORY_SALES_OFFICER: 'bg-teal-100 text-teal-700',
  SALES_EXECUTIVE: 'bg-green-100 text-green-700',
  RETAILER: 'bg-amber-100 text-amber-700',
  WHOLESALER: 'bg-orange-100 text-orange-700',
  SUB_STOCKIST: 'bg-yellow-100 text-yellow-700',
};

const CLASS_COLORS: Record<string, string> = {
  PLATINUM: 'text-purple-700 bg-purple-50',
  GOLD: 'text-amber-700 bg-amber-50',
  SILVER: 'text-gray-600 bg-gray-100',
  BRONZE: 'text-orange-700 bg-orange-50',
};

interface AddUserModalProps {
  tab: TabType;
  onClose: () => void;
}

function AddUserModal({ tab, onClose }: AddUserModalProps) {
  const [form, setForm] = useState({ name: '', mobile: '', email: '', role: '', territory: '' });
  const [saving, setSaving] = useState(false);

  const roleOptions = tab === 'sales'
    ? ['SALES_MANAGER', 'AREA_SALES_MANAGER', 'TERRITORY_SALES_OFFICER', 'SALES_EXECUTIVE']
    : tab === 'partners'
    ? ['RETAILER', 'WHOLESALER', 'SUB_STOCKIST']
    : ['CLIENT_ADMIN', 'MIS_USER'];

  const handleSubmit = async () => {
    if (!form.name || !form.mobile || !form.role) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Add New User</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Enter full name"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Mobile Number *</label>
            <input
              type="tel"
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              placeholder="10-digit mobile number"
              maxLength={10}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            />
          </div>
          {tab !== 'partners' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="Work email address"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Role *</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            >
              <option value="">Select role</option>
              {roleOptions.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
          {(tab === 'sales' || tab === 'partners') && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Territory</label>
              <input
                type="text"
                value={form.territory}
                onChange={(e) => setForm({ ...form, territory: e.target.value })}
                placeholder="Assign territory"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
            </div>
          )}
        </div>
        <div className="flex gap-3 p-6 border-t border-gray-100">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.name || !form.mobile || !form.role}
            className="flex-1 py-2.5 bg-[#C8102E] text-white rounded-lg text-sm font-medium hover:bg-[#a00d25] transition-colors disabled:opacity-60"
          >
            {saving ? 'Creating...' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserTable({ users, showClass = false }: { users: UserRow[]; showClass?: boolean }) {
  const [search, setSearch] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.mobile.includes(search) ||
      u.role.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Mobile</th>
                {!showClass && <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Territory</th>}
                {showClass && <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Class</th>}
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Role</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Last Login</th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">No users found</td>
                </tr>
              ) : (
                filtered.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-[#1A1A2E] text-white text-xs font-bold flex items-center justify-center">
                          {u.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{u.name}</p>
                          {u.email && <p className="text-xs text-gray-400">{u.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{u.mobile}</td>
                    {!showClass && (
                      <td className="px-4 py-3 text-sm text-gray-600">{u.territory ?? u.region ?? '—'}</td>
                    )}
                    {showClass && (
                      <td className="px-4 py-3">
                        {u.partnerClass ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CLASS_COLORS[u.partnerClass] ?? ''}`}>
                            {u.partnerClass}
                          </span>
                        ) : '—'}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ROLE_COLORS[u.role] ?? 'bg-gray-100 text-gray-700'}`}>
                        {ROLE_LABELS[u.role] ?? u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${u.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                        {u.isActive ? <UserCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{u.lastLogin ?? '—'}</td>
                    <td className="px-4 py-3 relative">
                      <button
                        onClick={() => setOpenMenu(openMenu === u.id ? null : u.id)}
                        className="p-1 rounded hover:bg-gray-200 transition-colors"
                      >
                        <MoreVertical className="w-4 h-4 text-gray-500" />
                      </button>
                      {openMenu === u.id && (
                        <div className="absolute right-4 top-8 w-36 bg-white rounded-lg shadow-lg border border-gray-200 z-10 py-1">
                          <button className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">View Profile</button>
                          <button className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">Edit Details</button>
                          <button className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">Reset Password</button>
                          <hr className="my-1 border-gray-100" />
                          <button className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${u.isActive ? 'text-red-600' : 'text-green-600'}`}>
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [tab, setTab] = useState<TabType>('sales');
  const [showAddModal, setShowAddModal] = useState(false);

  const tabs: { key: TabType; label: string; count: number }[] = [
    { key: 'sales', label: 'Sales Hierarchy', count: SALES_USERS.length },
    { key: 'partners', label: 'Channel Partners', count: PARTNER_USERS.length },
    { key: 'admin', label: 'Admin Users', count: ADMIN_USERS.length },
  ];

  return (
    <div className="space-y-5 fade-in">
      {/* Header with Add User */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                tab === t.key
                  ? 'bg-[#C8102E] text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${
                tab === t.key ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>
                {t.count}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[#C8102E] text-white text-sm font-medium rounded-lg hover:bg-[#a00d25] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {tab === 'sales' && <UserTable users={SALES_USERS} />}
      {tab === 'partners' && <UserTable users={PARTNER_USERS} showClass />}
      {tab === 'admin' && <UserTable users={ADMIN_USERS} />}

      {showAddModal && <AddUserModal tab={tab} onClose={() => setShowAddModal(false)} />}
    </div>
  );
}
