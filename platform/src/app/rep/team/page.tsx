'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { authHeader } from '@/lib/api-client';
import { mapTeam, type ApiTeamResponse, type Team } from '../_lib/employee';
import { TeamView } from './_components/team-view';

/* ─── REP Team (manager rollup) ─────────────────────────────────────────────────
   Fetches the CALLER's own downline (GET /api/rewards/employee/team, no managerId) and
   hands the mapped payload to <TeamView>. A non-manager / no-team caller comes back as
   { isManager:false, members:[] } and TeamView renders the friendly empty state — the
   Team tab still shows, just empty. Mirrors the rep screen idiom (envelope fetch,
   Spinner, error + Retry). ────────────────────────────────────────────────────── */

export default function RepTeamPage() {
  const [team, setTeam] = useState<Team | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/rewards/employee/team', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: ApiTeamResponse; error?: string }) => {
        if (json.success && json.data) {
          setTeam(mapTeam(json.data));
        } else {
          setError(json.error ?? 'Failed to load your team');
        }
      })
      .catch(() => setError('Failed to load your team'))
      .finally(() => setLoading(false));
  }, []);

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

  if (error || !team) {
    return (
      <div className="text-center py-10">
        <p className="text-sm text-red-500">{error ?? 'Failed to load your team'}</p>
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

  return <TeamView team={team} title="My Team" />;
}
