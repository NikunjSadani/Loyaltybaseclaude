'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { authHeader } from '@/lib/api-client';
import { mapTeam, type ApiTeamResponse, type Team } from '../../_lib/employee';
import { TeamView } from '../_components/team-view';

/* ─── REP sub-team (drill into a manager's downline) ────────────────────────────
   Fetches GET /api/rewards/employee/team?managerId=<memberId> → <TeamView> with a back
   link to /rep/team. The backend enforces that <memberId> is INSIDE the caller's own
   subtree; drilling outside it (a hand-typed / stale id) returns 403/400, which we
   surface as a calm "can't view this team" state rather than a raw error. ───────── */

export default function RepSubTeamPage() {
  const params = useParams();
  const memberId = String(params?.memberId ?? '');

  const [team, setTeam] = useState<Team | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    if (!memberId) return;
    setLoading(true);
    setError(null);
    setForbidden(false);

    let status = 0;
    fetch(`/api/rewards/employee/team?managerId=${encodeURIComponent(memberId)}`, {
      headers: { ...authHeader() },
    })
      .then((r) => {
        status = r.status;
        return r.json();
      })
      .then((json: { success?: boolean; data?: ApiTeamResponse; error?: string }) => {
        if (json.success && json.data) {
          setTeam(mapTeam(json.data));
        } else if (status === 403 || status === 400) {
          setForbidden(true);
        } else {
          setError(json.error ?? 'Failed to load this team');
        }
      })
      .catch(() => setError('Failed to load this team'))
      .finally(() => setLoading(false));
  }, [memberId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center gap-4 fade-in">
        <div className="p-4 bg-gray-100 rounded-full text-gray-400">
          <ShieldOff className="h-8 w-8" />
        </div>
        <div>
          <p className="text-base font-semibold text-gray-900">This team isn&apos;t in your downline</p>
          <p className="text-sm text-gray-500 mt-1 max-w-sm">
            You can only view the teams that report up to you.
          </p>
        </div>
        <Link
          href="/rep/team"
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Team
        </Link>
      </div>
    );
  }

  if (error || !team) {
    return (
      <div className="text-center py-10 fade-in">
        <Link
          href="/rep/team"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Team
        </Link>
        <p className="text-sm text-red-500">{error ?? 'Failed to load this team'}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          Retry
        </button>
      </div>
    );
  }

  return <TeamView team={team} backHref="/rep/team" title={team.root?.name ?? 'Sub-team'} />;
}
