'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Users, TrendingUp, FileCheck, MapPin, Eye,
  ChevronRight, AlertTriangle, Clock, ChevronDown,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { type SalesRole, ROLE_LABELS, getRole, hasTeamView } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import {
  resolveConfig, computeParamAchievements, MEMBER_TERRITORY, XSR_OUTLETS,
  pctBarColor, pctColor, DEMO_PERIOD,
} from '@/lib/targets';

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface MemberStats {
  id: string;
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
  lastSeen: string; // ISO date string
}

/* ─── Mock data ─────────────────────────────────────────────────────────────── */

const MOCK_XSRS: MemberStats[] = [
  { id: 'xsr1', name: 'Anil Sharma',  role: 'XSR', territory: 'Andheri Beat',  outlets: 18, kycPending: 3, kycDone: 15, visibilityPending: 2, targetPct: 82, targetValue:  600, lastSeen: '2026-05-29' },
  { id: 'xsr2', name: 'Divya Pillai', role: 'XSR', territory: 'Juhu Beat',     outlets: 14, kycPending: 5, kycDone:  9, visibilityPending: 4, targetPct: 58, targetValue:  500, lastSeen: '2026-05-28' },
  { id: 'xsr3', name: 'Kiran Rao',    role: 'XSR', territory: 'Versova Beat',  outlets: 11, kycPending: 1, kycDone: 10, visibilityPending: 0, targetPct: 91, targetValue:  400, lastSeen: '2026-05-29' },
  { id: 'xsr4', name: 'Meena Joshi',  role: 'XSR', territory: 'DN Nagar Beat', outlets: 16, kycPending: 6, kycDone: 10, visibilityPending: 3, targetPct: 44, targetValue:  700, lastSeen: '2026-05-27' },
];

const MOCK_SOS: MemberStats[] = [
  { id: 'so1', name: 'Rajesh Kumar', role: 'SO', territory: 'Mumbai West', outlets: 59, kycPending: 15, kycDone: 44, visibilityPending: 9,  targetPct: 76, targetValue: 2200, teamSize: 4, lastSeen: '2026-05-29' },
  { id: 'so2', name: 'Nisha Verma',  role: 'SO', territory: 'Mumbai East', outlets: 47, kycPending:  8, kycDone: 39, visibilityPending: 5,  targetPct: 88, targetValue: 1800, teamSize: 3, lastSeen: '2026-05-29' },
  { id: 'so3', name: 'Arjun Patil',  role: 'SO', territory: 'Thane City',  outlets: 52, kycPending: 20, kycDone: 32, visibilityPending: 12, targetPct: 55, targetValue: 2500, teamSize: 4, lastSeen: '2026-05-26' },
  { id: 'so4', name: 'Sunita Desai', role: 'SO', territory: 'Navi Mumbai', outlets: 38, kycPending:  4, kycDone: 34, visibilityPending: 2,  targetPct: 93, targetValue: 1400, teamSize: 3, lastSeen: '2026-05-28' },
];

const MOCK_ASMS: MemberStats[] = [
  { id: 'asm1', name: 'Priya Mehta',      role: 'ASM', territory: 'Mumbai Zone', outlets: 196, kycPending: 47, kycDone: 149, visibilityPending: 28, targetPct: 78, targetValue:  7900, teamSize: 4, lastSeen: '2026-05-29' },
  { id: 'asm2', name: 'Rohit Deshpande', role: 'ASM', territory: 'Pune Zone',   outlets: 143, kycPending: 31, kycDone: 112, visibilityPending: 19, targetPct: 64, targetValue:  6000, teamSize: 3, lastSeen: '2026-05-28' },
  { id: 'asm3', name: 'Sonal Agrawal',   role: 'ASM', territory: 'Nashik Zone', outlets:  98, kycPending: 22, kycDone:  76, visibilityPending: 11, targetPct: 71, targetValue:  4500, teamSize: 3, lastSeen: '2026-05-27' },
  { id: 'asm4', name: 'Vikram Bhosale',  role: 'ASM', territory: 'Nagpur Zone', outlets:  74, kycPending: 18, kycDone:  56, visibilityPending:  8, targetPct: 57, targetValue:  3000, teamSize: 2, lastSeen: '2026-05-25' },
];

const MOCK_RSMS: MemberStats[] = [
  { id: 'rsm1', name: 'Suresh Nair',   role: 'RSM', territory: 'Maharashtra', outlets: 511, kycPending: 118, kycDone: 393, visibilityPending: 66, targetPct: 72, targetValue: 21400, teamSize: 4, lastSeen: '2026-05-29' },
  { id: 'rsm2', name: 'Leela Iyer',    role: 'RSM', territory: 'Karnataka',   outlets: 342, kycPending:  76, kycDone: 266, visibilityPending: 43, targetPct: 68, targetValue: 16000, teamSize: 3, lastSeen: '2026-05-28' },
  { id: 'rsm3', name: 'Deepak Tiwari', role: 'RSM', territory: 'Gujarat',     outlets: 289, kycPending:  54, kycDone: 235, visibilityPending: 31, targetPct: 81, targetValue: 13000, teamSize: 3, lastSeen: '2026-05-29' },
  { id: 'rsm4', name: 'Ananya Bose',   role: 'RSM', territory: 'Rajasthan',   outlets: 267, kycPending:  60, kycDone: 207, visibilityPending: 29, targetPct: 74, targetValue: 11000, teamSize: 3, lastSeen: '2026-05-27' },
];

const MOCK_ZMS: MemberStats[] = [
  { id: 'zm1', name: 'Vikram Singh',  role: 'ZNM', territory: 'West Zone',  outlets: 1409, kycPending: 308, kycDone: 1101, visibilityPending: 169, targetPct: 74, targetValue: 61400, teamSize: 4, lastSeen: '2026-05-29' },
  { id: 'zm2', name: 'Ravi Menon',    role: 'ZNM', territory: 'South Zone', outlets: 1124, kycPending: 241, kycDone:  883, visibilityPending: 128, targetPct: 71, targetValue: 52000, teamSize: 4, lastSeen: '2026-05-28' },
  { id: 'zm3', name: 'Kavita Sharma', role: 'ZNM', territory: 'North Zone', outlets:  987, kycPending: 196, kycDone:  791, visibilityPending: 103, targetPct: 68, targetValue: 45000, teamSize: 3, lastSeen: '2026-05-26' },
  { id: 'zm4', name: 'Arun Gupta',    role: 'ZNM', territory: 'East Zone',  outlets:  834, kycPending: 179, kycDone:  655, visibilityPending:  92, targetPct: 66, targetValue: 38000, teamSize: 3, lastSeen: '2026-05-24' },
];

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

/** Pace-based left border colour: compare time elapsed vs % achieved */
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

/** Green ONLY at 100%+ — matching pctBg rule */
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
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
          <span className="text-[var(--brand-primary)] font-bold text-sm">
            {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
          </span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 truncate">{m.name}</p>
            <TargetBadge pct={m.targetPct} />
          </div>
          <p className="text-xs text-gray-500 truncate">{m.id}</p>

          {/* Mini stats row */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className="flex items-center gap-1 text-[10px] text-gray-500">
              <MapPin className="h-3 w-3" /> {m.outlets} outlets
            </span>
            {m.teamSize !== undefined && (
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
            <span className="flex items-center gap-1 text-[10px] text-gray-400">
              <Clock className="h-3 w-3" /> {relativeDate(m.lastSeen)}
            </span>
          </div>
        </div>

        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Performance card data ──────────────────────────────────────────────────── */

type OutletTypeFilter = 'ALL' | 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

const TYPE_LABELS: Record<OutletTypeFilter, string> = {
  ALL: 'All Types', SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist',
};

/** Type of each demo outlet — mirrors OUTLET_META in the outlets pages */
const OUTLET_TYPE_MAP: Record<string, 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST'> = {
  o1:  'SSS',    o2:  'SSS',  o3:  'WHOLESALER',
  o4:  'SSS',    o5:  'SSS',  o6:  'WHOLESALER',
  o7:  'SSS',    o8:  'SSS',  o9:  'SSS',
  o10: 'WHOLESALER',  o11: 'SSS',  o12: 'WHOLESALER',
  o13: 'SUB_STOCKIST',
};

/** Viewer's own member ID for each demo role */
const ROLE_VIEWER: Partial<Record<SalesRole, string>> = {
  SO: 'so1', ASM: 'asm1', RSM: 'rsm1', ZM: 'zm1', NM: 'zm1',
};

/** Manager → direct-report member IDs (demo data only) */
const MEMBER_TREE: Record<string, string[]> = {
  so1:  ['xsr1', 'xsr2', 'xsr3', 'xsr4'],
  asm1: ['so1'],
  rsm1: ['asm1'],
  zm1:  ['rsm1'],
};

function gatherOutletIds(memberId: string): string[] {
  if (XSR_OUTLETS[memberId]) return XSR_OUTLETS[memberId];
  return (MEMBER_TREE[memberId] ?? []).flatMap(gatherOutletIds);
}

function TeamPerformanceCard({ viewerMemberId }: { viewerMemberId: string }) {
  const router = useRouter();
  const [typeFilter,   setTypeFilter]   = useState<OutletTypeFilter>('ALL');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const territory = MEMBER_TERRITORY[viewerMemberId];
  const config    = territory
    ? resolveConfig(territory.beat, territory.district, territory.state, DEMO_PERIOD)
    : null;

  const allIds      = gatherOutletIds(viewerMemberId);
  const filteredIds = typeFilter === 'ALL'
    ? allIds
    : allIds.filter((id) => OUTLET_TYPE_MAP[id] === typeFilter);

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.995]"
      onClick={() => router.push('/sales/outlets')}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" /> Performance
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Type filter — stop propagation so dropdown doesn't trigger card navigation */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-700 hover:border-gray-300 transition-colors"
              >
                {TYPE_LABELS[typeFilter]}
                <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
              </button>
              {dropdownOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-gray-100 py-1 min-w-[148px]">
                    {(['ALL', 'SSS', 'WHOLESALER', 'SUB_STOCKIST'] as OutletTypeFilter[]).map((t) => (
                      <button key={t} onClick={() => { setTypeFilter(t); setDropdownOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors ${t === typeFilter ? 'text-[var(--brand-primary)] font-semibold' : 'text-gray-700'}`}
                      >
                        {TYPE_LABELS[t]}
                        {t === typeFilter && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)]" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!config ? (
          <p className="text-xs text-gray-400 py-2">No targets configured for this territory and period.</p>
        ) : filteredIds.length === 0 ? (
          <p className="text-xs text-gray-400 py-2">Outlet performance data not yet available for this selection.</p>
        ) : (
          (() => {
            const achievements = computeParamAchievements(filteredIds, config.params);
            return config.params.map((param) => {
              const a   = achievements[param.id];
              const bar = pctBarColor(a.pct);
              const col = pctColor(a.pct);
              return (
                <div key={param.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-gray-700 flex-1 truncate">{param.label}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[11px] text-gray-400 tabular-nums">
                        {a.achieved.toLocaleString('en-IN')} / {a.target.toLocaleString('en-IN')} {param.unit}
                      </span>
                      <span className={`text-[11px] font-bold tabular-nums ${col}`}>{a.pct}%</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${bar}`}
                      style={{ width: `${Math.min(a.pct, 100)}%` }}
                    />
                  </div>
                </div>
              );
            });
          })()
        )}
      </CardContent>
    </Card>
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
    { label: 'Outlets',     value: totalOutlets,    icon: MapPin,       color: 'text-gray-600',    href: '/sales/outlets'             },
    { label: 'KYC Done',    value: totalKycDone,    icon: FileCheck,    color: 'text-emerald-600', href: '/sales/kyc?status=APPROVED' },
    { label: 'KYC Pending', value: totalKycPending, icon: AlertTriangle,color: 'text-amber-600',   href: '/sales/kyc?status=PENDING'  },
    { label: 'Avg Target',  value: `${avgTarget}%`, icon: TrendingUp,   color: 'text-[var(--brand-primary)]',   href: '/sales/outlets'             },
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
  const [role, setRoleState] = useState<SalesRole>('SO');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setRoleState(getRole());
    const t = setTimeout(() => setLoading(false), 400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const { members, heading, subheading, memberRole } = useMemo(() => {
    switch (role) {
      case 'SO':  return { members: MOCK_XSRS, heading: 'My Team', subheading: 'XSRs · Mumbai West',               memberRole: 'XSR' as SalesRole };
      case 'ASM': return { members: MOCK_SOS,  heading: 'My Team', subheading: 'Sales Officers · Mumbai Zone',     memberRole: 'SO'  as SalesRole };
      case 'RSM': return { members: MOCK_ASMS, heading: 'My Team', subheading: 'Area Sales Managers · Maharashtra', memberRole: 'ASM' as SalesRole };
      case 'ZNM': return { members: MOCK_RSMS, heading: 'My Team', subheading: 'Regional Managers · West Zone',    memberRole: 'RSM' as SalesRole };
      case 'NSM': return { members: MOCK_ZMS,  heading: 'National Team', subheading: 'Zonal Managers · Pan India', memberRole: 'ZNM' as SalesRole };
      default:    return { members: [],        heading: 'Team',    subheading: '',                                  memberRole: 'XSR' as SalesRole };
    }
  }, [role]);

  // Sort worst-first (ascending targetPct)
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => a.targetPct - b.targetPct),
    [members],
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
          <SummaryStrip members={members} />

          <TeamPerformanceCard viewerMemberId={ROLE_VIEWER[role] ?? ''} />

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[var(--brand-primary)]" />
                  {ROLE_LABELS[memberRole]}s
                </CardTitle>
                <span className="text-xs text-gray-400">{sortedMembers.length} members · sorted by performance</span>
              </div>
            </CardHeader>
            <CardContent className="px-0 py-0">
              <div className="divide-y divide-gray-50">
                {sortedMembers.map((m) => (
                  <MemberCard key={m.id} m={m} drill={`/sales/team/${m.id}`} />
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
