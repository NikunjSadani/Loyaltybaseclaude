'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  FileCheck, XCircle, Plus, Search,
  ChevronRight, Clock, MapPin, TrendingUp, Target,
  CheckCircle2, Bell, ListTodo, RefreshCw, Layers, Tag,
} from 'lucide-react';
import { SalesAchievementChart, type SalesChartView, type SalesOutletFilter } from '@/components/charts/sales-achievement-chart';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { KYCStatus } from '@/types';
import {
  type GeoTargetConfig,
  OUTLET_ACHIEVEMENTS, resolveConfig,
  pct, pctBarColor,
  DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE,
} from '@/lib/targets';
import { type SalesRole, getRole } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { fetchTaskConfig, type TaskConfig, type CustomTaskItem } from '@/lib/task-config';
import { fetchBanners, getActiveSalesBanners, getBgStyle, type Banner } from '@/lib/banner';
import { getAllPendingSchemes, type Scheme } from '@/lib/schemes';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletRow {
  id: string; kycId: string; name: string; mobile: string;
  location: string; type: OutletType; kycStatus: KYCStatus;
  lastVisit?: string; kycSubmittedAt?: string;
}

interface TaskItem {
  id: string; title: string; subtitle: string;
  href?: string; priority: 'high' | 'medium' | 'low';
  ageDays?: number;
}

interface TaskGroup {
  id:       string;
  label:    string;
  icon:     React.ReactNode;
  items:    TaskItem[];
  accentBg: string;
  accentBorder: string;
  accentText: string;
  badgeBg:  string;
  /** Where tapping this row navigates to */
  href:     string;
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const MOCK_OUTLETS: OutletRow[] = [
  { id: 'o1', kycId: 'k1', name: 'Kumar General Store', mobile: '9876543210', location: 'Andheri, Mumbai',  type: 'SSS',     kycStatus: KYCStatus.APPROVED,              lastVisit: '2026-05-14' },
  { id: 'o2', kycId: 'k2', name: 'Sharma Kirana',       mobile: '9765432109', location: 'Borivali, Mumbai', type: 'SSS',     kycStatus: KYCStatus.PENDING,               lastVisit: '2026-05-10', kycSubmittedAt: '2026-05-01' },
  { id: 'o3', kycId: 'k3', name: 'Patel Grocery',       mobile: '9654321098', location: 'Thane West',       type: 'SSS',     kycStatus: KYCStatus.REJECTED,              lastVisit: '2026-05-08', kycSubmittedAt: '2026-04-20' },
  { id: 'o4', kycId: 'k4', name: 'Singh Supermart',     mobile: '9543210987', location: 'Malad East',       type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED,              lastVisit: '2026-05-12' },
  { id: 'o5', kycId: 'k5', name: 'Mehta Provisions',    mobile: '9432109876', location: 'Kandivali',        type: 'SUB_STOCKIST', kycStatus: KYCStatus.PENDING_GIFSY,                                   },
  { id: 'o6', kycId: 'k6', name: 'Ravi Traders',        mobile: '9321098765', location: 'Bandra, Mumbai',   type: 'SSS',     kycStatus: KYCStatus.RESUBMISSION_REQUIRED, lastVisit: '2026-04-30', kycSubmittedAt: '2026-04-28' },
  { id: 'o7', kycId: 'k7', name: 'Suresh Wholesale',    mobile: '9210987654', location: 'Kurla, Mumbai',    type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED,              lastVisit: '2026-05-01' },
  { id: 'o8', kycId: 'k8', name: 'Desai Mart',          mobile: '9123456780', location: 'Goregaon, Mumbai', type: 'SSS',     kycStatus: KYCStatus.PENDING,                                         kycSubmittedAt: '2026-05-05' },
  { id: 'o9', kycId: 'k9', name: 'Verma Stores',        mobile: '9001234567', location: 'Andheri, Mumbai',  type: 'SSS',     kycStatus: KYCStatus.PENDING_SO_APPROVAL,                             kycSubmittedAt: '2026-05-15' },
];

// Outlets that need Re-KYC (e.g. KYC expired / flagged for re-verification)
const REKYC_OUTLETS = [
  { id: 'o7', name: 'Suresh Wholesale',  location: 'Kurla, Mumbai',  reason: 'KYC expired — renewal required', submittedAt: '2026-03-10' },
  { id: 'o4', name: 'Singh Supermart',   location: 'Malad East',     reason: 'GST number updated — re-verify',  submittedAt: '2026-03-15' },
];

// Visibility tasks
const VISIBILITY_TASKS: TaskItem[] = [
  { id: 'v1', title: 'Kumar General Store', subtitle: 'Display submission overdue — 3 days',         href: '/sales/visibility', priority: 'high',   ageDays: 3 },
  { id: 'v2', title: 'Mehta Provisions',    subtitle: 'New display cycle started — submit by 31 May', href: '/sales/visibility', priority: 'medium', ageDays: 1 },
];

/* ─── Age helper ─────────────────────────────────────────────────────────────── */

function ageInDays(dateStr?: string): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

/* ─── Target achievement card ────────────────────────────────────────────────── */

const OUTLET_FILTERS: { value: OutletType | 'ALL'; label: string }[] = [
  { value: 'ALL',          label: 'All'          },
  { value: 'SSS',     label: 'SSS'     },
  { value: 'WHOLESALER',   label: 'Wholesaler'   },
  { value: 'SUB_STOCKIST', label: 'Sub-Stockist' },
];

function TargetSummaryCard({ outlets, config }: { outlets: OutletRow[]; config: GeoTargetConfig }) {
  const [typeFilter, setTypeFilter] = useState<OutletType | 'ALL'>('ALL');
  const approvedOutlets = useMemo(() => outlets.filter((o) => o.kycStatus === KYCStatus.APPROVED), [outlets]);
  const visibleOutlets  = useMemo(
    () => typeFilter === 'ALL' ? approvedOutlets : approvedOutlets.filter((o) => o.type === typeFilter),
    [approvedOutlets, typeFilter],
  );

  /* ── Dynamic period (1D) ── */
  const now          = new Date();
  const periodLabel  = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const daysInMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft     = daysInMonth - now.getDate();
  const timePct      = Math.round((now.getDate() / daysInMonth) * 100);

  /* ── Pace context (1A) ── */
  const avgPcts = useMemo(() => config.params.map((param) => {
    const perOutlet = visibleOutlets.map((o) => {
      const ach = OUTLET_ACHIEVEMENTS[o.id];
      return pct(ach?.achievements[param.id] ?? 0, param.target);
    });
    return perOutlet.length > 0 ? Math.round(perOutlet.reduce((s, v) => s + v, 0) / perOutlet.length) : 0;
  }), [config.params, visibleOutlets]);

  const overallAvgPct = avgPcts.length > 0
    ? Math.round(avgPcts.reduce((a, b) => a + b, 0) / avgPcts.length)
    : 0;

  const paceGap       = timePct - overallAvgPct;
  const paceStatus    = classifyPaceGap(paceGap, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  const paceBg        = paceStatus === 'green' ? 'bg-emerald-50' : paceStatus === 'amber' ? 'bg-amber-50' : 'bg-red-50';
  const paceTextColor = paceStatus === 'green' ? 'text-emerald-700' : paceStatus === 'amber' ? 'text-amber-700' : 'text-red-600';
  const paceText      = paceStatus === 'green' ? 'On pace' : `${paceGap}% behind pace`;

  return (
    <Link href="/sales/outlets" className="block">
      <Card className="border-[var(--brand-primary)]/20 cursor-pointer hover:border-[var(--brand-primary)]/40 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-[var(--brand-primary)]" /> Target Achievement
            </CardTitle>
            {/* 1D: dynamic period + days left */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400 font-medium">{periodLabel}</span>
              {daysLeft > 0 && (
                <span className={`text-[11px] font-semibold ${daysLeft <= 7 ? 'text-red-500' : daysLeft <= 14 ? 'text-amber-600' : 'text-gray-400'}`}>
                  · {daysLeft}d left
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {OUTLET_FILTERS.map((f) => (
              <button key={f.value}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTypeFilter(f.value); }}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
                  typeFilter === f.value ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}>
                {f.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {config.params.map((param, idx) => {
            const avgPct = avgPcts[idx] ?? 0;
            const bar    = pctBarColor(avgPct);
            return (
              <div key={param.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-gray-700 flex-1 truncate">{param.label}</p>
                  <span className={`text-[11px] font-bold shrink-0 ${avgPct >= 100 ? 'text-emerald-600' : avgPct >= 80 ? 'text-amber-600' : avgPct >= 60 ? 'text-orange-500' : 'text-red-500'}`}>
                    avg {avgPct}%
                  </span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${bar}`} style={{ width: `${Math.min(avgPct, 100)}%` }} />
                </div>
              </div>
            );
          })}

          {/* Overall pace context */}
          <div className={`flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1.5 rounded-lg mt-1 ${paceBg} ${paceTextColor}`}>
            <TrendingUp className="h-3 w-3 shrink-0" />
            {paceText} · {timePct}% of {periodLabel} elapsed
            {daysLeft > 0 && ` · ${daysLeft} days left`}
          </div>

          <div className="flex items-center justify-center gap-1 text-xs font-semibold text-[var(--brand-primary)] pt-1">
            View full outlet KPIs <ChevronRight className="h-3.5 w-3.5" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}


/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesDashboard() {
  const [outlets,      setOutlets]      = useState<OutletRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [chartView,    setChartView]    = useState<SalesChartView>('monthly');
  const [outletFilter, setOutletFilter] = useState<SalesOutletFilter>('ALL');
  const [targetConfig,  setTargetConfig]  = useState<GeoTargetConfig | null>(null);
  const [role,          setRoleState]     = useState<SalesRole>('SO');
  const [taskConfig,    setTaskConfig]    = useState<TaskConfig | null>(null);
  const [salesBanners,  setSalesBanners]  = useState<Banner[]>([]);
  const [pendingSchemes, setPendingSchemes] = useState<Scheme[]>([]);

  useEffect(() => {
    setRoleState(getRole());

    // Outlets are mock data — set synchronously, no delay needed
    setOutlets(MOCK_OUTLETS);
    const cp = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    setTargetConfig(resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, cp));

    // Schemes are localStorage — also synchronous
    setPendingSchemes(getAllPendingSchemes());

    // Only real async ops: task config + banners (run in parallel)
    Promise.all([
      fetchTaskConfig(),
      fetchBanners(),
    ]).then(([config, { banners }]) => {
      setTaskConfig(config);
      setSalesBanners(getActiveSalesBanners(banners));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const onStorage = () => {
      setRoleState(getRole());
      setPendingSchemes(getAllPendingSchemes());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* ── Close search dropdown on outside click ── */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /* ── Filtered outlets for search dropdown ── */
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return outlets.filter(o =>
      o.name.toLowerCase().includes(q) || o.mobile.includes(q)
    ).slice(0, 6);
  }, [search, outlets]);

  /* ── Derive task groups from data ── */
  const taskGroups: TaskGroup[] = useMemo(() => {
    if (!taskConfig) return [];

    const groups: TaskGroup[] = [];

    // Role gates
    const isFieldRole = role === 'XSR' || role === 'SO';
    const approvalStatus =
      role === 'SO'  ? KYCStatus.PENDING_SO_APPROVAL  :
      role === 'ASM' ? KYCStatus.PENDING_ASM_APPROVAL :
      null;
    const approverLabel = role === 'SO' ? 'XSR' : role === 'ASM' ? 'SO' : null;

    // ── Field-only tasks (XSR & SO) ───────────────────────────────────────────

    if (isFieldRole) {
      // Re-KYC
      if (REKYC_OUTLETS.length > 0) {
        groups.push({
          id: 're_kyc', label: 'Re-KYC Required',
          icon: <RefreshCw className="h-4 w-4 text-purple-600" />,
          items: REKYC_OUTLETS.map((o) => ({
            id: o.id, title: o.name, subtitle: o.reason,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.submittedAt),
          })),
          accentBg: 'bg-purple-50', accentBorder: 'border-purple-200',
          accentText: 'text-purple-700', badgeBg: 'bg-purple-100',
          href: '/sales/kyc?status=RE_KYC_REQUIRED',
        });
      }

      // Pending KYC
      const pendingOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.PENDING);
      if (pendingOutlets.length > 0) {
        groups.push({
          id: 'pending_kyc', label: 'Pending KYC',
          icon: <Clock className="h-4 w-4 text-amber-600" />,
          items: pendingOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · KYC not yet submitted`,
            href: `/sales/kyc/${o.id}`, priority: 'medium' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-amber-50', accentBorder: 'border-amber-200',
          accentText: 'text-amber-700', badgeBg: 'bg-amber-100',
          href: '/sales/kyc?status=PENDING',
        });
      }
    }

    // ── Approval Required (SO approves XSR; ASM approves SO) ─────────────────

    if (approvalStatus) {
      const approvalOutlets = outlets.filter((o) => o.kycStatus === approvalStatus);
      if (approvalOutlets.length > 0) {
        groups.push({
          id: 'approval_required', label: 'Approval Required',
          icon: <FileCheck className="h-4 w-4 text-blue-600" />,
          items: approvalOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · KYC submitted by ${approverLabel} — awaiting your approval`,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
          accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
          href: '/sales/kyc?status=APPROVAL_REQUIRED',
        });
      }
    }

    // ── More field-only tasks ─────────────────────────────────────────────────

    if (isFieldRole) {
      // Rejected KYC
      const rejectedOutlets = outlets.filter((o) =>
        o.kycStatus === KYCStatus.REJECTED || o.kycStatus === KYCStatus.RESUBMISSION_REQUIRED,
      );
      if (rejectedOutlets.length > 0) {
        groups.push({
          id: 'rejected_kyc', label: 'Rejected KYC',
          icon: <XCircle className="h-4 w-4 text-red-600" />,
          items: rejectedOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · Resubmission required`,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-red-50', accentBorder: 'border-red-200',
          accentText: 'text-red-700', badgeBg: 'bg-red-100',
          href: '/sales/kyc?status=REJECTED',
        });
      }

      // Visibility
      if (VISIBILITY_TASKS.length > 0) {
        groups.push({
          id: 'visibility', label: 'Visibility',
          icon: <FileCheck className="h-4 w-4 text-blue-600" />,
          items: VISIBILITY_TASKS,
          accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
          accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
          href: '/sales/tasks',
        });
      }
    }

    // HO Notifications / Reminders (admin-configurable via Settings → Task Configuration)
    // Filter to items whose date window is active right now
    const now = new Date();
    const activeHoItems = taskConfig.customTaskItems.filter((item) => {
      if (item.startsAt && new Date(item.startsAt) > now) return false;
      if (item.endsAt   && new Date(item.endsAt)   < now) return false;
      return true;
    });
    if (activeHoItems.length > 0) {
      groups.push({
        id: 'admin_tasks', label: taskConfig.customTaskLabel,
        icon: <Bell className="h-4 w-4 text-indigo-600" />,
        items: activeHoItems,
        accentBg: 'bg-indigo-50', accentBorder: 'border-indigo-200',
        accentText: 'text-indigo-700', badgeBg: 'bg-indigo-100',
        href: '/sales/tasks',
      });
    }

    return groups;
  }, [outlets, taskConfig, role]);

  const isFieldRole = role === 'XSR' || role === 'SO';
  const schemeCount = isFieldRole ? pendingSchemes.length : 0;
  const totalTasks  = taskGroups.reduce((s, g) => s + g.items.length, 0) + schemeCount;

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Your daily task overview</p>
        </div>
        {(role === 'XSR' || role === 'SO') && (
          <Link href="/sales/kyc/new">
            <Button variant="primary" size="sm">
              <Plus className="h-4 w-4" /> New Enrollment
            </Button>
          </Link>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* ── Sales Banners Strip ── */}
          {salesBanners.length > 0 && (
            <div className="space-y-2">
              {salesBanners.map((banner) => (
                <div
                  key={banner.id}
                  className="rounded-2xl p-4 text-white"
                  style={getBgStyle(banner.bgColor) as React.CSSProperties}
                >
                  {banner.title && (
                    <p className="text-sm font-bold leading-snug">{banner.title}</p>
                  )}
                  {banner.body && (
                    <p className="text-xs text-white/80 mt-1 leading-relaxed">{banner.body}</p>
                  )}
                  {banner.ctaLabel && banner.ctaUrl && (
                    <a
                      href={banner.ctaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2.5 px-3 py-1 bg-white/20 rounded-lg text-xs font-semibold"
                    >
                      {banner.ctaLabel}
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Tasks Summary Card ── */}
          <Card className="border-[var(--brand-primary)]/20">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <ListTodo className="h-4 w-4 text-[var(--brand-primary)]" /> Tasks
                  {totalTasks > 0 && (
                    <span className="text-[11px] font-bold bg-[var(--brand-primary)] text-white px-1.5 py-0.5 rounded-full">
                      {totalTasks}
                    </span>
                  )}
                </CardTitle>
                <Link href="/sales/tasks" className="flex items-center gap-1 text-xs font-semibold text-[var(--brand-primary)] hover:underline">
                  View all <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="pt-0 pb-1">
              {taskGroups.length === 0 && schemeCount === 0 ? (
                <div className="flex items-center gap-2 py-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <p className="text-xs text-gray-500">No pending tasks right now</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50 -mx-1">
                  {taskGroups.map((group) => {
                    const oldestAge = group.items.reduce((max, i) => Math.max(max, i.ageDays ?? 0), 0);
                    return (
                      <Link
                        key={group.id}
                        href={group.href}
                        className="flex items-center gap-3 px-1 py-2.5 hover:bg-gray-50 active:bg-gray-100 rounded-lg transition-colors"
                      >
                        <div className="shrink-0">{group.icon}</div>
                        <p className="text-sm text-gray-700 flex-1">{group.label}</p>
                        {oldestAge > 0 && (
                          <span className={`text-[11px] font-semibold shrink-0 ${oldestAge >= 7 ? 'text-red-500' : 'text-gray-400'}`}>
                            {oldestAge}d
                          </span>
                        )}
                        <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${group.badgeBg} ${group.accentText}`}>
                          {group.items.length}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 text-gray-300 shrink-0" />
                      </Link>
                    );
                  })}
                  {/* Scheme Enrollment — field roles only */}
                  {schemeCount > 0 && (
                    <Link
                      href="/sales/tasks"
                      className="flex items-center gap-3 px-1 py-2.5 hover:bg-gray-50 active:bg-gray-100 rounded-lg transition-colors"
                    >
                      <Tag className="h-4 w-4 text-emerald-600 shrink-0" />
                      <p className="text-sm text-gray-700 flex-1">Activation Enrollment</p>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                        {schemeCount}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-gray-300 shrink-0" />
                    </Link>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Target Achievement ── */}
          {targetConfig && (
            <TargetSummaryCard outlets={outlets} config={targetConfig} />
          )}

          {/* ── My Outlets ── */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-[var(--brand-primary)]" /> My Outlets
                </CardTitle>
                <Link href="/sales/outlets" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline flex items-center gap-0.5">
                  {outlets.length} outlets <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>

              {/* Search with live dropdown */}
              <div ref={searchRef} className="relative mt-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
                  onFocus={() => { if (search.trim()) setSearchOpen(true); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setSearchOpen(false); setSearch(''); }
                    if (e.key === 'Enter' && search.trim()) {
                      setSearchOpen(false);
                      if (searchResults.length === 1) {
                        window.location.href = `/sales/kyc/${searchResults[0].kycId}`;
                      } else {
                        window.location.href = `/sales/outlets?q=${encodeURIComponent(search.trim())}`;
                      }
                    }
                  }}
                  placeholder="Search outlets by name or mobile…"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white"
                  autoComplete="off"
                />

                {/* Dropdown */}
                {searchOpen && searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden">
                    {searchResults.map((o) => (
                      <button
                        key={o.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSearchOpen(false);
                          setSearch('');
                          window.location.href = `/sales/kyc/${o.kycId}`;
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 text-left transition-colors border-b border-gray-50 last:border-0"
                      >
                        <div className="w-8 h-8 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                          <span className="text-[11px] font-bold text-[var(--brand-primary)]">
                            {o.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{o.name}</p>
                          <p className="text-[11px] text-gray-400 truncate">{o.location} · {o.mobile}</p>
                        </div>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 bg-gray-100 text-gray-500">
                          {o.type === 'SUB_STOCKIST' ? 'SS' : o.type === 'WHOLESALER' ? 'WS' : 'RT'}
                        </span>
                      </button>
                    ))}
                    {/* View all results link */}
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSearchOpen(false);
                        window.location.href = `/sales/outlets?q=${encodeURIComponent(search.trim())}`;
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 transition-colors border-t border-gray-100"
                    >
                      <span>See all results for "{search}"</span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* No results */}
                {searchOpen && search.trim() && searchResults.length === 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-xl border border-gray-200 shadow-lg z-50 px-4 py-3 text-sm text-gray-400 text-center">
                    No outlets found for "{search}"
                  </div>
                )}
              </div>
            </CardHeader>
          </Card>

          {/* ── Sales vs Target chart ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" /> Target vs. Achievement
                </CardTitle>
                <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
                  {(['monthly', 'yoy'] as SalesChartView[]).map((v) => (
                    <button key={v} onClick={() => setChartView(v)}
                      className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${chartView === v ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500'}`}>
                      {v === 'monthly' ? 'Monthly' : 'Year on Year'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                {chartView === 'monthly' ? 'Last 6 months · ₹L' : 'FY 24-25 vs FY 25-26 · ₹L'}
              </p>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {([
                  { value: 'ALL', label: 'All' },
                  { value: 'VRIDDHI', label: 'Vriddhi' },
                  { value: 'SAMBANDH', label: 'Sambandh 2.0' },
                ] as { value: SalesOutletFilter; label: string }[]).map((opt) => (
                  <button key={opt.value} onClick={() => setOutletFilter(opt.value)}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                      outletFilter === opt.value ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="px-2 pb-3">
              <SalesAchievementChart view={chartView} outlet={outletFilter} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
