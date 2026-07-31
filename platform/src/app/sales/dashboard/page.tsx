'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  FileCheck, XCircle, Plus, Search,
  ChevronRight, Clock, MapPin, TrendingUp, Target,
  CheckCircle2, Bell, ListTodo, RefreshCw, Layers, Tag,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { KYCStatus } from '@/types';
import { pct, pctBarColor } from '@/lib/targets';
import { type SalesRole, getRole, canEnroll } from '@/lib/sales-role';
import { classifyPaceGap, buildCasesToGoMsg } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { fetchTaskConfig, type TaskConfig, type CustomTaskItem } from '@/lib/task-config';
import { fetchBanners, getActiveSalesBanners, getBgStyle, type Banner } from '@/lib/banner';
import { schemeApi } from '@/lib/schemes';
import type { EligibleScheme } from '@/lib/scheme-types';
import { fetchOutletVisibilityStatuses, VISIBILITY_ELIGIBLE_OUTLET_TYPES } from '@/lib/visibility-upload';
import {
  buildKycSubRows, buildVisibilityTaskItems, buildPhotoCaptureTaskItems, type KycSubRow,
} from '@/lib/sales-tasks';
import { visibilityApi } from '@/lib/visibility';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletRow {
  id: string; kycId: string; name: string; mobile: string;
  location: string; type: OutletType; kycStatus: KYCStatus;
  lastVisit?: string; kycSubmittedAt?: string;
  outletCode: string; // for the visibility-status lookup
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


/* ─── Age helper ─────────────────────────────────────────────────────────────── */

function ageInDays(dateStr?: string): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

/* ─── Target achievement card ────────────────────────────────────────────────── */

interface SalesKpi {
  code: string; name: string; unit: string; isPrimary: boolean;
  target: number; achieved: number; pace: number | null;
}
interface SalesTargets {
  period: string | null; outletCount: number;
  kpis: SalesKpi[];
  trend: { month: string; target: number; achieved: number }[];
}

/** Real target vs achievement, summed across the rep's outlets (GET /api/sales/targets). */
function TargetSummaryCard({ targets }: { targets: SalesTargets }) {
  const kpis = targets.kpis;
  const withTarget = kpis.filter((k) => k.target > 0);

  const now          = new Date();
  const periodLabel  = (targets.period ? new Date(`${targets.period}-01T00:00:00`) : now)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const daysInMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft     = daysInMonth - now.getDate();
  const timePct      = Math.round((now.getDate() / daysInMonth) * 100);

  // Pace badge is driven by the PRIMARY metric (owner): a plain "{remaining} {unit}
  // to go" the rep can act on, coloured by how the PRIMARY KPI is pacing — NOT the
  // all-KPI average, which is skewed green when a secondary KPI is over-achieved.
  const primaryKpi    = kpis.find((k) => k.isPrimary) ?? withTarget[0] ?? null;
  const primaryPct    = primaryKpi && primaryKpi.target > 0 ? pct(primaryKpi.achieved, primaryKpi.target) : 0;
  const primaryLeft   = primaryKpi ? Math.max(0, primaryKpi.target - primaryKpi.achieved) : 0;
  const paceStatus    = primaryLeft === 0
    ? 'green'
    : classifyPaceGap(timePct - primaryPct, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  const paceBg        = paceStatus === 'green' ? 'bg-emerald-50' : paceStatus === 'amber' ? 'bg-amber-50' : 'bg-red-50';
  const paceTextColor = paceStatus === 'green' ? 'text-emerald-700' : paceStatus === 'amber' ? 'text-amber-700' : 'text-red-600';
  const paceText      = primaryLeft === 0
    ? `${primaryKpi?.name ?? 'Primary'} target met 🎉`
    : buildCasesToGoMsg(primaryLeft, primaryKpi?.unit ?? '', daysLeft);

  return (
    <Link href="/sales/outlets" className="block">
      <Card className="border-[var(--brand-primary)]/20 cursor-pointer hover:border-[var(--brand-primary)]/40 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-[var(--brand-primary)]" /> Target Achievement
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400 font-medium">{periodLabel}</span>
              {daysLeft > 0 && (
                <span className={`text-[11px] font-semibold ${daysLeft <= 7 ? 'text-red-500' : daysLeft <= 14 ? 'text-amber-600' : 'text-gray-400'}`}>
                  · {daysLeft}d left
                </span>
              )}
            </div>
          </div>
          {targets.outletCount > 0 && (
            <p className="text-[11px] text-gray-400 mt-1">Across {targets.outletCount} assigned outlet{targets.outletCount === 1 ? '' : 's'}</p>
          )}
        </CardHeader>
        <CardContent className="space-y-2.5">
          {kpis.length === 0 ? (
            <p className="text-xs text-gray-400 py-2">No targets have been uploaded for your outlets yet.</p>
          ) : (
            <>
              {kpis.map((k) => {
                const p   = k.target > 0 ? pct(k.achieved, k.target) : 0;
                const bar = pctBarColor(p);
                return (
                  <div key={k.code} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-gray-700 flex-1 truncate">
                        {k.name}{k.isPrimary && <span className="ml-1 text-[9px] font-bold text-[var(--brand-primary)] align-middle">PRIMARY</span>}
                      </p>
                      <span className={`text-[11px] font-bold shrink-0 ${p >= 100 ? 'text-emerald-600' : p >= 80 ? 'text-amber-600' : p >= 60 ? 'text-orange-500' : 'text-red-500'}`}>
                        {k.achieved.toLocaleString('en-IN')}/{k.target.toLocaleString('en-IN')}{k.unit ? ` ${k.unit}` : ''} · {p}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${bar}`} style={{ width: `${Math.min(p, 100)}%` }} />
                    </div>
                  </div>
                );
              })}

              {primaryKpi && (
                <div className={`flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1.5 rounded-lg mt-1 ${paceBg} ${paceTextColor}`}>
                  <TrendingUp className="h-3 w-3 shrink-0" />
                  {paceText}
                </div>
              )}

              <div className="flex items-center justify-center gap-1 text-xs font-semibold text-[var(--brand-primary)] pt-1">
                View full outlet KPIs <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

/** Real 6-month target-vs-achieved bar chart on the primary KPI (GET /api/sales/targets → trend). */
function TargetTrendChart({ trend, unit }: { trend: SalesTargets['trend']; unit: string }) {
  const hasData = trend.some((t) => t.target > 0 || t.achieved > 0);
  if (!hasData) {
    return <p className="text-xs text-gray-400 text-center py-6">No target history yet for your outlets.</p>;
  }
  const max = Math.max(1, ...trend.map((t) => Math.max(t.target, t.achieved)));
  return (
    <div className="flex items-end justify-between gap-2 h-40 px-1 pt-2">
      {trend.map((t) => {
        const label = new Date(`${t.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
        return (
          <div key={t.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="flex items-end gap-0.5 h-32 w-full justify-center">
              <div className="w-2.5 bg-gray-200 rounded-t" style={{ height: `${(t.target / max) * 100}%` }} title={`Target ${t.target.toLocaleString('en-IN')} ${unit}`} />
              <div className="w-2.5 bg-[var(--brand-primary)] rounded-t" style={{ height: `${(t.achieved / max) * 100}%` }} title={`Achieved ${t.achieved.toLocaleString('en-IN')} ${unit}`} />
            </div>
            <span className="text-[9px] text-gray-400">{label}</span>
          </div>
        );
      })}
    </div>
  );
}


/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesDashboard() {
  const [outlets,      setOutlets]      = useState<OutletRow[]>([]);
  const [kycSubs,      setKycSubs]      = useState<KycSubRow[]>([]);
  const [visibilityItems, setVisibilityItems] = useState<TaskItem[]>([]);
  const [visibilityMode, setVisibilityMode] = useState<'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD'>('PHOTO_APPROVAL');
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [salesTargets,  setSalesTargets]  = useState<SalesTargets | null>(null);
  const [role,          setRoleState]     = useState<SalesRole>('SO');
  const [taskConfig,    setTaskConfig]    = useState<TaskConfig | null>(null);
  const [salesBanners,  setSalesBanners]  = useState<Banner[]>([]);
  const [schemes, setSchemes] = useState<EligibleScheme[]>([]);

  useEffect(() => {
    setRoleState(getRole());

    // Real eligible schemes (roster-based §13.4; no localStorage demo data here).
    void schemeApi.listSalesEligible()
      .then((r) => setSchemes(r.success ? (r.data.schemes ?? []) : []))
      .catch(() => setSchemes([]));

    Promise.all([
      fetchTaskConfig(),
      fetchBanners(),
      fetch('/api/sales/outlets').then((r) => r.json()),
      fetch('/api/sales/targets').then((r) => r.json()).catch(() => null),
      fetch('/api/kyc').then((r) => r.json()).catch(() => null),
    ]).then(([config, { banners }, outletResult, targetResult, kycResult]) => {
      setTaskConfig(config);
      setSalesBanners(getActiveSalesBanners(banners));
      if (targetResult?.success) setSalesTargets(targetResult.data as SalesTargets);
      if (outletResult.success) {
        setOutlets((outletResult.data.outlets ?? []).map((o: any) => ({
          id:             o.id,
          kycId:          o.kycId ?? '',
          outletCode:     o.outletCode ?? '',
          name:           o.name,
          mobile:         o.mobile,
          location:       o.location ?? o.city ?? '',
          type:           (o.type ?? 'SSS') as OutletType,
          kycStatus:      (o.kycStatus ?? 'NOT_STARTED') as KYCStatus,
          kycSubmittedAt: o.kycSubmittedAt,
        })));
      }
      // Approval/Rejected counts derive from SUBMISSIONS (shared with the Tasks
      // page via buildKycSubRows) so the two views can never disagree.
      setKycSubs(buildKycSubRows(kycResult));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onStorage = () => {
      setRoleState(getRole());
      void schemeApi.listSalesEligible()
        .then((r) => setSchemes(r.success ? (r.data.schemes ?? []) : []))
        .catch(() => setSchemes([]));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* ── Visibility tasks — same source + shape as the Tasks page (buildVisibilityTaskItems)
       so the dashboard's "Visibility" count matches /sales/tasks. Enroll roles only. ── */
  useEffect(() => {
    const isFieldRole = canEnroll(role);
    const gs = getGifsySettings();
    const visibilityEnabled = gs.visibilityEnabled === true;
    const captureMode = gs.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
    setVisibilityMode(captureMode);
    // Master Visibility switch OFF → no visibility task group.
    if (!visibilityEnabled) { setVisibilityItems([]); return; }
    let cancelled = false;
    // Mode-aware (D3/D14): PHOTO_APPROVAL sources pending captures from the sales-eligible
    // window, driven by the backend's `canCapture` — so ANY capturer (incl. RSM/ZNM/NSM
    // managers via allowedSalesLevels / downline) gets the nudge, NOT just field roles.
    // AMOUNT_UPLOAD keeps the OutletVisibilityRecord path and stays field-role only.
    // Shared builders keep this count identical to the Tasks page.
    if (captureMode === 'PHOTO_APPROVAL') {
      visibilityApi.getSalesEligible()
        .then((r) => { if (!cancelled) setVisibilityItems(buildPhotoCaptureTaskItems(r.success ? r.data : null)); })
        .catch(() => { if (!cancelled) setVisibilityItems([]); });
      return () => { cancelled = true; };
    }
    if (!isFieldRole) { setVisibilityItems([]); return; }
    const eligible = outlets.filter((o) => VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type));
    const codes = eligible.map((o) => o.outletCode).filter(Boolean);
    if (codes.length === 0) { setVisibilityItems([]); return; }
    const month = new Date().toISOString().slice(0, 7);
    fetchOutletVisibilityStatuses(codes, month)
      .then((map) => { if (!cancelled) setVisibilityItems(buildVisibilityTaskItems(eligible, map, visibilityEnabled)); })
      .catch(() => { if (!cancelled) setVisibilityItems([]); });
    return () => { cancelled = true; };
  }, [outlets, role]);

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
    const isFieldRole = canEnroll(role);
    const approvalStatus =
      role === 'SO'  ? KYCStatus.PENDING_SO_APPROVAL  :
      role === 'ASM' ? KYCStatus.PENDING_ASM_APPROVAL :
      null;
    const approverLabel = role === 'SO' ? 'XSR' : role === 'ASM' ? 'SO' : null;

    // ── Enroll-role tasks (XSR / SO / ASM) ─────────────────────────────────────

    if (isFieldRole) {
      // To-enroll: outlets that exist (master-loaded) but KYC was never started.
      // These were previously matched by NO group (the "Pending KYC" group keys on
      // PENDING = submitted-awaiting-processing, not NOT_STARTED), so a rep with
      // only fresh un-KYC'd outlets saw "no tasks" despite enrollment being the job.
      const notStartedOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.NOT_STARTED);
      if (notStartedOutlets.length > 0) {
        groups.push({
          id: 'kyc_to_do', label: 'KYC to be done',
          icon: <FileCheck className="h-4 w-4 text-emerald-600" />,
          items: notStartedOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · New enrollment — KYC not started`,
            href: '/sales/kyc/new', priority: 'high' as const,
          })),
          accentBg: 'bg-emerald-50', accentBorder: 'border-emerald-200',
          accentText: 'text-emerald-700', badgeBg: 'bg-emerald-100',
          href: '/sales/kyc?status=NOT_STARTED',
        });
      }

      // Re-KYC
      const rekycOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.RE_KYC_REQUIRED);
      if (rekycOutlets.length > 0) {
        groups.push({
          id: 're_kyc', label: 'Re-KYC Required',
          icon: <RefreshCw className="h-4 w-4 text-purple-600" />,
          items: rekycOutlets.map((o) => ({
            id: o.kycId || o.id, title: o.name, subtitle: 'Re-KYC required',
            // Re-KYC outlets normally have a prior submission (kycId); guard the empty
            // case so the fallback never points at a non-existent submission id (an
            // outlet id) → "KYC not found". Empty → start wizard on this outlet.
            href: o.kycId ? `/sales/kyc/${o.kycId}` : `/sales/kyc/new?outletId=${o.id}`,
            priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
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
            // These outlets have NO submission yet (the subtitle says so), so the old
            // `/sales/kyc/${o.id}` linked to a non-existent submission id → "KYC not
            // found". With a real kycId, deep-link to the detail; otherwise open the
            // start wizard pre-selected on this outlet.
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

    // ── Approval Required (SO approves XSR; ASM approves SO) ─────────────────

    if (approvalStatus) {
      // From SUBMISSIONS (not outlets) so the count matches the KYC list's "Approval
      // Pending" — including submissions with no linked outlet. href uses the
      // submission id (the detail page reads /api/kyc/:id, a submission id).
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

    // ── More field-only tasks ─────────────────────────────────────────────────

    if (isFieldRole) {
      // Rejected KYC — the rejected family is ASSIGNMENT-scoped work: a rejected outlet
      // REASSIGNED to this rep whose original KYC was filed by ANOTHER rep never appears in
      // the submitter-scoped kycSubs (/api/kyc). So derive from the assignment-scoped
      // `outlets` (/api/sales/outlets), and merge in submitter-scoped submissions that have
      // NO linked outlet (kycSubs can't be derived from outlets), deduped by outletCode with
      // the outlet-derived row winning. Mirrors the KYC list's synth/subs merge.
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

    // Visibility — outlets whose monthly capture isn't APPROVED yet (shared derivation
    // with the Tasks page). Mode-aware (D8/D14): PHOTO_APPROVAL surfaces to ANY capturer
    // (incl. managers, driven by canCapture) — NOT gated on isFieldRole; AMOUNT_UPLOAD
    // stays field-role only. visibilityItems is empty for a non-capturer either way.
    const showVisibilityGroup = visibilityMode === 'PHOTO_APPROVAL' || canEnroll(role);
    if (showVisibilityGroup && visibilityItems.length > 0) {
      groups.push({
        id: 'visibility', label: 'Visibility',
        icon: <FileCheck className="h-4 w-4 text-blue-600" />,
        items: visibilityItems,
        accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
        accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
        href: '/sales/visibility',
      });
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
  }, [outlets, kycSubs, visibilityItems, visibilityMode, taskConfig, role]);

  const isFieldRole = canEnroll(role);
  const schemeCount = isFieldRole ? schemes.length : 0;
  const totalTasks  = taskGroups.reduce((s, g) => s + g.items.length, 0) + schemeCount;

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Your daily task overview</p>
        </div>
        {canEnroll(role) && (
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
                      <p className="text-sm text-gray-700 flex-1">Activations / Tasks</p>
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

          {/* ── Target Achievement (real /api/sales/targets) ── */}
          {salesTargets && (
            <TargetSummaryCard targets={salesTargets} />
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
                        const only = searchResults[0];
                        // No submission yet → start wizard (else the empty kycId yields a
                        // dead /sales/kyc/ → "KYC not found").
                        window.location.href = only.kycId
                          ? `/sales/kyc/${only.kycId}`
                          : `/sales/kyc/new?outletId=${only.id}`;
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
                          // No submission yet → start wizard (else empty kycId → dead route).
                          window.location.href = o.kycId
                            ? `/sales/kyc/${o.kycId}`
                            : `/sales/kyc/new?outletId=${o.id}`;
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

          {/* ── Target vs Achievement — real 6-month trend on the primary KPI ── */}
          {salesTargets && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" /> Target vs. Achievement
                  </CardTitle>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-gray-200" /> Target</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--brand-primary)]" /> Achieved</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  Last 6 months · {salesTargets.kpis.find((k) => k.isPrimary)?.name ?? salesTargets.kpis[0]?.name ?? 'Primary KPI'}
                </p>
              </CardHeader>
              <CardContent className="px-2 pb-3">
                <TargetTrendChart
                  trend={salesTargets.trend}
                  unit={salesTargets.kpis.find((k) => k.isPrimary)?.unit ?? salesTargets.kpis[0]?.unit ?? ''}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
