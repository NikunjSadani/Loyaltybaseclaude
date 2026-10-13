'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Trophy, Sparkles, CalendarDays, Users, MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import {
  mapContest,
  formatContestDateRange,
  contestStatusBadge,
  type ApiEmployeeContest,
  type Contest,
} from '../../_lib/employee';

/* ─── REP Contest detail ──────────────────────────────────────────────────────
   A single contest the employee is eligible for. Our contests are MANUAL (no live
   progress / leaderboard), so the detail shows the same facts as the list card —
   banner, status, duration, the bonus prize, eligibility, and the full description —
   in a roomier layout. Resolved from the (unpaginated, already role/region-scoped)
   employee contests list; a tap always originates from that list or the Home
   carousel, so the contest is present. A direct link to a contest no longer
   active/scheduled for this employee resolves to a friendly "not available". ──── */

export default function RepContestDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [contest, setContest] = useState<Contest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/rewards/employee/contests', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { contests: ApiEmployeeContest[] }; error?: string }) => {
        if (json.success && json.data) {
          const found = (json.data.contests ?? []).map(mapContest).find((c) => c.id === id);
          setContest(found ?? null);
        } else {
          setError(json.error ?? 'Failed to load this contest');
        }
      })
      .catch(() => setError('Failed to load this contest'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const Back = (
    <button
      type="button"
      onClick={() => router.push('/rep/contests')}
      className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
    >
      <ArrowLeft className="h-4 w-4" /> Contests
    </button>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5 fade-in">
        {Back}
        <div className="text-center py-8">
          <p className="text-sm text-red-500">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!contest) {
    return (
      <div className="space-y-5 fade-in">
        {Back}
        <EmptyState
          icon={<Trophy className="h-8 w-8" />}
          title="Contest not available"
          description="This contest isn't running for you right now. Check the Contests list for what's live."
        />
      </div>
    );
  }

  const badge = contestStatusBadge(contest.status);
  const dateRange = formatContestDateRange(contest.startDate, contest.endDate);

  return (
    <div className="space-y-5 fade-in">
      {Back}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
        {/* Banner */}
        <div className="relative h-40 flex items-center justify-center bg-gray-50">
          {contest.bannerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contest.bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div
              className="h-full w-full flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
              }}
            >
              <Trophy className="h-12 w-12 text-white/80" />
            </div>
          )}
          <div className="absolute top-2 right-2">
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <h1 className="text-lg font-bold text-gray-900 leading-snug">{contest.name}</h1>

          {dateRange && (
            <div className="flex items-center gap-1.5 text-sm text-gray-600">
              <CalendarDays className="h-4 w-4 shrink-0 text-gray-400" />
              <span>{dateRange}</span>
            </div>
          )}

          {contest.bonusPoints > 0 && (
            <div className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
              <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" />
              <span className="text-sm font-bold text-[var(--brand-primary)]">
                Win {formatPoints(contest.bonusPoints)} pts
              </span>
            </div>
          )}

          {contest.description && (
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
              {contest.description}
            </p>
          )}

          {/* Eligibility — the backend already scopes the list to this employee, so this is
              informational (who the contest is for). Empty list = open to everyone. */}
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="flex items-start gap-2 text-xs text-gray-500">
              <Users className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
              <span>
                {contest.eligibleRoleCodes.length > 0
                  ? `For: ${contest.eligibleRoleCodes.join(', ')}`
                  : 'Open to all roles'}
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-gray-500">
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
              <span>
                {contest.eligibleRegions.length > 0
                  ? `Regions: ${contest.eligibleRegions.join(', ')}`
                  : 'All regions'}
              </span>
            </div>
          </div>

          <p className="text-[11px] text-gray-400 pt-1">
            Winners are credited by your admin after the contest ends.
          </p>
        </div>
      </div>
    </div>
  );
}
