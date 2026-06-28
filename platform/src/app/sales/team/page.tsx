'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  Users, TrendingUp, FileCheck, MapPin, Eye,
  ChevronRight, AlertTriangle, Clock,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { type SalesRole, ROLE_LABELS, getRole, hasTeamView } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface MemberStats {
  id: string;
  employeeCode: string;
  mobile: string;
  name: string;
  role: SalesRole;
  territory: string;
  outlets: number;
  kycPending: number;
  kycDone: number;
  visibilityPending: number;
  targetPct: number;
  targetValue: number;
  teamSize?: number;
  lastSeen?: string;
}

/* ─── API mapper ────────────────────────────────────────────────────────────── */

function mapApiMember(m: any): MemberStats {
  return {
    id:                m.id,
    employeeCode:      m.employeeCode || '',
    mobile:            m.mobile || '',
    name:              m.name,
    role:              m.role as SalesRole,
    territory:         m.territory || '',
    outlets:           m.outlets           ?? 0,
    kycPending:        m.kycPending        ?? 0,
    kycDone:           m.kycDone           ?? 0,
    visibilityPending: m.visibilityPending ?? 0,
    targetPct:         m.targetPct         ?? 0,
    targetValue:       m.targetValue       ?? 0,
    teamSize:          m.teamSize,
    lastSeen:          m.lastSeen,
  };
}

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function paceBorderClass(targetPct: number): string {
  const today       = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const timePct     = Math.round((today.getDate() / daysInMonth) * 100);
  const gap    = timePct - targetPct;
  const status = classifyPaceGap(gap, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  if (status === 'green') return 'border-l-emerald-400';
  if (status === 'amber') return 'border-l-amber-400';
  return                         'border-l-red-400';
}

function relativeDate(dateStr: string): string {
  const d    = new Date(dateStr);
  const diff = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${diff} days ago`;
}

/* ─── Helper components ─────────────────────────────────────────────────────── */

function TargetBadge({ pct }: { pct: number }) {
  const color = pct >= 100 ? 'text-emerald-600' : pct >= 80 ? 'text-amber-600' : pct >= 60 ? 'text-orange-500' : 'text-red-600';
  const bg    = pct >= 100 ? 'bg-emerald-50'   : pct >= 80 ? 'bg-amber-50'   : pct >= 60 ? 'bg-orange-50'   : 'bg-red-50';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${color} ${bg}`}>
      {pct}%
    </span>
  );
}

function MemberCard({ m, drill }: { m: MemberStats; drill: string }) {
  const borderClass = paceBorderClass(m.targetPct);
  return (
    <Link href={drill} className="block">
      <div className={`flex items-center gap-3 py-3.5 px-3 border-l-4 ${borderClass} hover:bg-gray-50 transition-colors active:scale-[0.99]`}>
        <div className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
          <span className="text-[var(--brand-primary)] font-bold text-sm">
            {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 truncate">{m.name}</p>
            {m.targetPct > 0 && <TargetBadge pct={m.targetPct} />}
          </div>
          {/* Owner 2026-06-26: show employee ID + phone here, NOT the internal CUID.
              Falls back to territory; never renders the raw id. */}
          <p className="text-xs text-gray-500 truncate">
            {[m.employeeCode, m.mobile].filter(Boolean).join(' · ') || m.territory}
          </p>

          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {m.outlets > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <MapPin className="h-3 w-3" /> {m.outlets} outlets
              </span>
            )}
            {m.teamSize !== undefined && m.teamSize > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <Users className="h-3 w-3" /> {m.teamSize} team
              </span>
            )}
            {m.kycPending > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-amber-600">
                <AlertTriangle className="h-3 w-3" /> {m.kycPending} KYC
              </span>
            )}
            {m.visibilityPending > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-blue-500">
                <Eye className="h-3 w-3" /> {m.visibilityPending} vis.
              </span>
            )}
            {m.lastSeen && (
              <span className="flex items-center gap-1 text-[10px] text-gray-400">
                <Clock className="h-3 w-3" /> {relativeDate(m.lastSeen)}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Summary strip ─────────────────────────────────────────────────────────── */

function SummaryStrip({ members }: { members: MemberStats[] }) {
  const totalOutlets    = members.reduce((s, m) => s + m.outlets, 0);
  const totalKycPending = members.reduce((s, m) => s + m.kycPending, 0);
  const totalKycDone    = members.reduce((s, m) => s + m.kycDone, 0);
  const totalTarget     = members.reduce((s, m) => s + m.targetValue, 0);
  const totalAchieved   = members.reduce((s, m) => s + m.targetValue * m.targetPct, 0);
  const avgTarget       = totalTarget > 0 ? Math.round(totalAchieved / totalTarget) : 0;

  const stats = [
    { label: 'Outlets',     value: totalOutlets,    icon: MapPin,        color: 'text-gray-600',                  href: '/sales/outlets'             },
    { label: 'KYC Done',    value: totalKycDone,    icon: FileCheck,     color: 'text-emerald-600',               href: '/sales/kyc?status=APPROVED' },
    { label: 'KYC Pending', value: totalKycPending, icon: AlertTriangle, color: 'text-amber-600',                 href: '/sales/kyc?status=PENDING'  },
    { label: 'Avg Target',  value: `${avgTarget}%`, icon: TrendingUp,    color: 'text-[var(--brand-primary)]',    href: '/sales/outlets'             },
  ];

  return (
    <div className="grid grid-cols-4 gap-2">
      {stats.map((s) => (
        <Link key={s.label} href={s.href}
          className="bg-white rounded-xl border border-gray-100 p-3 flex flex-col items-center gap-1 hover:border-gray-300 hover:shadow-sm active:scale-[0.97] transition-all">
          <s.icon className={`h-4 w-4 ${s.color}`} />
          <p className={`text-base font-bold ${s.color}`}>{s.value}</p>
          <p className="text-[9px] text-gray-400 text-center leading-tight">{s.label}</p>
        </Link>
      ))}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesTeamPage() {
  const [role,          setRoleState]    = useState<SalesRole>('SO');
  const [loading,       setLoading]      = useState(true);
  const [apiMembers,    setApiMembers]   = useState<MemberStats[]>([]);
  const [salesUserData, setSalesUserData] = useState<{ role: string; region?: string | null; zone?: string | null } | null>(null);

  useEffect(() => {
    setRoleState(getRole());
    const controller = new AbortController();
    fetch('/api/sales/team', {
      signal:  controller.signal,
    })
      .then((r) => r.json())
      .then((body) => {
        if (body.success) {
          setSalesUserData(body.data.salesUser ?? null);
          setApiMembers((body.data.members ?? []).map(mapApiMember));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const { heading, subheading, memberRole } = useMemo(() => {
    const memberRoleCode = (apiMembers[0]?.role ?? 'XSR') as SalesRole;
    const territory      = salesUserData?.region ?? salesUserData?.zone ?? '';
    const isNSM          = role === 'NSM';
    const roleLabel      = ROLE_LABELS[memberRoleCode] ?? String(memberRoleCode);
    return {
      heading:    isNSM ? 'National Team' : 'My Team',
      subheading: apiMembers.length > 0 ? `${roleLabel}s · ${territory}` : '',
      memberRole: memberRoleCode,
    };
  }, [salesUserData, apiMembers, role]);

  const sortedMembers = useMemo(
    () => [...apiMembers].sort((a, b) => a.targetPct - b.targetPct),
    [apiMembers],
  );

  if (!hasTeamView(role)) {
    return (
      <div className="space-y-5 fade-in">
        <h1 className="text-xl font-bold text-gray-900">Team</h1>
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No team view"
          description="XSRs don't have a team below them."
          className="py-16"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-xl font-bold text-gray-900">{heading}</h1>
        <p className="text-sm text-gray-500">{subheading}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <>
          <SummaryStrip members={sortedMembers} />

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[var(--brand-primary)]" />
                  {ROLE_LABELS[memberRole]}s
                </CardTitle>
                <span className="text-xs text-gray-400">
                  {sortedMembers.length} member{sortedMembers.length !== 1 ? 's' : ''}
                </span>
              </div>
            </CardHeader>
            <CardContent className="px-0 py-0">
              <div className="divide-y divide-gray-50">
                {sortedMembers.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No team members found</p>
                ) : (
                  sortedMembers.map((m) => (
                    <MemberCard key={m.id} m={m} drill={`/sales/team/${m.id}`} />
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
