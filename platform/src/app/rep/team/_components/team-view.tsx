'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Users,
  TrendingUp,
  TrendingDown,
  Minus,
  Gift,
  Target,
  Wallet,
  ChevronRight,
  BarChart3,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatPoints } from '@/lib/utils';
import { trendMeta, clampPercent, type Team, type ApiTeamMember, type TeamTrend } from '../../_lib/employee';
import { TeamEarnChart } from './team-earn-chart';
import { MemberDetailSheet } from './member-detail-sheet';

/* ─── TeamView ───────────────────────────────────────────────────────────────────
   The shared team screen rendered by BOTH the top-level /rep/team page and the drilled
   /rep/team/[memberId] sub-team page. Given a fetched + mapped `Team`, it renders:
     • a 4-stat rollup grid (earned / redeemed this month, avg achievement %, on-track),
     • a 6-month earned-vs-redeemed chart,
     • a leaderboard (pre-sorted by achievement desc, nulls last) where a MANAGER row
       drills into its sub-team (/rep/team/<id>) and a LEAF row opens a detail sheet.
   A caller with no team (isManager:false + no members) gets a friendly empty state —
   the Team tab still renders, just empty. ─────────────────────────────────────── */

const TREND_ICON: Record<TeamTrend, React.ReactNode> = {
  up: <TrendingUp className="h-3.5 w-3.5" />,
  down: <TrendingDown className="h-3.5 w-3.5" />,
  flat: <Minus className="h-3.5 w-3.5" />,
};

const TREND_TONE: Record<TeamTrend, string> = {
  up: 'text-emerald-600',
  down: 'text-red-500',
  flat: 'text-gray-400',
};

function RollupStat({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3 py-3 shadow-sm">
      <div className="flex items-center gap-1.5" style={{ color: accent ?? 'var(--brand-primary)' }}>
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </span>
      </div>
      <p className="mt-1.5 text-lg font-extrabold text-gray-900 leading-none">{value}</p>
    </div>
  );
}

function MemberRow({
  member,
  onOpenLeaf,
}: {
  member: ApiTeamMember;
  onOpenLeaf: (m: ApiTeamMember) => void;
}) {
  const router = useRouter();
  const hasTarget = member.targetPoints != null && member.targetPoints > 0;
  const barWidth = clampPercent(member.achievedPct); // bar FILL only (0–100)
  const achievement = member.achievedPct ?? 0; // DISPLAY value — uncapped (may exceed 100%)
  const trend = trendMeta(member.trend);

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 leading-snug truncate">{member.name}</p>
          <p className="text-[11px] text-gray-500 truncate">
            {member.roleName}
            {member.region ? ` · ${member.region}` : ''}
          </p>
        </div>
        <div className={`flex items-center gap-1 shrink-0 ${TREND_TONE[trend.tone]}`} title={trend.label}>
          {TREND_ICON[trend.direction]}
          <span className="text-xs font-bold text-gray-900">
            {hasTarget ? `${achievement}%` : '—'}
          </span>
        </div>
      </div>

      {/* Target progress bar */}
      <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--brand-primary)] transition-all"
          style={{ width: `${hasTarget ? barWidth : 0}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-500">
          <span className="font-semibold text-gray-700">{formatPoints(member.pointsBalance)}</span> pts
        </span>
        {member.isManager ? (
          <span className="flex items-center gap-0.5 text-[11px] font-semibold text-[var(--brand-primary)]">
            Team of {formatPoints(Math.max(0, member.teamSize - 1))} · tap to view
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="text-[11px] text-gray-400">
            +{formatPoints(member.earnedThisMonth)} this month
          </span>
        )}
      </div>
    </>
  );

  const cls =
    'w-full text-left rounded-xl border border-gray-200 bg-white px-3.5 py-3 shadow-sm hover:shadow-md active:scale-[0.99] transition-all';

  if (member.isManager) {
    return (
      <button type="button" onClick={() => router.push(`/rep/team/${member.salesUserId}`)} className={cls}>
        {inner}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => onOpenLeaf(member)} className={cls}>
      {inner}
    </button>
  );
}

export function TeamView({
  team,
  backHref,
  backLabel = 'Back to Team',
  title = 'My Team',
}: {
  team: Team;
  backHref?: string;
  backLabel?: string;
  title?: string;
}) {
  const [selected, setSelected] = useState<ApiTeamMember | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const openLeaf = (m: ApiTeamMember) => {
    setSelected(m);
    setSheetOpen(true);
  };

  const { rollup, members, monthly, root } = team;
  const noTeam = !team.isManager && members.length === 0;

  return (
    <div className="space-y-5 fade-in">
      {backHref && (
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
      )}

      <div>
        <h1 className="text-lg font-bold text-gray-900">{title}</h1>
        {root ? (
          <p className="text-xs text-gray-500 mt-0.5">
            {root.name} · {root.roleName}
          </p>
        ) : (
          <p className="text-xs text-gray-500 mt-0.5">Your downline at a glance</p>
        )}
      </div>

      {noTeam ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="You don't have a team yet"
          description="When team members report to you, you'll see their rollup, trends and a leaderboard here."
        />
      ) : (
        <>
          {/* ── 4-stat rollup grid ── */}
          <div className="grid grid-cols-2 gap-2.5">
            <RollupStat
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Earned this month"
              value={`${formatPoints(rollup.earnedThisMonth)}`}
            />
            <RollupStat
              icon={<Gift className="h-3.5 w-3.5" />}
              label="Redeemed this month"
              value={`${formatPoints(rollup.redeemedThisMonth)}`}
              accent="#7c3aed"
            />
            <RollupStat
              icon={<Target className="h-3.5 w-3.5" />}
              label="Avg achievement"
              value={`${rollup.avgAchievementPct}%`}
              accent="#1d4ed8"
            />
            <RollupStat
              icon={<Users className="h-3.5 w-3.5" />}
              label="On track"
              value={`${formatPoints(rollup.onTrackCount)} of ${formatPoints(rollup.memberCount)}`}
              accent="#059669"
            />
          </div>

          {/* ── Earned vs redeemed chart ── */}
          <Card>
            <CardContent className="px-4 py-4">
              <div className="flex items-center gap-1.5 mb-3">
                <BarChart3 className="h-4 w-4 text-[var(--brand-primary)]" />
                <p className="text-sm font-bold text-gray-900">Team earned vs redeemed</p>
              </div>
              <TeamEarnChart monthly={monthly} />
            </CardContent>
          </Card>

          {/* ── Leaderboard ── */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-1.5">
                <Wallet className="h-4 w-4 text-[var(--brand-primary)]" />
                <p className="text-sm font-bold text-gray-900">Leaderboard</p>
              </div>
              <span className="text-xs text-gray-400">{members.length}</span>
            </div>

            {members.length === 0 ? (
              <EmptyState
                icon={<Users className="h-8 w-8" />}
                title="No members to show"
                description="This team has no members with activity yet."
              />
            ) : (
              <div className="space-y-2.5">
                {members.map((m) => (
                  <MemberRow key={m.salesUserId} member={m} onOpenLeaf={openLeaf} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <MemberDetailSheet member={selected} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}

export default TeamView;
