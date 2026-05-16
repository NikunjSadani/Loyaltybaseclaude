'use client';

import { useState, useMemo } from 'react';
import {
  Search,
  Download,
  CheckSquare,
  AlertTriangle,
  Clock,
  CheckCircle,
  XCircle,
  Filter,
  ChevronRight,
  Eye,
} from 'lucide-react';
import Link from 'next/link';

type KYCStatusType = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'RESUBMISSION_REQUIRED';

interface KYCEntry {
  id: string;
  outletName: string;
  mobile: string;
  partnerClass: string;
  salesUser: string;
  territory: string;
  status: KYCStatusType;
  submittedDate: string;
  ageHrs: number;
  slaBreached: boolean;
}

const ALL_KYC: KYCEntry[] = [
  { id: 'KYC001', outletName: 'Sharma General Store', mobile: '9820184321', partnerClass: 'GOLD', salesUser: 'Rohit Verma', territory: 'Mumbai West', status: 'PENDING', submittedDate: '2025-04-30', ageHrs: 18, slaBreached: false },
  { id: 'KYC002', outletName: 'Ramesh Traders', mobile: '9811034021', partnerClass: 'SILVER', salesUser: 'Sanjay Kumar', territory: 'Delhi NCR', status: 'PENDING', submittedDate: '2025-04-29', ageHrs: 36, slaBreached: false },
  { id: 'KYC003', outletName: 'Patel Kirana', mobile: '9898123456', partnerClass: 'BRONZE', salesUser: 'Anita Patel', territory: 'Ahmedabad', status: 'UNDER_REVIEW', submittedDate: '2025-04-28', ageHrs: 52, slaBreached: true },
  { id: 'KYC004', outletName: 'Lalitha Stores', mobile: '9945223311', partnerClass: 'GOLD', salesUser: 'Kiran Rao', territory: 'Bengaluru', status: 'RESUBMISSION_REQUIRED', submittedDate: '2025-04-27', ageHrs: 72, slaBreached: true },
  { id: 'KYC005', outletName: 'Krishnamurthy & Sons', mobile: '9444181920', partnerClass: 'PLATINUM', salesUser: 'Mohan Raj', territory: 'Chennai', status: 'APPROVED', submittedDate: '2025-04-26', ageHrs: 24, slaBreached: false },
  { id: 'KYC006', outletName: 'Gupta Provisions', mobile: '9311402841', partnerClass: 'SILVER', salesUser: 'Deepak Singh', territory: 'Lucknow', status: 'REJECTED', submittedDate: '2025-04-25', ageHrs: 41, slaBreached: false },
  { id: 'KYC007', outletName: 'Mehta Mart', mobile: '9820011234', partnerClass: 'GOLD', salesUser: 'Rohit Verma', territory: 'Mumbai West', status: 'PENDING', submittedDate: '2025-04-30', ageHrs: 12, slaBreached: false },
  { id: 'KYC008', outletName: 'Suresh Wholesalers', mobile: '9533201102', partnerClass: 'BRONZE', salesUser: 'Prasad N.', territory: 'Hyderabad', status: 'PENDING', submittedDate: '2025-04-29', ageHrs: 42, slaBreached: false },
  { id: 'KYC009', outletName: 'Aggarwal General Store', mobile: '9210401120', partnerClass: 'SILVER', salesUser: 'Sanjay Kumar', territory: 'Delhi NCR', status: 'UNDER_REVIEW', submittedDate: '2025-04-28', ageHrs: 60, slaBreached: true },
  { id: 'KYC010', outletName: 'Banerjee Traders', mobile: '9830221412', partnerClass: 'STANDARD', salesUser: 'Tanmoy Das', territory: 'Kolkata', status: 'APPROVED', submittedDate: '2025-04-24', ageHrs: 28, slaBreached: false },
  { id: 'KYC011', outletName: 'Nair Beverages Hub', mobile: '9446102312', partnerClass: 'GOLD', salesUser: 'Vijayan P.', territory: 'Kochi', status: 'PENDING', submittedDate: '2025-04-30', ageHrs: 8, slaBreached: false },
  { id: 'KYC012', outletName: 'Tiwari Kirana', mobile: '9425011824', partnerClass: 'BRONZE', salesUser: 'Manoj Dubey', territory: 'Bhopal', status: 'REJECTED', submittedDate: '2025-04-22', ageHrs: 92, slaBreached: true },
];

const STATUS_STYLES: Record<KYCStatusType, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  UNDER_REVIEW: 'bg-blue-100 text-blue-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  RESUBMISSION_REQUIRED: 'bg-orange-100 text-orange-700',
};

const STATUS_LABELS: Record<KYCStatusType, string> = {
  PENDING: 'Pending',
  UNDER_REVIEW: 'Under Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RESUBMISSION_REQUIRED: 'Re-upload Required',
};

const CLASS_COLORS: Record<string, string> = {
  PLATINUM: 'text-purple-700 bg-purple-50',
  GOLD: 'text-amber-700 bg-amber-50',
  SILVER: 'text-gray-600 bg-gray-100',
  BRONZE: 'text-orange-700 bg-orange-50',
  STANDARD: 'text-blue-700 bg-blue-50',
};

export default function KYCPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<KYCStatusType | 'ALL'>('ALL');
  const [classFilter, setClassFilter] = useState('ALL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);

  const stats = useMemo(() => ({
    total: ALL_KYC.length,
    pending: ALL_KYC.filter((k) => k.status === 'PENDING' || k.status === 'UNDER_REVIEW').length,
    approved: ALL_KYC.filter((k) => k.status === 'APPROVED').length,
    rejected: ALL_KYC.filter((k) => k.status === 'REJECTED').length,
    breached: ALL_KYC.filter((k) => k.slaBreached).length,
  }), []);

  const filtered = useMemo(() => {
    return ALL_KYC.filter((k) => {
      const matchSearch =
        !search ||
        k.outletName.toLowerCase().includes(search.toLowerCase()) ||
        k.mobile.includes(search) ||
        k.salesUser.toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === 'ALL' || k.status === statusFilter;
      const matchClass = classFilter === 'ALL' || k.partnerClass === classFilter;
      return matchSearch && matchStatus && matchClass;
    });
  }, [search, statusFilter, classFilter]);

  const pendingIds = filtered.filter((k) => k.status === 'PENDING').map((k) => k.id);
  const allPendingSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelected((s) => {
        const next = new Set(s);
        pendingIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((s) => new Set([...s, ...pendingIds]));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkApprove = async () => {
    setBulkApproving(true);
    await new Promise((r) => setTimeout(r, 1200));
    setSelected(new Set());
    setBulkApproving(false);
    alert(`${selected.size} KYC submissions approved successfully.`);
  };

  const handleExport = () => {
    alert('Exporting KYC data to Excel...');
  };

  return (
    <div className="space-y-5 fade-in">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total', value: stats.total, icon: Filter, color: 'text-gray-600 bg-gray-100', filter: 'ALL' },
          { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-amber-600 bg-amber-100', filter: 'PENDING' },
          { label: 'Approved', value: stats.approved, icon: CheckCircle, color: 'text-green-600 bg-green-100', filter: 'APPROVED' },
          { label: 'Rejected', value: stats.rejected, icon: XCircle, color: 'text-red-600 bg-red-100', filter: 'REJECTED' },
          { label: 'SLA Breached', value: stats.breached, icon: AlertTriangle, color: 'text-orange-600 bg-orange-100', filter: 'ALL' },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              onClick={() => setStatusFilter(s.filter as KYCStatusType | 'ALL')}
              className={`bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-3 hover:shadow-md transition-all text-left ${
                statusFilter === s.filter ? 'border-[#C8102E] ring-1 ring-[#C8102E]/20' : ''
              }`}
            >
              <div className={`p-2 rounded-lg ${s.color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters & actions */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-3 flex-1">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search outlet, mobile, sales user..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as KYCStatusType | 'ALL')}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            >
              <option value="ALL">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="UNDER_REVIEW">Under Review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="RESUBMISSION_REQUIRED">Re-upload Required</option>
            </select>
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            >
              <option value="ALL">All Classes</option>
              <option value="PLATINUM">Platinum</option>
              <option value="GOLD">Gold</option>
              <option value="SILVER">Silver</option>
              <option value="BRONZE">Bronze</option>
              <option value="STANDARD">Standard</option>
            </select>
          </div>
          <div className="flex gap-2">
            {selected.size > 0 && (
              <button
                onClick={handleBulkApprove}
                disabled={bulkApproving}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60"
              >
                <CheckSquare className="w-4 h-4" />
                {bulkApproving ? 'Approving...' : `Approve ${selected.size} Selected`}
              </button>
            )}
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Export Excel
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allPendingSelected}
                    onChange={toggleSelectAll}
                    className="rounded accent-[#C8102E]"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Mobile</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Class</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Sales User</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Submitted</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Age (hrs)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-400">
                    No KYC records match your filters
                  </td>
                </tr>
              ) : (
                filtered.map((k) => (
                  <tr key={k.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      {k.status === 'PENDING' && (
                        <input
                          type="checkbox"
                          checked={selected.has(k.id)}
                          onChange={() => toggleOne(k.id)}
                          className="rounded accent-[#C8102E]"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{k.outletName}</p>
                        <p className="text-xs text-gray-400">{k.territory}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.mobile}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CLASS_COLORS[k.partnerClass]}`}>
                        {k.partnerClass}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.salesUser}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[k.status]}`}>
                        {STATUS_LABELS[k.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.submittedDate}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-sm font-semibold ${
                          k.slaBreached ? 'text-red-600' : k.ageHrs > 36 ? 'text-amber-600' : 'text-gray-700'
                        }`}
                      >
                        {k.ageHrs}h
                        {k.slaBreached && (
                          <AlertTriangle className="w-3 h-3 inline ml-1 text-red-500" />
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/kyc/${k.id}`}
                        className="inline-flex items-center gap-1 text-xs text-[#C8102E] hover:text-[#a00d25] font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Review
                        <ChevronRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <p className="text-xs text-gray-500">
            Showing {filtered.length} of {ALL_KYC.length} KYC submissions
          </p>
        </div>
      </div>
    </div>
  );
}
