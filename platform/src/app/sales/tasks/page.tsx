'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  FileCheck, XCircle, ChevronRight, Clock, Bell, Tag,
  RefreshCw,
  CheckCircle2, ArrowLeft, ListTodo,
  UserCheck, Loader2,
} from 'lucide-react';
import { KYCStatus } from '@/types';
import { fetchTaskConfig, DEFAULT_TASK_CONFIG, type TaskConfig } from '@/lib/task-config';
import {
  fetchOutletVisibilityStatuses,
  VISIBILITY_ELIGIBLE_OUTLET_TYPES,
  type VisibilityStatusMap,
} from '@/lib/visibility-upload';
import { getRole, canEnroll, type SalesRole } from '@/lib/sales-role';
import { schemeApi } from '@/lib/schemes';
import type { EligibleScheme } from '@/lib/scheme-types';
import {
  SchemeEnrollSheet,
  type SchemeEnrolledMap,
  type SchemeEnrolledStatus,
} from './SchemeEnrollSheet';
import { authHeader } from '@/lib/api-client';
import {
  buildKycSubRows, buildVisibilityTaskItems, buildPhotoCaptureTaskItems, type KycSubRow,
} from '@/lib/sales-tasks';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { visibilityApi } from '@/lib/visibility';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletRow {
  id: string; kycId: string; name: string; mobile: string;
  location: string; type: OutletType; kycStatus: KYCStatus;
  kycSubmittedAt?: string;
  outletCode: string;  // matches Outlet.outletCode for visibility lookup
  partnerId: string;   // ChannelPartner.id — required for SALES enrollment
}

interface TaskItem {
  id: string; title: string; subtitle: string;
  href?: string; priority: 'high' | 'medium' | 'low';
  ageDays?: number;
}

interface TaskGroup {
  id:           string;
  label:        string;
  icon:         React.ReactNode;
  items:        TaskItem[];
  accentBg:     string;
  accentBorder: string;
  accentText:   string;
  badgeBg:      string;
  /** When set, tapping the row navigates here instead of expanding */
  href?:        string;
}

// Outlets are loaded from /api/sales/outlets; visibility tasks computed dynamically.

function mapOutlet(o: any): OutletRow {
  return {
    id:             o.id,
    kycId:          o.kycId ?? '',
    outletCode:     o.outletCode ?? '',
    partnerId:      o.partnerId ?? '',
    name:           o.name,
    mobile:         o.mobile ?? '',
    location:       o.location ?? [o.beat, o.district].filter(Boolean).join(', '),
    type:           (o.type as OutletType) ?? 'SSS',
    kycStatus:      o.kycStatus as KYCStatus,
    kycSubmittedAt: o.kycSubmittedAt,
  };
}


/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function ageInDays(dateStr?: string): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

const SCHEME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun '26 – Aug '26" scheme window label (replaces the reward-era deadline shim). */
function formatSchemeWindow(startIso: string, endIso: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${SCHEME_MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  };
  const s = fmt(startIso);
  const e = fmt(endIso);
  if (!s && !e) return '';
  return s === e ? s : `${s} – ${e}`;
}

/* ─── Priority dot ───────────────────────────────────────────────────────────── */

function PriorityDot({ priority }: { priority: TaskItem['priority'] }) {
  return (
    <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[5px] ${
      priority === 'high' ? 'bg-red-400' : priority === 'medium' ? 'bg-amber-400' : 'bg-gray-300'
    }`} />
  );
}

/* ─── Age badge ──────────────────────────────────────────────────────────────── */

function AgeBadge({ ageDays }: { ageDays?: number }) {
  if (!ageDays || ageDays <= 0) return null;
  if (ageDays >= 7) {
    return (
      <span className="shrink-0 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
        <Clock className="h-2.5 w-2.5" />
        {ageDays}d · Overdue
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
      {ageDays}d
    </span>
  );
}

/* ─── Task group row (accordion) ────────────────────────────────────────────── */

function TaskGroupRow({ group }: { group: TaskGroup }) {
  const [open, setOpen] = useState(false);
  const oldestAge = group.items.reduce((max, i) => Math.max(max, i.ageDays ?? 0), 0);

  const headerInner = (
    <>
      <div className={`p-2 rounded-xl ${group.accentBg} shrink-0`}>{group.icon}</div>
      <p className="text-sm font-semibold text-gray-800 flex-1 text-left leading-snug">{group.label}</p>
      {oldestAge > 0 && (
        <span className={`text-[10px] font-semibold shrink-0 ${oldestAge >= 7 ? 'text-red-500' : 'text-gray-400'}`}>
          {oldestAge}d
        </span>
      )}
      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${group.badgeBg} ${group.accentText} shrink-0`}>
        {group.items.length}
      </span>
      <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${!group.href && open ? 'rotate-90' : ''} text-gray-400`} />
    </>
  );

  return (
    <div className="bg-white border-b border-gray-100 last:border-0">
      {group.href ? (
        <Link href={group.href} className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors">
          {headerInner}
        </Link>
      ) : (
        <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors">
          {headerInner}
        </button>
      )}

      {!group.href && open && (
        <div className={`mx-4 mb-4 rounded-xl border ${group.accentBorder} overflow-hidden`}>
          {group.items.map((item, i) => (
            <div key={item.id} className={`flex items-start gap-3 px-4 py-3 bg-white ${i < group.items.length - 1 ? 'border-b border-gray-50' : ''}`}>
              <PriorityDot priority={item.priority} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[13px] font-medium text-gray-800 leading-snug">{item.title}</p>
                  <AgeBadge ageDays={item.ageDays} />
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">{item.subtitle}</p>
              </div>
              {item.href && (
                <Link href={item.href} onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                  <ChevronRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Scheme Enrollment Task Group (real sales-assisted enrollment, D28) ──────── */

function SchemeEnrollmentGroup({
  schemes,
  enrolled,
  onEnrolled,
}: {
  schemes: EligibleScheme[];
  /** schemeId → (targetKey → status) — fresh-enroll read-back for the badge count. */
  enrolled: Record<string, SchemeEnrolledMap>;
  onEnrolled: (schemeId: string, targetKey: string, status: SchemeEnrolledStatus) => void;
}) {
  const [open, setOpen]         = useState(false);
  const [active, setActive]     = useState<EligibleScheme | null>(null);

  return (
    <>
      <div className="bg-white border-b border-gray-100 last:border-0">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors"
        >
          <div className="p-2 rounded-xl bg-emerald-50 shrink-0">
            <Tag className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="text-sm font-semibold text-gray-800 flex-1 text-left leading-snug">Scheme Enrollment</p>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">
            {schemes.length}
          </span>
          <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''} text-gray-400`} />
        </button>

        {open && (
          <div className="mx-4 mb-4 rounded-xl border border-emerald-200 overflow-hidden">
            {schemes.map((scheme, i) => {
              const map = enrolled[scheme.id] ?? {};
              const enrolledCount = Object.values(map).filter((s) => s === 'SUBMITTED').length;
              return (
                <div
                  key={scheme.id}
                  className={`px-4 py-3 bg-white ${i < schemes.length - 1 ? 'border-b border-gray-100' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-gray-800 leading-snug truncate">{scheme.name}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {formatSchemeWindow(scheme.startDate, scheme.endDate)}
                        {enrolledCount > 0 ? ` · ${enrolledCount} enrolled` : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => setActive(scheme)}
                      className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-emerald-600 text-white active:bg-emerald-700 transition-colors"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      Enroll
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {active && (
        <SchemeEnrollSheet
          scheme={active}
          enrolled={enrolled[active.id] ?? {}}
          onEnrolled={(key, status) => onEnrolled(active.id, key, status)}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function TasksPage() {
  const [outlets,         setOutlets]         = useState<OutletRow[]>([]);
  const [kycSubs,         setKycSubs]          = useState<KycSubRow[]>([]);
  const [taskConfig,      setTaskConfig]       = useState<TaskConfig | null>(null);
  const [role,            setRoleState]        = useState<SalesRole>('SO');
  const [schemes,         setSchemes]          = useState<EligibleScheme[]>([]);
  const [schemeEnrolled,  setSchemeEnrolled]   = useState<Record<string, SchemeEnrolledMap>>({});
  const [visibilityItems, setVisibilityItems]  = useState<TaskItem[]>([]);
  const [visibilityMode,  setVisibilityMode]   = useState<'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD'>('PHOTO_APPROVAL');
  const [loading,         setLoading]          = useState(true);

  /* Record a real backend enrollment so the badge count updates without a reload. */
  const handleSchemeEnrolled = (schemeId: string, targetKey: string, status: SchemeEnrolledStatus) => {
    setSchemeEnrolled((prev) => ({
      ...prev,
      [schemeId]: { ...(prev[schemeId] ?? {}), [targetKey]: status },
    }));
  };

  useEffect(() => {
    setRoleState(getRole());

    const headers = authHeader();
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Fetch eligible schemes (real, roster-based §13.4), outlets, and task config in
    // parallel. schemeApi.listSalesEligible() uses the api client (cookie auth) — no token read.
    Promise.all([
      schemeApi.listSalesEligible()
        .then((r) => { const list = r.success ? (r.data.schemes ?? []) : []; setSchemes(list); return list; })
        .catch(() => { setSchemes([]); return []; }),
      fetch('/api/sales/outlets', { headers }).then((r) => r.json()),
      fetchTaskConfig(),
      // Approval/Rejected counts derive from SUBMISSIONS (shared buildKycSubRows)
      // so they match the dashboard + KYC list — incl. no-outlet submissions.
      fetch('/api/kyc', { headers }).then((r) => r.json()).catch(() => null),
    ]).then(([, oBody, config, kycResult]) => {
      const apiOutlets: OutletRow[] = (oBody.data?.outlets ?? []).map(mapOutlet);
      setOutlets(apiOutlets);
      setTaskConfig(config);
      setKycSubs(buildKycSubRows(kycResult));

      const visibleOutlets = apiOutlets.filter((o) => VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type));
      const codes = visibleOutlets.map((o) => o.outletCode);

      // Mode-aware Visibility tasks (VISIBILITY-POSM-DESIGN.md D3/D14). PHOTO_APPROVAL
      // tenants source pending captures from the sales-eligible window (photo capture);
      // AMOUNT_UPLOAD tenants keep the OutletVisibilityRecord (Excel) path. Both build
      // items via the shared sales-tasks derivation so this + the dashboard stay in sync.
      const gs = getGifsySettings();
      const visibilityEnabled = gs.visibilityEnabled === true;
      const captureMode = gs.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
      setVisibilityMode(captureMode);
      if (!visibilityEnabled) { setVisibilityItems([]); return; }
      if (captureMode === 'PHOTO_APPROVAL') {
        return visibilityApi.getSalesEligible()
          .then((r) => setVisibilityItems(buildPhotoCaptureTaskItems(r.success ? r.data : null)))
          .catch(() => setVisibilityItems([]));
      }
      return fetchOutletVisibilityStatuses(codes, currentMonth).then((apiMap) => {
        const merged: VisibilityStatusMap = apiMap;
        setVisibilityItems(buildVisibilityTaskItems(visibleOutlets, merged, visibilityEnabled));
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onStorage = () => {
      setRoleState(getRole());
      // Re-fetch real eligible schemes on storage events (e.g. role switch in another tab).
      schemeApi.listSalesEligible()
        .then((r) => setSchemes(r.success ? (r.data.schemes ?? []) : []))
        .catch(() => {});
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* ── Build task groups ── */
  const taskGroups: TaskGroup[] = useMemo(() => {
    if (!taskConfig) return [];

    const isFieldRole  = canEnroll(role);
    const approvalStatus =
      role === 'SO'  ? KYCStatus.PENDING_SO_APPROVAL  :
      role === 'ASM' ? KYCStatus.PENDING_ASM_APPROVAL :
      null;
    const approverLabel =
      role === 'SO'  ? 'XSR' :
      role === 'ASM' ? 'SO'  :
      null;
    const groups: TaskGroup[] = [];

    if (isFieldRole) {
      // KYC to be done: master-loaded outlets whose KYC was never started
      // (NOT_STARTED). Mirrors the dashboard "KYC to be done" group — without it the
      // Tasks "View all" page silently dropped these, so the dashboard count and the
      // Tasks badge disagreed (dashboard showed the group, Tasks omitted it).
      const notStartedOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.NOT_STARTED);
      if (notStartedOutlets.length > 0) {
        groups.push({
          id: 'kyc_to_do', label: 'KYC to be done',
          icon: <FileCheck className="h-4 w-4 text-emerald-600" />,
          items: notStartedOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · New enrollment — KYC not started`,
            // No submission yet → open the start wizard pre-selected on this outlet
            // (never a dead /sales/kyc/${id} → "KYC not found").
            href: `/sales/kyc/new?outletId=${o.id}`,
            priority: 'high' as const,
          })),
          accentBg: 'bg-emerald-50', accentBorder: 'border-emerald-200',
          accentText: 'text-emerald-700', badgeBg: 'bg-emerald-100',
          href: '/sales/kyc?status=NOT_STARTED',
        });
      }

      const reKycOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.RE_KYC_REQUIRED);
      if (reKycOutlets.length > 0) {
        groups.push({
          id: 're_kyc', label: 'Re-KYC Required',
          icon: <RefreshCw className="h-4 w-4 text-purple-600" />,
          items: reKycOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · Re-KYC required`,
            // Re-KYC outlets normally carry a prior submission (kycId); when absent,
            // open the start wizard pre-selected on this outlet rather than the bare
            // list, matching the rest of the app.
            href: o.kycId ? `/sales/kyc/${o.kycId}` : `/sales/kyc/new?outletId=${o.id}`,
            priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-purple-50', accentBorder: 'border-purple-200',
          accentText: 'text-purple-700', badgeBg: 'bg-purple-100',
          href: '/sales/kyc?status=RE_KYC_REQUIRED',
        });
      }

      const pendingOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.PENDING);
      if (pendingOutlets.length > 0) {
        groups.push({
          id: 'pending_kyc', label: 'Pending KYC',
          icon: <Clock className="h-4 w-4 text-amber-600" />,
          items: pendingOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · KYC not yet submitted`,
            // These outlets have NO submission yet (subtitle says so) — the old
            // `/sales/kyc/${o.id}` linked to a non-existent submission id → "KYC not
            // found". Open the start wizard on this outlet; deep-link only if a real
            // kycId exists.
            href: o.kycId ? `/sales/kyc/${o.kycId}` : `/sales/kyc/new?outletId=${o.id}`,
            priority: 'medium' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-amber-50', accentBorder: 'border-amber-200',
          accentText: 'text-amber-700', badgeBg: 'bg-amber-100',
          href: '/sales/kyc?status=PENDING',
        });
      }
    }

    if (approvalStatus) {
      // From SUBMISSIONS (shared buildKycSubRows) so the count matches the dashboard
      // + the KYC list "Approval Pending" — including no-outlet submissions.
      const approvalSubs = kycSubs.filter((s) => s.status === approvalStatus);
      if (approvalSubs.length > 0) {
        groups.push({
          id: 'approval_required', label: 'Approval Required',
          icon: <FileCheck className="h-4 w-4 text-blue-600" />,
          items: approvalSubs.map((s) => ({
            id: s.id, title: s.title,
            subtitle: `KYC submitted by ${approverLabel} — awaiting your approval`,
            href: `/sales/kyc/${s.id}`, priority: 'high' as const,
            ageDays: ageInDays(s.updatedAt),
          })),
          accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
          accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
          href: '/sales/kyc?status=APPROVAL_REQUIRED',
        });
      }
    }

    if (isFieldRole) {
      // Rejected family is ASSIGNMENT-scoped work: a rejected outlet REASSIGNED to this rep
      // whose original KYC was filed by ANOTHER rep never appears in the submitter-scoped
      // kycSubs (/api/kyc). Derive from the assignment-scoped `outlets` (/api/sales/outlets)
      // + merge no-outlet submitter-scoped submissions, deduped by outletCode (outlet wins).
      // Mirrors the dashboard + KYC list.
      const REJECTED_FAMILY = [KYCStatus.REJECTED, KYCStatus.RE_UPLOAD_REQUIRED, KYCStatus.RESUBMISSION_REQUIRED];
      const rejectedOutlets = outlets.filter((o) => REJECTED_FAMILY.includes(o.kycStatus));
      const rejectedOutletCodes = new Set(rejectedOutlets.map((o) => o.outletCode).filter(Boolean));
      const rejectedNoOutletSubs = kycSubs.filter((s) =>
        REJECTED_FAMILY.includes(s.status) && (!s.outletCode || !rejectedOutletCodes.has(s.outletCode)),
      );
      const rejectedItems = [
        ...rejectedOutlets.map((o) => ({
          id: o.kycId || o.id, title: o.name,
          subtitle: 'Resubmission required',
          href: o.kycId ? `/sales/kyc/${o.kycId}` : `/sales/kyc/new?outletId=${o.id}`,
          priority: 'high' as const,
          ageDays: ageInDays(o.kycSubmittedAt),
        })),
        ...rejectedNoOutletSubs.map((s) => ({
          id: s.id, title: s.title,
          subtitle: 'Resubmission required',
          href: `/sales/kyc/${s.id}`, priority: 'high' as const,
          ageDays: ageInDays(s.updatedAt),
        })),
      ];
      if (rejectedItems.length > 0) {
        groups.push({
          id: 'rejected_kyc', label: 'Rejected KYC',
          icon: <XCircle className="h-4 w-4 text-red-600" />,
          items: rejectedItems,
          accentBg: 'bg-red-50', accentBorder: 'border-red-200',
          accentText: 'text-red-700', badgeBg: 'bg-red-100',
          href: '/sales/kyc?status=REJECTED',
        });
      }

    }

    // Visibility (mode-aware, D8/D14). PHOTO_APPROVAL is driven by the backend's
    // `canCapture` (buildPhotoCaptureTaskItems already filters on it), so ANY capturer —
    // including RSM/ZNM/NSM managers whose level ∈ allowedSalesLevels or who own the
    // outlet's downline — gets the nudge (NOT gated on isFieldRole). AMOUNT_UPLOAD stays
    // field-role only (its Excel back-office path). visibilityItems is empty for a
    // non-capturer, so the group simply doesn't appear then.
    const showVisibilityGroup = visibilityMode === 'PHOTO_APPROVAL' || isFieldRole;
    if (showVisibilityGroup && visibilityItems.length > 0) {
      groups.push({
        id: 'visibility', label: 'Visibility',
        icon: <FileCheck className="h-4 w-4 text-blue-600" />,
        items: visibilityItems,
        accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
        accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
      });
    }

    // HO Notifications / Reminders (admin-configurable, date-filtered)
    const now2 = new Date();
    const activeHoItems = taskConfig.customTaskItems.filter((item) => {
      if (item.startsAt && new Date(item.startsAt) > now2) return false;
      if (item.endsAt   && new Date(item.endsAt)   < now2) return false;
      return true;
    });
    if (activeHoItems.length > 0) {
      groups.push({
        id: 'admin_tasks', label: taskConfig.customTaskLabel,
        icon: <Bell className="h-4 w-4 text-indigo-600" />,
        items: activeHoItems,
        accentBg: 'bg-indigo-50', accentBorder: 'border-indigo-200',
        accentText: 'text-indigo-700', badgeBg: 'bg-indigo-100',
      });
    }

    return groups;
  }, [outlets, kycSubs, taskConfig, role, visibilityItems, visibilityMode]);

  const isFieldRole  = canEnroll(role);
  const schemeCount  = schemes.length;
  const totalTasks   = taskGroups.reduce((s, g) => s + g.items.length, 0) + (isFieldRole ? schemeCount : 0);

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <Link href="/sales/dashboard" className="p-2 -ml-2 rounded-xl hover:bg-gray-100 transition-colors text-gray-500">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <ListTodo className="h-5 w-5 text-[var(--brand-primary)]" /> Tasks
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">Your pending action items</p>
        </div>
        {totalTasks > 0 && (
          <span className="text-[11px] font-bold bg-[var(--brand-primary)] text-white px-2 py-1 rounded-full">
            {totalTasks}
          </span>
        )}
      </div>

      {/* Category list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
        </div>
      ) : taskGroups.length === 0 && (!isFieldRole || schemeCount === 0) ? (
        <div className="flex flex-col items-center gap-3 py-16 bg-white rounded-2xl border border-gray-100">
          <CheckCircle2 className="h-10 w-10 text-emerald-400" />
          <p className="text-sm font-semibold text-gray-700">All clear!</p>
          <p className="text-xs text-gray-400">No pending tasks right now</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
          {taskGroups.map((group) => (
            <TaskGroupRow key={group.id} group={group} />
          ))}
          {/* Dynamic scheme enrollment — field roles only */}
          {isFieldRole && schemeCount > 0 && (
            <SchemeEnrollmentGroup
              schemes={schemes}
              enrolled={schemeEnrolled}
              onEnrolled={handleSchemeEnrolled}
            />
          )}
        </div>
      )}
    </div>
  );
}
