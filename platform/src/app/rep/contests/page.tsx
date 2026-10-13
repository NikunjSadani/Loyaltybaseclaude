'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trophy, Sparkles, CalendarDays } from 'lucide-react';
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
} from '../_lib/employee';

/* ─── REP Contests ────────────────────────────────────────────────────────────
   The ACTIVE / SCHEDULED contests this employee is eligible for. The backend already
   scopes the list to the viewer's role/region, so the FE just renders what comes back
   — no client-side filtering. Each card shows the banner (graceful fallback), a
   live/upcoming status badge, the IST date range, the bonus-points prize, and the
   contest description. Read-only (no join/opt-in rail in the pinned contract). ──── */

export default function RepContestsPage() {
  const router = useRouter();
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/rewards/employee/contests', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { contests: ApiEmployeeContest[] }; error?: string }) => {
        if (json.success && json.data) {
          setContests((json.data.contests ?? []).map(mapContest));
        } else {
          setError(json.error ?? 'Failed to load contests');
        }
      })
      .catch(() => setError('Failed to load contests'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Contests</h1>
          <p className="text-xs text-gray-500 mt-0.5">Earn bonus points by hitting contest goals</p>
        </div>
        {!loading && !error && contests.length > 0 && (
          <span className="text-sm text-gray-500 shrink-0">{contests.length}</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : error ? (
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
      ) : contests.length === 0 ? (
        <EmptyState
          icon={<Trophy className="h-8 w-8" />}
          title="No active contests right now"
          description="Check back soon — new contests will show up here when they go live."
        />
      ) : (
        <div className="space-y-4">
          {contests.map((contest) => {
            const badge = contestStatusBadge(contest.status);
            const dateRange = formatContestDateRange(contest.startDate, contest.endDate);
            return (
              <button
                key={contest.id}
                type="button"
                onClick={() => router.push(`/rep/contests/${contest.id}`)}
                className="w-full text-left bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-all active:scale-[0.99]"
              >
                {/* Banner — image if provided, else a brand-tinted gradient with a trophy. */}
                <div className="relative h-32 flex items-center justify-center bg-gray-50">
                  {contest.bannerUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={contest.bannerUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className="h-full w-full flex items-center justify-center"
                      style={{
                        background:
                          'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
                      }}
                    >
                      <Trophy className="h-10 w-10 text-white/80" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                </div>

                <div className="p-4 space-y-2">
                  <h2 className="text-sm font-bold text-gray-900 leading-snug">{contest.name}</h2>

                  {dateRange && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                      <span>{dateRange}</span>
                    </div>
                  )}

                  {contest.bonusPoints > 0 && (
                    <div className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
                      <Sparkles className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
                      <span className="text-xs font-bold text-[var(--brand-primary)]">
                        Win {formatPoints(contest.bonusPoints)} pts
                      </span>
                    </div>
                  )}

                  {contest.description && (
                    <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-line">
                      {contest.description}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
