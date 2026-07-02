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
import { type SalesRole, getRole, hasTeamView, canEnroll } from '@/lib/sales-role';
import { api } from '@/lib/api-client';

interface KYCEntry {
  id: string;
  partnerName: string;
  /** OWNER/contact-person name captured in the KYC form (Gifsy validates against PAN/Aadhaar) */
  ownerName: string;
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
  /** True for an assigned outlet that has NOT been enrolled yet (no submission) —
   *  synthesised from /api/sales/outlets so the rep's to-do outlets appear here. */
  isNotStarted?: boolean;
  /** True for an assigned outlet marked NOT_INTERESTED by a sales rep — shown
   *  distinctly and NON-actionable (only an admin can re-open it for enrollment). */
  isNotInterested?: boolean;
  programName?: string;
  programCategory?: string;
  outletType?: string;
}

interface TeamMember { id: string; name: string; }

const APPROVAL_REQUIRED_KEY = 'APPROVAL_REQUIRED' as const;
const UNDER_REVIEW_KEY      = 'UNDER_REVIEW'      as const;
const PENDING_KYC_KEY       = 'PENDING_KYC'       as const;
type FilterKey = 'ALL' | typeof APPROVAL_REQUIRED_KEY | typeof UNDER_REVIEW_KEY | typeof PENDING_KYC_KEY | KYCStatus;
type SortOrder = 'newest' | 'oldest';

/** "Pending KYC" = outlets the rep still needs to act on: never-enrolled
 *  (NOT_STARTED) + saved-but-unsubmitted drafts (PENDING). */
const PENDING_KYC_STATUSES = new Set<KYCStatus>([
  KYCStatus.NOT_STARTED,
  KYCStatus.PENDING,
  KYCStatus.DRAFT,
]);

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

/** "Rejected" family — every reviewer-led feedback state the rep must act on lives
 *  under the single "Rejected" filter/section (owner decision): a full rejection, a
 *  specific-document re-upload request (RE_UPLOAD_REQUIRED, the value the backend
 *  actually writes), and the legacy RESUBMISSION_REQUIRED alias. */
const REJECTED_STATUSES = new Set<KYCStatus>([
  KYCStatus.REJECTED,
  KYCStatus.RE_UPLOAD_REQUIRED,
  KYCStatus.RESUBMISSION_REQUIRED,
]);

const STATUS_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'ALL',                  label: 'All'               },
  { key: PENDING_KYC_KEY,        label: 'Pending KYC'       },
  { key: APPROVAL_REQUIRED_KEY,  label: 'Approval Pending'  },
  { key: UNDER_REVIEW_KEY,       label: 'Under Review'      },
  { key: KYCStatus.APPROVED,     label: 'Approved'          },
  { key: KYCStatus.REJECTED,     label: 'Rejected'          },
  { key: KYCStatus.RE_KYC_REQUIRED,       label: 'Re-KYC Required' },
  { key: KYCStatus.NOT_INTERESTED,        label: 'Not Interested'  },
];

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]:              { variant: 'success', label: 'Approved'         },
  [KYCStatus.PENDING]:               { variant: 'warning', label: 'Draft'            },
  [KYCStatus.DRAFT]:                 { variant: 'warning', label: 'Pending'          },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'        },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'In Review'        },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'      },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'     },
  [KYCStatus.PENDING_RSM_APPROVAL]:  { variant: 'warning', label: 'Awaiting RSM'     },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Awaiting Gifsy'   },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'         },
  [KYCStatus.RE_UPLOAD_REQUIRED]:    { variant: 'danger',  label: 'Rejected'         },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Rejected'         },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC Required'  },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'       },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested'    },
};


/* ─── Relative date ──────────────────────────────────────────────────────────── */
function relativeDate(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Yesterday';
  if (diff < 30)   return `${diff} days ago`;
  const months = Math.floor(diff / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
}

/* ─── Collapse multiple submissions for one outlet to the latest (current) one ─── */
/** A rejected attempt + its resubmission are two KycSubmission rows for the SAME
 *  outlet. The list must show each outlet ONCE with its current status, so keep only
 *  the most-recently-updated submission per outletCode. Entries with no outletCode
 *  (a submission not linked to an outlet) are kept individually. */
function dedupeByOutlet(entries: KYCEntry[]): KYCEntry[] {
  const ts = (e: KYCEntry) => new Date(e.updatedAt || e.submittedAt || 0).getTime();
  const latestByOutlet = new Map<string, KYCEntry>();
  const noOutlet: KYCEntry[] = [];
  for (const e of entries) {
    if (!e.outletCode) { noOutlet.push(e); continue; }
    const existing = latestByOutlet.get(e.outletCode);
    if (!existing || ts(e) >= ts(existing)) latestByOutlet.set(e.outletCode, e);
  }
  return [...latestByOutlet.values(), ...noOutlet];
}

/* ─── Row border by status ───────────────────────────────────────────────────── */
function rowBorder(status: KYCStatus, approvalStatus: KYCStatus | null): string {
  if (approvalStatus && status === approvalStatus) return 'border-l-4 border-l-blue-400';
  if (REJECTED_STATUSES.has(status)) return 'border-l-4 border-l-red-400';
  if (status === KYCStatus.RE_KYC_REQUIRED) return 'border-l-4 border-l-purple-400';
  return '';
}

function KYCListContent() {
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get('status');
  const approvalStatus = getApprovalStatus();
  const role = getRole();
  const canEnrollRole = canEnroll(role);

  const statusParam: FilterKey | null = rawStatus
    ? rawStatus === APPROVAL_REQUIRED_KEY
      ? APPROVAL_REQUIRED_KEY
      : rawStatus === UNDER_REVIEW_KEY || UNDER_REVIEW_STATUSES.has(rawStatus as KYCStatus)
        ? UNDER_REVIEW_KEY
        : rawStatus === PENDING_KYC_KEY || PENDING_KYC_STATUSES.has(rawStatus as KYCStatus)
          ? PENDING_KYC_KEY
          : REJECTED_STATUSES.has(rawStatus as KYCStatus)
            ? KYCStatus.REJECTED
            : (rawStatus as FilterKey)
    : null;

  const [entries,      setEntries]      = useState<KYCEntry[]>([]);
  const [filter,       setFilter]       = useState<FilterKey>(statusParam ?? 'ALL');
  const [search,       setSearch]       = useState('');
  const [loading,      setLoading]      = useState(true);
  const [sortOrder,    setSortOrder]    = useState<SortOrder>('newest');
  const [memberFilter, setMemberFilter] = useState('');
  const [teamMembers,  setTeamMembers]  = useState<TeamMember[]>([]);
  const [typeFilter,   setTypeFilter]   = useState('');
  const [programFilter, setProgramFilter] = useState('');

  useEffect(() => {
    if (statusParam) setFilter(statusParam);
  }, [statusParam]);

  useEffect(() => {
    interface ApiSubmission {
      id: string; status: string; createdAt: string; updatedAt: string; userId: string;
      reviewerNotes?: string | null;
      user: { id: string; name: string; phone: string };
      partner?: {
        id: string;
        businessName: string;
        ownerName?: string;
        phone?: string;
        outlets?: {
          name: string;
          outletCode: string;
          phone?: string;
          programName?: string;
          programCategory?: string;
          outletType?: { code: string } | null;
        }[];
      } | null;
    }

    const kycFetch: Promise<KYCEntry[]> = fetch('/api/kyc')
      .then((r) => r.json())
      .then((result) => {
        if (!result.success) return [];
        return (result.data.submissions as ApiSubmission[]).map((s): KYCEntry => ({
          id:              s.id,
          // Store identity = the OUTLET (name/code/phone), NOT the rep. partnerName is
          // kept only as a secondary field; the title/subtitle/chip render the outlet.
          partnerName:     s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? s.user.name,
          // OWNER/contact-person name (NOT the rep) — secondary line on the row.
          ownerName:       s.partner?.ownerName ?? '',
          firmName:        s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? s.user.name,
          outletCode:      s.partner?.outlets?.[0]?.outletCode ?? '',
          mobile:          s.partner?.outlets?.[0]?.phone ?? s.partner?.phone ?? '',
          status:          s.status as KYCStatus,
          submittedAt:     s.createdAt,
          updatedAt:       s.updatedAt,
          rejectionReason: s.reviewerNotes ?? undefined,
          submittedById:   s.userId,
          programName:     s.partner?.outlets?.[0]?.programName ?? '',
          programCategory: s.partner?.outlets?.[0]?.programCategory ?? '',
          outletType:      s.partner?.outlets?.[0]?.outletType?.code ?? '',
        }));
      })
      .catch(() => [] as KYCEntry[]);

    // The rep's assigned outlets that have NOT been enrolled yet (NOT_STARTED) have
    // no submission, so they never appear in /api/kyc. Pull them from the roster and
    // surface them here. Fetched for ALL sales roles (rep + downline) so that:
    //  - NOT_STARTED → actionable "Pending KYC" entries that link to enrollment, but
    //    ONLY for the roles who enroll (canEnroll — XSR / SO / ASM);
    //  - NOT_INTERESTED → shown DISTINCTLY and NON-actionable for ALL roles (only an
    //    admin can re-open such an outlet for enrollment).
    const canEnrollNow = canEnroll(role);
    const outletsFetch: Promise<KYCEntry[]> = fetch('/api/sales/outlets')
      .then((r) => r.json())
      .then((body): KYCEntry[] => {
        if (!body.success) return [];
        const outlets = (body.data.outlets ?? []) as any[];

        const notStarted: KYCEntry[] = canEnrollNow
          ? outlets
              .filter((o) => o.kycStatus === 'NOT_STARTED')
              .map((o): KYCEntry => ({
                id:          o.id,
                partnerName: o.name,
                ownerName:   '',
                firmName:    o.name,
                outletCode:  o.outletCode ?? '',
                mobile:      o.mobile ?? '',
                status:      KYCStatus.NOT_STARTED,
                submittedAt: '',
                updatedAt:   '',
                isNotStarted: true,
                programName:     o.programName ?? '',
                programCategory: o.programCategory ?? '',
                outletType:      o.type ?? '',
              }))
          : [];

        const notInterested: KYCEntry[] = outlets
          .filter((o) => o.kycStatus === 'NOT_INTERESTED')
          .map((o): KYCEntry => ({
            id:          o.id,
            partnerName: o.name,
            ownerName:   '',
            firmName:    o.name,
            outletCode:  o.outletCode ?? '',
            mobile:      o.mobile ?? '',
            status:      KYCStatus.NOT_INTERESTED,
            submittedAt: '',
            updatedAt:   '',
            isNotInterested: true,
            programName:     o.programName ?? '',
            programCategory: o.programCategory ?? '',
            outletType:      o.type ?? '',
          }));

        return [...notStarted, ...notInterested];
      })
      .catch(() => [] as KYCEntry[]);

    const teamFetch = hasTeamView(role)
      ? fetch('/api/sales/team')
          .then((r) => r.json())
          .then((body) => {
            if (body.success) {
              setTeamMembers((body.data.members ?? []).map((m: any) => ({ id: m.id, name: m.name })));
            }
          })
          .catch(() => {})
      : Promise.resolve();

    Promise.all([kycFetch, outletsFetch, teamFetch])
      .then(([subs, synthesised]) => {
        // Collapse repeat submissions for the same outlet to its latest (current) status.
        // Synthesised NOT_STARTED / NOT_INTERESTED outlets have no submission → disjoint,
        // appended as-is (NOT run through dedupeByOutlet, which is for submissions).
        setEntries([...(synthesised ?? []), ...dedupeByOutlet(subs ?? [])]);
      })
      .finally(() => setLoading(false));
  }, [role]);

  const typeOptions    = Array.from(new Set(entries.map((e) => e.outletType).filter(Boolean))) as string[];
  const programOptions = Array.from(new Set(entries.map((e) => e.programName).filter(Boolean))) as string[];

  const filtered = entries
    .filter((e) => {
      const matchesMember = !memberFilter || e.submittedById === memberFilter;
      const matchesType = !typeFilter || e.outletType === typeFilter;
      const matchesProgram = !programFilter || e.programName === programFilter;
      const matchesStatus =
        filter === 'ALL'                 ? true :
        filter === PENDING_KYC_KEY       ? PENDING_KYC_STATUSES.has(e.status) :
        filter === APPROVAL_REQUIRED_KEY ? (approvalStatus ? e.status === approvalStatus : false) :
        filter === UNDER_REVIEW_KEY      ? (UNDER_REVIEW_STATUSES.has(e.status) && e.status !== approvalStatus) :
        filter === KYCStatus.REJECTED    ? REJECTED_STATUSES.has(e.status) :
        e.status === filter;
      const matchesSearch =
        e.partnerName.toLowerCase().includes(search.toLowerCase()) ||
        e.firmName.toLowerCase().includes(search.toLowerCase()) ||
        e.mobile.includes(search) ||
        e.outletCode.toLowerCase().includes(search.toLowerCase());
      return matchesMember && matchesStatus && matchesSearch && matchesType && matchesProgram;
    })
    .sort((a, b) => {
      // Un-enrolled outlets are the most actionable → always pinned to the top.
      if (!!a.isNotStarted !== !!b.isNotStarted) return a.isNotStarted ? -1 : 1;
      const da = new Date(a.updatedAt).getTime() || 0;
      const db = new Date(b.updatedAt).getTime() || 0;
      return sortOrder === 'newest' ? db - da : da - db;
    });

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">KYC Submissions</h1>
        {canEnrollRole && (
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

      {/* Outlet Type + Program filters */}
      {(typeOptions.length > 0 || programOptions.length > 0) && (
        <div className="flex items-center gap-2">
          {typeOptions.length > 0 && (
            <select
              data-testid="kyc-type-filter"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className={cn(
                'flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700',
                'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
                typeFilter ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] font-semibold' : '',
              )}
            >
              <option value="">All Types</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          {programOptions.length > 0 && (
            <select
              data-testid="kyc-program-filter"
              value={programFilter}
              onChange={(e) => setProgramFilter(e.target.value)}
              className={cn(
                'flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700',
                'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
                programFilter ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] font-semibold' : '',
              )}
            >
              <option value="">All Programs</option>
              {programOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      )}

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
                // Un-enrolled outlets have no submission to open → start enrollment instead.
                const href = entry.isNotStarted ? '/sales/kyc/new' : `/sales/kyc/${entry.id}`;

                const rowBody = (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-900 truncate">{entry.firmName}</p>
                        <Badge variant={variant}>{label}</Badge>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <p className="text-xs text-gray-500">
                          {[entry.ownerName, entry.mobile].filter(Boolean).join(' · ')}
                        </p>
                        {entry.outletCode && (
                          <span
                            data-testid="kyc-entry-outlet-code"
                            className="text-[10px] font-mono font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded"
                          >
                            {entry.outletCode}
                          </span>
                        )}
                        {entry.programName && (
                          <span className="text-[10px] font-semibold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 px-1.5 py-0.5 rounded">
                            {entry.programName}{entry.programCategory ? ` · ${entry.programCategory}` : ''}
                          </span>
                        )}
                      </div>
                      {entry.rejectionReason && (
                        <p className="text-xs text-red-600 mt-0.5 truncate">Reason: {entry.rejectionReason}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        {entry.isNotInterested
                          ? 'Marked not interested — admin can re-open for enrollment'
                          : entry.isNotStarted
                            ? 'Tap to start enrollment'
                            : `Updated ${relativeDate(entry.updatedAt)}`}
                      </p>
                    </div>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 shrink-0',
                        entry.isNotInterested ? 'text-gray-200' : 'text-gray-300',
                      )}
                    />
                  </>
                );

                // NOT_INTERESTED outlets are NON-actionable for sales — only an admin can
                // re-open them — so render a plain (non-navigating) row, not a link.
                if (entry.isNotInterested) {
                  return (
                    <div
                      key={entry.id}
                      data-testid="kyc-not-interested-row"
                      className={`flex items-center gap-3 px-4 py-3.5 ${borderClass}`}
                    >
                      {rowBody}
                    </div>
                  );
                }

                return (
                  <Link
                    key={entry.id}
                    href={href}
                    className={`flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors ${borderClass}`}
                  >
                    {rowBody}
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
