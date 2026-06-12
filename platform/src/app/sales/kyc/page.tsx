'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Plus, Search, ChevronRight, ClipboardList, ArrowUpDown } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { KYCStatus } from '@/types';
import { cn } from '@/lib/utils';
import { type SalesRole, getRole, hasTeamView } from '@/lib/sales-role';

interface KYCEntry {
  id: string;
  partnerName: string;
  firmName: string;
  /** Outlet code assigned to this outlet — shown to help distinguish same-name stores */
  outletCode: string;
  mobile: string;
  status: KYCStatus;
  submittedAt: string;
  updatedAt: string;
  rejectionReason?: string;
  /** ID of the team member (XSR / SO / etc.) who submitted this KYC */
  submittedById?: string;
}

/* ─── Team member data (mirrors team page mock hierarchy) ────────────────────── */

interface TeamMember { id: string; name: string; }

const TEAM_MEMBERS_BY_ROLE: Partial<Record<SalesRole, TeamMember[]>> = {
  SO:  [
    { id: 'xsr1', name: 'Anil Sharma'     },
    { id: 'xsr2', name: 'Divya Pillai'    },
    { id: 'xsr3', name: 'Kiran Rao'       },
    { id: 'xsr4', name: 'Meena Joshi'     },
  ],
  ASM: [
    { id: 'so1', name: 'Rajesh Kumar'    },
    { id: 'so2', name: 'Nisha Verma'     },
    { id: 'so3', name: 'Arjun Patil'     },
    { id: 'so4', name: 'Sunita Desai'    },
  ],
  RSM: [
    { id: 'asm1', name: 'Priya Mehta'      },
    { id: 'asm2', name: 'Rohit Deshpande' },
    { id: 'asm3', name: 'Sonal Agrawal'   },
    { id: 'asm4', name: 'Vikram Bhosale'  },
  ],
  ZM:  [
    { id: 'rsm1', name: 'Suresh Nair'    },
    { id: 'rsm2', name: 'Leela Iyer'     },
    { id: 'rsm3', name: 'Deepak Tiwari'  },
    { id: 'rsm4', name: 'Ananya Bose'    },
  ],
  NM:  [
    { id: 'zm1', name: 'Vikram Singh'   },
    { id: 'zm2', name: 'Ravi Menon'     },
    { id: 'zm3', name: 'Kavita Sharma'  },
    { id: 'zm4', name: 'Arun Gupta'     },
  ],
};

const APPROVAL_REQUIRED_KEY = 'APPROVAL_REQUIRED' as const;
const UNDER_REVIEW_KEY      = 'UNDER_REVIEW'      as const;
type FilterKey = 'ALL' | typeof APPROVAL_REQUIRED_KEY | typeof UNDER_REVIEW_KEY | KYCStatus;
type SortOrder = 'newest' | 'oldest';

function getApprovalStatus(): KYCStatus | null {
  const role = getRole();
  if (role === 'SO')  return KYCStatus.PENDING_SO_APPROVAL;
  if (role === 'ASM') return KYCStatus.PENDING_ASM_APPROVAL;
  if (role === 'RSM') return KYCStatus.PENDING_RSM_APPROVAL;
  return null;
}

const UNDER_REVIEW_STATUSES = new Set<KYCStatus>([
  KYCStatus.PENDING_SO_APPROVAL,
  KYCStatus.PENDING_ASM_APPROVAL,
  KYCStatus.PENDING_RSM_APPROVAL,
  KYCStatus.PENDING_GIFSY,
]);

const APPROVAL_REQUIRED_STATUSES = new Set<KYCStatus>([
  KYCStatus.PENDING_SO_APPROVAL,
  KYCStatus.PENDING_ASM_APPROVAL,
  KYCStatus.PENDING_RSM_APPROVAL,
]);

const STATUS_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'ALL',                  label: 'All'               },
  { key: KYCStatus.PENDING,      label: 'Pending KYC'       },
  { key: APPROVAL_REQUIRED_KEY,  label: 'Approval Pending'  },
  { key: UNDER_REVIEW_KEY,       label: 'Under Review'      },
  { key: KYCStatus.APPROVED,     label: 'Approved'          },
  { key: KYCStatus.REJECTED,     label: 'Rejected'          },
  { key: KYCStatus.RESUBMISSION_REQUIRED, label: 'Re-upload'       },
  { key: KYCStatus.RE_KYC_REQUIRED,       label: 'Re-KYC Required' },
];

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]:              { variant: 'success', label: 'Approved'         },
  [KYCStatus.PENDING]:               { variant: 'warning', label: 'Draft'            },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'        },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'In Review'        },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'      },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'     },
  [KYCStatus.PENDING_RSM_APPROVAL]:  { variant: 'warning', label: 'Awaiting RSM'     },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Awaiting Gifsy'   },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'         },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Re-upload'        },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC Required'  },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'       },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested'    },
};

const MOCK_KYC: KYCEntry[] = [
  { id: 'k1', partnerName: 'Rajesh Kumar',   firmName: 'Kumar General Store', outletCode: 'OUT-MH-2841', mobile: '9876543210', status: KYCStatus.APPROVED,            submittedAt: '2026-04-01', updatedAt: '2026-04-05', submittedById: 'xsr1' },
  { id: 'k2', partnerName: 'Amit Sharma',    firmName: 'Sharma Kirana',       outletCode: 'OUT-MH-2842', mobile: '9765432109', status: KYCStatus.PENDING_SO_APPROVAL,  submittedAt: '2026-05-10', updatedAt: '2026-05-10', submittedById: 'xsr2' },
  { id: 'k3', partnerName: 'Suresh Patel',   firmName: 'Patel Grocery',       outletCode: 'OUT-MH-2843', mobile: '9654321098', status: KYCStatus.REJECTED,             submittedAt: '2026-04-20', updatedAt: '2026-05-01', rejectionReason: 'GST certificate invalid', submittedById: 'xsr3' },
  { id: 'k4', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart',     outletCode: 'OUT-MH-2844', mobile: '9543210987', status: KYCStatus.APPROVED,             submittedAt: '2026-03-15', updatedAt: '2026-03-20', submittedById: 'xsr4' },
  { id: 'k5', partnerName: 'Vijay Mehta',    firmName: 'Mehta Provisions',    outletCode: 'OUT-MH-2845', mobile: '9432109876', status: KYCStatus.PENDING_GIFSY,        submittedAt: '2026-05-14', updatedAt: '2026-05-15', submittedById: 'xsr1' },
  { id: 'k6', partnerName: 'Priya Desai',    firmName: 'Desai Grocers',       outletCode: 'OUT-MH-2853', mobile: '9321098765', status: KYCStatus.PENDING_ASM_APPROVAL, submittedAt: '2026-05-12', updatedAt: '2026-05-12', submittedById: 'xsr2' },
  { id: 'k7', partnerName: 'Suresh Nair',    firmName: 'Suresh Wholesale',    outletCode: 'OUT-MH-2847', mobile: '9210987654', status: KYCStatus.RE_KYC_REQUIRED,      submittedAt: '2026-03-10', updatedAt: '2026-05-20', rejectionReason: 'KYC expired — renewal required', submittedById: 'xsr3' },
  { id: 'k8', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart',     outletCode: 'OUT-MH-2848', mobile: '9543210987', status: KYCStatus.RE_KYC_REQUIRED,      submittedAt: '2026-03-15', updatedAt: '2026-05-22', rejectionReason: 'GST number updated — re-verify', submittedById: 'xsr4' },
];

/* ─── Relative date ──────────────────────────────────────────────────────────── */
function relativeDate(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Yesterday';
  if (diff < 30)   return `${diff} days ago`;
  const months = Math.floor(diff / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
}

/* ─── Row border by status ───────────────────────────────────────────────────── */
function rowBorder(status: KYCStatus, approvalStatus: KYCStatus | null): string {
  if (approvalStatus && status === approvalStatus) return 'border-l-4 border-l-blue-400';
  if (status === KYCStatus.REJECTED || status === KYCStatus.RESUBMISSION_REQUIRED) return 'border-l-4 border-l-red-400';
  if (status === KYCStatus.RE_KYC_REQUIRED) return 'border-l-4 border-l-purple-400';
  return '';
}

function KYCListContent() {
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get('status');
  const approvalStatus = getApprovalStatus();
  const role = getRole();
  const canEnroll = role === 'XSR' || role === 'SO';

  const statusParam: FilterKey | null = rawStatus
    ? rawStatus === APPROVAL_REQUIRED_KEY
      ? APPROVAL_REQUIRED_KEY
      : rawStatus === UNDER_REVIEW_KEY || UNDER_REVIEW_STATUSES.has(rawStatus as KYCStatus)
        ? UNDER_REVIEW_KEY
        : (rawStatus as FilterKey)
    : null;

  const [entries,      setEntries]      = useState<KYCEntry[]>([]);
  const [filter,       setFilter]       = useState<FilterKey>(statusParam ?? 'ALL');
  const [search,       setSearch]       = useState('');
  const [loading,      setLoading]      = useState(true);
  const [sortOrder,    setSortOrder]    = useState<SortOrder>('newest');
  const [memberFilter, setMemberFilter] = useState('');

  const teamMembers = TEAM_MEMBERS_BY_ROLE[role] ?? [];

  useEffect(() => {
    if (statusParam) setFilter(statusParam);
  }, [statusParam]);

  useEffect(() => {
    const t = setTimeout(() => { setEntries(MOCK_KYC); setLoading(false); }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = entries
    .filter((e) => {
      const matchesMember = !memberFilter || e.submittedById === memberFilter;
      const matchesStatus =
        filter === 'ALL'                 ? true :
        filter === APPROVAL_REQUIRED_KEY ? (approvalStatus ? e.status === approvalStatus : false) :
        filter === UNDER_REVIEW_KEY      ? (UNDER_REVIEW_STATUSES.has(e.status) && e.status !== approvalStatus) :
        e.status === filter;
      const matchesSearch =
        e.partnerName.toLowerCase().includes(search.toLowerCase()) ||
        e.firmName.toLowerCase().includes(search.toLowerCase()) ||
        e.mobile.includes(search) ||
        e.outletCode.toLowerCase().includes(search.toLowerCase());
      return matchesMember && matchesStatus && matchesSearch;
    })
    .sort((a, b) => {
      const da = new Date(a.updatedAt).getTime();
      const db = new Date(b.updatedAt).getTime();
      return sortOrder === 'newest' ? db - da : da - db;
    });

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">KYC Submissions</h1>
        {canEnroll && (
          <Link href="/sales/kyc/new">
            <Button variant="primary" size="sm">
              <Plus className="h-4 w-4" />New Enrollment
            </Button>
          </Link>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, firm or mobile..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
        />
      </div>

      {/* Team member filter — only visible for managers (SO and above) */}
      {hasTeamView(role) && teamMembers.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor="member-filter" className="sr-only">Team Member</label>
          <select
            id="member-filter"
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            className={cn(
              'flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700',
              'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
              memberFilter ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] font-semibold' : '',
            )}
          >
            <option value="">All Members</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Status filter dropdown + sort control */}
      <div className="flex items-center gap-2">
        <select
          data-testid="kyc-status-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterKey)}
          className={cn(
            'flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700',
            'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
            filter !== 'ALL' ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] font-semibold' : '',
          )}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        {/* Sort toggle */}
        <button
          onClick={() => setSortOrder((s) => s === 'newest' ? 'oldest' : 'newest')}
          className="shrink-0 flex items-center gap-1 text-[11px] font-semibold text-gray-500 border border-gray-200 rounded-full px-2.5 py-1.5 bg-white hover:border-gray-300 transition-colors"
          title={sortOrder === 'newest' ? 'Showing newest first' : 'Showing oldest first'}
        >
          <ArrowUpDown className="h-3 w-3" />
          {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-8 w-8" />}
          title="No KYC submissions"
          description="No entries match your current filter."
        />
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <div className="divide-y divide-gray-50">
              {filtered.map((entry) => {
                const { variant, label } = kycBadge[entry.status];
                const borderClass = rowBorder(entry.status, approvalStatus);
                return (
                  <Link
                    key={entry.id}
                    href={`/sales/kyc/${entry.id}`}
                    className={`flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors ${borderClass}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-900 truncate">{entry.firmName}</p>
                        <Badge variant={variant}>{label}</Badge>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <p className="text-xs text-gray-500">{entry.partnerName} · {entry.mobile}</p>
                        <span
                          data-testid="kyc-entry-outlet-code"
                          className="text-[10px] font-mono font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded"
                        >
                          {entry.outletCode}
                        </span>
                      </div>
                      {entry.rejectionReason && (
                        <p className="text-xs text-red-600 mt-0.5 truncate">Reason: {entry.rejectionReason}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        Updated {relativeDate(entry.updatedAt)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function KYCListPage() {
  return (
    <Suspense fallback={<Spinner size="lg" />}>
      <KYCListContent />
    </Suspense>
  );
}
