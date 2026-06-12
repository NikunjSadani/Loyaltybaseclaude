'use client';

import { use, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Search,
  Filter,
  Users,
  UserCheck,
  UserCog,
  CheckCircle,
  Clock,
  MapPin,
  TrendingUp,
  Building2,
  Phone,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  computeEnrollmentStats,
  buildExcelExportRows,
  MOCK_CAMPAIGN_OUTLETS,
  MOCK_ENROLLMENTS,
  type EnrollmentRecord,
  type OutletRecord,
  type FormField,
} from '@/lib/campaign';

// ─────────────────────────────────────────────────────────────────────────────
// Mock form fields for demo
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_FORM_FIELDS: FormField[] = [
  { id: 'f-name', type: 'TEXT', label: 'Contact Name', required: true, order: 0, autoFillFromExcel: false, autoFillEditable: true },
  { id: 'f-type', type: 'DROPDOWN', label: 'Shop Type', required: true, order: 1, options: ['Kirana', 'Supermarket', 'Pharmacy', 'Bakery'], autoFillFromExcel: false, autoFillEditable: false },
  { id: 'f-area', type: 'NUMBER', label: 'Shop Area (sqft)', required: false, order: 2, autoFillFromExcel: true, autoFillEditable: true },
  { id: 'f-photo', type: 'IMAGE', label: 'Shop Front Photo', required: true, order: 3, autoFillFromExcel: false, autoFillEditable: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const fmtPct = (n: number) => `${n}%`;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function EnrollmentDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);

  // Demo data scoped to this schemeId
  const allTargeted = MOCK_CAMPAIGN_OUTLETS;
  const allEnrollments = MOCK_ENROLLMENTS.filter((e) => e.schemeId === schemeId || schemeId === 'SCH001');

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('ALL');
  const [filterEmployee, setFilterEmployee] = useState('ALL');
  const [filterKyc, setFilterKyc] = useState('ALL');
  const [filterEnrolledBy, setFilterEnrolledBy] = useState('ALL');
  const [filterOtp, setFilterOtp] = useState('ALL');
  const [sortField, setSortField] = useState<'submittedAt' | 'outletName'>('submittedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const uniqueStates    = useMemo(() => [...new Set(allEnrollments.map((e) => e.state))].sort(), [allEnrollments]);
  const uniqueEmployees = useMemo(() => [...new Set(allEnrollments.map((e) => e.assignedEmployeeId))].sort(), [allEnrollments]);

  const filtered = useMemo(() => {
    let rows = [...allEnrollments];
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((e) =>
        e.outletName.toLowerCase().includes(q) ||
        e.outletId.toLowerCase().includes(q) ||
        e.assignedEmployeeName.toLowerCase().includes(q),
      );
    }
    if (filterState    !== 'ALL') rows = rows.filter((e) => e.state === filterState);
    if (filterEmployee !== 'ALL') rows = rows.filter((e) => e.assignedEmployeeId === filterEmployee);
    if (filterKyc === 'KYC')      rows = rows.filter((e) => e.isKycEnrolled);
    if (filterKyc === 'NON_KYC')  rows = rows.filter((e) => !e.isKycEnrolled);
    if (filterEnrolledBy === 'SELF')     rows = rows.filter((e) => e.enrolledBy === 'SELF');
    if (filterEnrolledBy === 'EMPLOYEE') rows = rows.filter((e) => e.enrolledBy === 'EMPLOYEE');
    if (filterOtp === 'VERIFIED')     rows = rows.filter((e) => e.otpVerified);
    if (filterOtp === 'NOT_VERIFIED') rows = rows.filter((e) => !e.otpVerified);

    rows.sort((a, b) => {
      const av = a[sortField]; const bv = b[sortField];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [allEnrollments, search, filterState, filterEmployee, filterKyc, filterEnrolledBy, filterOtp, sortField, sortDir]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(
    () => computeEnrollmentStats(allTargeted, allEnrollments),
    [allTargeted, allEnrollments],
  );

  // ── Excel Export ──────────────────────────────────────────────────────────
  const handleExport = () => {
    const rows = buildExcelExportRows(allEnrollments, DEMO_FORM_FIELDS);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enrollments');
    XLSX.writeFile(wb, `enrollments_${schemeId}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // ── Sort toggle ───────────────────────────────────────────────────────────
  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }: { field: typeof sortField }) =>
    sortField === field
      ? sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
      : <ChevronDown className="w-3 h-3 text-gray-300" />;

  return (
    <div className="space-y-5 fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/admin/schemes/${schemeId}`}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Enrollment Dashboard</h1>
            <p className="text-xs text-gray-500">Scheme {schemeId} · All enrollment activity</p>
          </div>
        </div>
        <button onClick={handleExport}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors">
          <Download className="w-4 h-4" />
          Export Excel
        </button>
      </div>

      {/* ── Summary strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        {[
          { label: 'Targeted',       value: stats.totalTargeted,   icon: <Users className="w-4 h-4 text-gray-500" />,       bg: 'bg-gray-50' },
          { label: 'Enrolled',       value: stats.totalEnrolled,   icon: <UserCheck className="w-4 h-4 text-green-600" />,  bg: 'bg-green-50' },
          { label: 'Enrolment %',    value: fmtPct(stats.enrollmentPct), icon: <TrendingUp className="w-4 h-4 text-blue-600" />, bg: 'bg-blue-50' },
          { label: 'Self-enrolled',  value: stats.selfEnrolled,    icon: <UserCog className="w-4 h-4 text-purple-600" />,   bg: 'bg-purple-50' },
          { label: 'By Employee',    value: stats.employeeEnrolled,icon: <Building2 className="w-4 h-4 text-amber-600" />,  bg: 'bg-amber-50' },
          { label: 'OTP Verified',   value: stats.otpVerifiedCount,icon: <Phone className="w-4 h-4 text-teal-600" />,       bg: 'bg-teal-50' },
        ].map(({ label, value, icon, bg }) => (
          <div key={label} className={`${bg} rounded-xl border border-gray-100 p-3 flex items-center gap-2`}>
            {icon}
            <div>
              <p className="text-base font-bold text-gray-900 leading-none">{value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Geography + Employee breakdown ─────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* State breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-gray-500" /> State-wise Enrollment
          </h3>
          {stats.byState.length === 0
            ? <p className="text-xs text-gray-400">No data yet</p>
            : (
              <div className="space-y-2">
                {stats.byState
                  .sort((a, b) => b.enrolled - a.enrolled)
                  .map(({ state, targeted, enrolled, pct }) => (
                    <div key={state}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="text-gray-700 font-medium">{state}</span>
                        <span className="text-gray-500">{enrolled}/{targeted} · {fmtPct(pct)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-[var(--brand-primary)] rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ))}
              </div>
            )}
        </div>

        {/* Employee leaderboard */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-gray-500" /> Employee Leaderboard
          </h3>
          {stats.byEmployee.length === 0
            ? <p className="text-xs text-gray-400">No employee-enrolled outlets yet</p>
            : (
              <div className="space-y-2">
                {stats.byEmployee.map(({ employeeId, employeeName, count }, idx) => (
                  <div key={employeeId} className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      idx === 0 ? 'bg-amber-100 text-amber-700' :
                      idx === 1 ? 'bg-gray-200 text-gray-700' :
                      idx === 2 ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{employeeName}</p>
                      <p className="text-xs text-gray-400 font-mono">{employeeId}</p>
                    </div>
                    <span className="text-sm font-bold text-gray-900">{count}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search outlet, employee…"
              className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            />
          </div>

          {/* State filter */}
          <select value={filterState} onChange={(e) => setFilterState(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <option value="ALL">All States</option>
            {uniqueStates.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Employee filter */}
          <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <option value="ALL">All Employees</option>
            {uniqueEmployees.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>

          {/* KYC filter */}
          <select value={filterKyc} onChange={(e) => setFilterKyc(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <option value="ALL">KYC + Non-KYC</option>
            <option value="KYC">KYC Only</option>
            <option value="NON_KYC">Non-KYC Only</option>
          </select>

          {/* Enrolled-by filter */}
          <select value={filterEnrolledBy} onChange={(e) => setFilterEnrolledBy(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <option value="ALL">Self + Employee</option>
            <option value="SELF">Self-enrolled</option>
            <option value="EMPLOYEE">By Employee</option>
          </select>

          {/* OTP filter */}
          <select value={filterOtp} onChange={(e) => setFilterOtp(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <option value="ALL">Any OTP status</option>
            <option value="VERIFIED">OTP Verified</option>
            <option value="NOT_VERIFIED">Not Verified</option>
          </select>
        </div>

        {(filterState !== 'ALL' || filterEmployee !== 'ALL' || filterKyc !== 'ALL' || filterEnrolledBy !== 'ALL' || filterOtp !== 'ALL' || search) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
            <Filter className="w-3.5 h-3.5" />
            Showing {filtered.length} of {allEnrollments.length} enrollments
            <button onClick={() => { setSearch(''); setFilterState('ALL'); setFilterEmployee('ALL'); setFilterKyc('ALL'); setFilterEnrolledBy('ALL'); setFilterOtp('ALL'); }}
              className="text-[var(--brand-primary)] hover:underline font-medium">
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* ── Enrollment table ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">
                  <button onClick={() => toggleSort('outletName')} className="flex items-center gap-1 hover:text-gray-700">
                    Outlet <SortIcon field="outletName" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Type / KYC</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">State</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Employee</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Enrolled By</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">OTP</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">GPS</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">
                  <button onClick={() => toggleSort('submittedAt')} className="flex items-center gap-1 hover:text-gray-700">
                    Submitted <SortIcon field="submittedAt" />
                  </button>
                </th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <Users className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    No enrollments match your filters
                  </td>
                </tr>
              )}
              {filtered.map((enr) => (
                <>
                  <tr key={enr.enrollmentId}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setExpandedId(expandedId === enr.enrollmentId ? null : enr.enrollmentId)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{enr.outletName}</p>
                      <p className="text-gray-400 font-mono">{enr.outletId}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-700">{enr.outletType}</p>
                      {enr.isKycEnrolled
                        ? <span className="text-green-600 font-medium">KYC ✓</span>
                        : <span className="text-gray-400">Non-KYC</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{enr.state}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{enr.assignedEmployeeName}</p>
                      <p className="text-gray-400 font-mono">{enr.assignedEmployeeId}</p>
                    </td>
                    <td className="px-4 py-3">
                      {enr.enrolledBy === 'SELF'
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
                            <UserCog className="w-3 h-3" /> Self
                          </span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                            <Building2 className="w-3 h-3" /> Employee
                          </span>}
                    </td>
                    <td className="px-4 py-3">
                      {enr.otpVerified
                        ? <span className="flex items-center gap-1 text-green-600 font-medium"><CheckCircle className="w-3 h-3" /> Verified</span>
                        : <span className="flex items-center gap-1 text-amber-500 font-medium"><Clock className="w-3 h-3" /> Pending</span>}
                    </td>
                    <td className="px-4 py-3">
                      {enr.submissionGps
                        ? <span className="flex items-center gap-1 text-teal-600"><MapPin className="w-3 h-3" /> {enr.submissionGps.lat.toFixed(4)}</span>
                        : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(enr.submittedAt)}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {expandedId === enr.enrollmentId ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                  </tr>

                  {/* Expanded row — audit log + field values */}
                  {expandedId === enr.enrollmentId && (
                    <tr key={`${enr.enrollmentId}-expanded`} className="bg-gray-50">
                      <td colSpan={9} className="px-4 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                          {/* Field values */}
                          <div>
                            <h4 className="text-xs font-semibold text-gray-700 mb-2">Form Field Values</h4>
                            {Object.keys(enr.fieldValues).length === 0
                              ? <p className="text-xs text-gray-400">No form fields submitted</p>
                              : (
                                <div className="space-y-1">
                                  {DEMO_FORM_FIELDS.filter((f) => enr.fieldValues[f.id] !== undefined).map((f) => (
                                    <div key={f.id} className="flex gap-3 text-xs">
                                      <span className="text-gray-500 w-32 shrink-0">{f.label}:</span>
                                      <span className="text-gray-800 font-medium">{String(enr.fieldValues[f.id] ?? '—')}</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                            {/* Photo geo-tags */}
                            {enr.photoGeoTags.length > 0 && (
                              <div className="mt-2">
                                <h5 className="text-xs font-semibold text-gray-600 mb-1">Photo GPS Tags</h5>
                                {enr.photoGeoTags.map((t, i) => (
                                  <p key={i} className="text-xs text-teal-700 font-mono">
                                    Photo {t.photoIndex}: {t.lat.toFixed(5)}, {t.lng.toFixed(5)} @ {new Date(t.capturedAt).toLocaleTimeString()}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Audit log */}
                          <div>
                            <h4 className="text-xs font-semibold text-gray-700 mb-2">Audit Log</h4>
                            <div className="space-y-1.5">
                              {enr.auditLog.map((entry, i) => (
                                <div key={i} className="flex items-start gap-2 text-xs">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] mt-1.5 shrink-0" />
                                  <div>
                                    <span className="font-medium text-gray-800">{entry.event}</span>
                                    <span className="text-gray-400"> · {entry.actorId}</span>
                                    <p className="text-gray-500">{entry.detail}</p>
                                    <p className="text-gray-400 font-mono">{fmtDate(entry.timestamp)}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* OTP details */}
                        {enr.otpVerified && (
                          <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2 border border-green-100">
                            <Phone className="w-3.5 h-3.5 shrink-0" />
                            OTP verified on {enr.otpPhone} at {enr.otpVerifiedAt ? fmtDate(enr.otpVerifiedAt) : '—'}
                          </div>
                        )}

                        {!enr.otpVerified && (
                          <div className="mt-3 flex items-center gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 border border-amber-100">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            OTP not yet verified. Outlet phone: {enr.otpPhone}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
