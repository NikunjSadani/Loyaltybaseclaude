'use client';

import React from 'react';
import { Wallet, TrendingUp as EarnedIcon, Gift, Target } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { formatPoints } from '@/lib/utils';
import { clampPercent, type ApiTeamMember } from '../../_lib/employee';

/* ─── Leaf member detail sheet ──────────────────────────────────────────────────
   Opened when a NON-manager (leaf) member row is tapped. Shows the member's identity
   plus a 4-stat grid drawn ENTIRELY from the leaderboard row data already in hand (no
   extra fetch) — points balance, earned this month, redeemed this month, and target +
   achievement. Honest: when a member has no target we say "No target set" rather than
   inventing a percentage. Rendered via the shared Radix-backed Modal. ───────────── */

function StatTile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
      <div className="flex items-center gap-1.5 text-gray-400">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1.5 text-base font-extrabold text-gray-900 leading-none">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

export function MemberDetailSheet({
  member,
  open,
  onOpenChange,
}: {
  member: ApiTeamMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hasTarget = member?.targetPoints != null && member.targetPoints > 0;
  const achievement = member?.achievedPct ?? 0; // DISPLAY value — uncapped (may exceed 100%)
  const barWidth = clampPercent(member?.achievedPct ?? null); // bar FILL only (0–100)

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={member?.name ?? 'Team member'}
      description={
        member ? `${member.roleName}${member.region ? ` · ${member.region}` : ''}` : undefined
      }
    >
      {member && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 font-mono">Emp {member.employeeCode}</p>

          <div className="grid grid-cols-2 gap-2.5">
            <StatTile
              icon={<Wallet className="h-3.5 w-3.5" />}
              label="Points balance"
              value={`${formatPoints(member.pointsBalance)}`}
              sub="redeemable"
            />
            <StatTile
              icon={<EarnedIcon className="h-3.5 w-3.5" />}
              label="Earned this month"
              value={`${formatPoints(member.earnedThisMonth)}`}
              sub="pts"
            />
            <StatTile
              icon={<Gift className="h-3.5 w-3.5" />}
              label="Redeemed this month"
              value={`${formatPoints(member.redeemedThisMonth)}`}
              sub="pts"
            />
            <StatTile
              icon={<Target className="h-3.5 w-3.5" />}
              label="Target"
              value={hasTarget ? `${achievement}%` : '—'}
              sub={
                hasTarget
                  ? `of ${formatPoints(member.targetPoints as number)} pts`
                  : 'No target set'
              }
            />
          </div>

          {hasTarget && (
            <div>
              <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--brand-primary)] transition-all"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-gray-500">
                {achievement}% of a {formatPoints(member.targetPoints as number)} pts target
              </p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default MemberDetailSheet;
