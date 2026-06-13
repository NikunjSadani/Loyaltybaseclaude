'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Trophy, Medal, ArrowLeft, TrendingUp, MapPin, Globe, Map } from 'lucide-react';
import Link from 'next/link';
import { formatPoints } from '@/lib/utils';
import { useClientConfig } from '@/lib/platform/client-config-context';

type Scope = 'india' | 'state' | 'district';

/**
 * primaryKpiLabel — the name of the KPI this outlet is ranked on (its primary / headline KPI).
 * primaryKpiValue — the ABSOLUTE value achieved for that KPI this period (not % of target).
 * Ranking is by primaryKpiValue descending so outlets with higher real-world output rank higher,
 * regardless of how easy or hard their individual targets are.
 */
interface Partner {
  name: string;
  city: string;
  district: string;
  state: string;
  primaryKpiLabel: string;
  primaryKpiValue: number;
  change: number;
  isMe?: boolean;
}

// My location
const MY = { state: 'Maharashtra', district: 'Pune' };

/** Primary KPI for wholesalers = Secondary Sales Volume (cases dispatched to sub-stockists) */
const PRIMARY_KPI = 'Secondary Sales Volume';

const ALL_PARTNERS: Partner[] = [
  { name: 'Sharma General Store',  city: 'Mumbai',      district: 'Mumbai City',  state: 'Maharashtra',   primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 18420, change: +2 },
  { name: 'Patel Wholesale Hub',   city: 'Ahmedabad',   district: 'Ahmedabad',    state: 'Gujarat',        primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 16890, change:  0 },
  { name: 'Reddy Distributors',    city: 'Hyderabad',   district: 'Hyderabad',    state: 'Telangana',      primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 15340, change: +1 },
  { name: 'Singh Trade Centre',    city: 'Delhi',       district: 'Central Delhi', state: 'Delhi',          primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 14200, change: -1 },
  { name: 'Meena Enterprises',     city: 'Jaipur',      district: 'Jaipur',       state: 'Rajasthan',      primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 13750, change: +3 },
  { name: 'Nair & Co.',            city: 'Kochi',       district: 'Ernakulam',    state: 'Kerala',         primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 12980, change: -2 },
  { name: 'Gupta Brothers',        city: 'Lucknow',     district: 'Lucknow',      state: 'Uttar Pradesh',  primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 12100, change:  0 },
  { name: 'Venkat Super Store',    city: 'Chennai',     district: 'Chennai',      state: 'Tamil Nadu',     primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 11450, change: +1 },
  { name: 'Iyer Provisions',       city: 'Coimbatore',  district: 'Coimbatore',   state: 'Tamil Nadu',     primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 10800, change: +4 },
  { name: 'Das Retail Mart',       city: 'Kolkata',     district: 'Kolkata',      state: 'West Bengal',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue: 10200, change: -1 },
  { name: 'Khanna Traders',        city: 'Chandigarh',  district: 'Chandigarh',   state: 'Chandigarh',     primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  9750, change:  0 },
  { name: 'Kapoor Stores',         city: 'Pune',        district: 'Pune',         state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  9300, change: +1 },
  { name: 'Bose Distributors',     city: 'Kolkata',     district: 'Kolkata',      state: 'West Bengal',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  8100, change: -1 },
  { name: 'Pillai Wholesale',      city: 'Trivandrum',  district: 'Trivandrum',   state: 'Kerala',         primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  7680, change:  0 },
  { name: 'Agarwal Super Mart',    city: 'Indore',      district: 'Indore',       state: 'Madhya Pradesh', primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  7200, change: +1 },
  { name: 'Joshi Provisions',      city: 'Nashik',      district: 'Nashik',       state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  7100, change: -1 },
  { name: 'Kulkarni & Sons',       city: 'Pune',        district: 'Pune',         state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  6900, change: +2 },
  { name: 'My Store (You)',        city: 'Pune',        district: 'Pune',         state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  6550, change: +2, isMe: true },
  { name: 'Deshpande Mart',        city: 'Pune',        district: 'Pune',         state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  6200, change:  0 },
  { name: 'Sawant Enterprises',    city: 'Kolhapur',    district: 'Kolhapur',     state: 'Maharashtra',    primaryKpiLabel: PRIMARY_KPI, primaryKpiValue:  5800, change: -2 },
];

// Totals per scope for subtitle
const SCOPE_TOTALS: Record<Scope, number> = { india: 248, state: 63, district: 12 };

function RankMedal({ rank }: { rank: number }) {
  if (rank === 1) return <Trophy className="h-4 w-4 text-yellow-500" />;
  if (rank === 2) return <Medal className="h-4 w-4 text-gray-400" />;
  if (rank === 3) return <Medal className="h-4 w-4 text-amber-600" />;
  return <span className="text-sm font-bold text-gray-500 w-4 text-center inline-block">{rank}</span>;
}

const SCOPE_CONFIG: Record<Scope, { label: string; icon: React.ReactNode; sublabel: string }> = {
  india:    { label: 'Pan India',  icon: <Globe className="h-3.5 w-3.5" />,  sublabel: 'All partners nationwide' },
  state:    { label: 'State',      icon: <Map className="h-3.5 w-3.5" />,    sublabel: MY.state },
  district: { label: 'District',   icon: <MapPin className="h-3.5 w-3.5" />, sublabel: MY.district },
};

interface ApiLeaderboardEntry {
  rank: number;
  partnerId: string;
  partnerName: string;
  score: number;
  rankChange: number | null;
}

function mapApiLeaderboard(
  entries: ApiLeaderboardEntry[],
  currentPartnerId: string | null,
): Partner[] {
  return entries.map(e => ({
    name:            e.partnerName,
    city:            e.partnerName, // city column shows partner name when location not available
    district:        '',
    state:           '',
    primaryKpiLabel: 'Score',
    primaryKpiValue: e.score,
    change:          e.rankChange ?? 0,
    isMe:            currentPartnerId !== null && e.partnerId === currentPartnerId,
  }));
}

export default function LeaderboardPage() {
  const { features } = useClientConfig();
  const [scope, setScope] = useState<Scope>('india');
  const [partners, setPartners] = useState<Partner[]>(ALL_PARTNERS);
  // When API data is loaded, state/district are not available — disable those scope tabs
  const [hasLocationData, setHasLocationData] = useState(true);

  useEffect(() => {
    if (!features.partnerApp.showLeaderboard) return;
    fetch('/api/leaderboard')
      .then(r => r.json())
      .then((json: { success: boolean; data?: { leaderboard: ApiLeaderboardEntry[]; currentPartnerId?: string | null } }) => {
        if (json.success && json.data?.leaderboard && json.data.leaderboard.length > 0) {
          const currentPartnerId = json.data.currentPartnerId ?? null;
          setPartners(mapApiLeaderboard(json.data.leaderboard, currentPartnerId));
          // API entries have no state/district — disable those scope tabs to avoid empty views
          setHasLocationData(false);
          if (scope !== 'india') setScope('india');
        }
        // On empty or error response: keep ALL_PARTNERS as fallback
      })
      .catch(() => {}); // silent — initial mock data kept on failure
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    let list = partners;
    if (hasLocationData && scope === 'state')    list = list.filter(p => p.state === MY.state);
    if (hasLocationData && scope === 'district') list = list.filter(p => p.district === MY.district);
    // Re-rank after filter — sorted by ABSOLUTE primary KPI value (highest = rank 1)
    return list
      .slice()
      .sort((a, b) => b.primaryKpiValue - a.primaryKpiValue)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }, [scope, partners]);

  const myEntry = filtered.find((e) => e.isMe);
  const top3 = filtered.slice(0, 3);
  const nextRankEntry = myEntry && myEntry.rank > 1 ? filtered[myEntry.rank - 2] : null;
  const kpiGapToNext  = nextRankEntry ? nextRankEntry.primaryKpiValue - myEntry!.primaryKpiValue : null;

  // Feature-flag gate — all hooks called above; safe to return early now
  if (!features.partnerApp.showLeaderboard) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
        <Trophy className="h-10 w-10 text-gray-300" />
        <p className="text-base font-semibold text-gray-500">Leaderboard not available</p>
        <p className="text-sm text-gray-400">This feature is not enabled for your account.</p>
        <Link href="/partner/dashboard" className="mt-2 text-sm text-[var(--brand-primary)] font-medium hover:underline">
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/partner/dashboard" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-lg font-bold text-gray-900">Leaderboard</h1>
          <p className="text-xs text-gray-500">
            Monthly ranking · Resets 1 Jun · {SCOPE_CONFIG[scope].sublabel}
          </p>
        </div>
      </div>

      {/* Scope filter tabs */}
      <div className="flex gap-2 bg-gray-100 rounded-xl p-1">
        {(Object.keys(SCOPE_CONFIG) as Scope[]).map((s) => {
          const disabled = !hasLocationData && s !== 'india';
          return (
            <button
              key={s}
              onClick={() => !disabled && setScope(s)}
              disabled={disabled}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all ${
                disabled
                  ? 'text-gray-300 cursor-not-allowed'
                  : scope === s
                    ? 'bg-white text-[var(--brand-primary)] shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {SCOPE_CONFIG[s].icon}
              {SCOPE_CONFIG[s].label}
            </button>
          );
        })}
      </div>

      {/* My rank summary — visual hero card; test IDs live on the full-list row instead */}
      {myEntry ? (
        <div className="bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-primary-dark)] rounded-2xl p-4 text-white flex items-center gap-4">
          <div className="w-14 h-14 bg-white/20 rounded-xl flex flex-col items-center justify-center flex-shrink-0">
            <Trophy className="h-5 w-5 text-amber-300" />
            <p className="text-xl font-extrabold leading-none mt-0.5">#{myEntry.rank}</p>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Your Rank · {SCOPE_CONFIG[scope].label}</p>
            <p className="text-xs text-white/60 mt-0.5">
              {SCOPE_TOTALS[scope]} partners · Monthly ranking
            </p>
            {myEntry.change !== 0 && (
              <div className="flex items-center gap-1 mt-1.5">
                <TrendingUp className="h-3 w-3 text-emerald-300" />
                <span className="text-xs text-emerald-300 font-medium">
                  {myEntry.change > 0 ? `↑ +${myEntry.change}` : `↓ ${myEntry.change}`} vs last month
                </span>
              </div>
            )}
            {kpiGapToNext !== null && kpiGapToNext > 0 && (
              <p className="text-[10px] text-amber-300 font-semibold mt-1">
                {formatPoints(kpiGapToNext)} to reach #{myEntry.rank - 1}
              </p>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xl font-bold">{formatPoints(myEntry.primaryKpiValue)}</p>
            <p className="text-xs text-white/60">{myEntry.primaryKpiLabel}</p>
          </div>
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-center">
          <p className="text-sm text-gray-500">You are not yet ranked in this scope.</p>
        </div>
      )}

      {/* Top 3 podium */}
      {top3.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {top3.map((entry) => (
            <div
              key={entry.rank}
              className={`bg-white rounded-xl border p-3 text-center ${
                entry.rank === 1 ? 'border-yellow-200 bg-yellow-50/40' : 'border-gray-200'
              } ${entry.isMe ? 'ring-2 ring-[var(--brand-primary)]/30' : ''}`}
            >
              <div className="flex justify-center"><RankMedal rank={entry.rank} /></div>
              <p className={`text-[11px] font-semibold mt-1 leading-tight ${
                entry.isMe ? 'text-[var(--brand-primary)]' : 'text-gray-800'
              }`}>
                {entry.isMe ? entry.name : entry.city}
              </p>
              {entry.isMe && <p className="text-[10px] text-gray-400">{entry.city}</p>}
              <p className="text-xs font-bold text-[var(--brand-primary)] mt-1">{formatPoints(entry.primaryKpiValue)}</p>
              <p className="text-[10px] text-gray-400">{entry.primaryKpiLabel}</p>
            </div>
          ))}
        </div>
      )}

      {/* Full rankings list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-800">All Rankings</p>
          <span className="text-xs text-gray-400">{filtered.length} partners</span>
        </div>
        <div className="divide-y divide-gray-50">
          {filtered.map((entry) => (
            <div
              data-testid={entry.isMe ? 'lb-my-rank-card' : 'lb-row'}
              key={`${entry.name}-${entry.rank}`}
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                entry.isMe ? 'bg-red-50 border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-gray-50'
              }`}
            >
              <div className="w-5 flex items-center justify-center flex-shrink-0">
                <RankMedal rank={entry.rank} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold truncate ${entry.isMe ? 'text-[var(--brand-primary)]' : 'text-gray-900'}`}>
                  {entry.isMe ? entry.name : entry.city}
                  {entry.isMe && <span className="ml-1.5 text-[10px] font-medium text-emerald-600 bg-emerald-100 rounded-full px-1.5 py-0.5">You</span>}
                </p>
                {entry.isMe
                  ? <p className="text-xs text-gray-400">{entry.city}{scope === 'india' ? `, ${entry.state}` : ''}</p>
                  : scope === 'india' && <p className="text-xs text-gray-400">{entry.state}</p>
                }
              </div>
              <div className="text-right flex-shrink-0">
                <p data-testid="lb-kpi-value" className="text-sm font-bold text-gray-900">{formatPoints(entry.primaryKpiValue)}</p>
                <p data-testid="lb-kpi-label" className="text-[10px] text-gray-400">{entry.primaryKpiLabel}</p>
                {entry.change !== 0 && (
                  <p className={`text-[10px] font-medium ${entry.change > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {entry.change > 0 ? `▲ +${entry.change}` : `▼ ${entry.change}`}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
