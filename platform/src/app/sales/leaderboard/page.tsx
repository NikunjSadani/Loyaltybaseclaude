'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Trophy, Medal, TrendingUp, TrendingDown, Minus, Users, MapPin } from 'lucide-react';
import { getRole, ROLE_NAMES, ROLE_TERRITORY, type SalesRole } from '@/lib/sales-role';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface SalesEntry {
  name:           string;
  territory:      string;
  achievementPct: number;
  activeOutlets:  number;
  change:         number;   // rank vs last month (+ve = moved up)
  isMe?:          boolean;
}

type ScopeFilter = 'rm' | 'state' | 'national';

const SCOPE_LABELS: Record<ScopeFilter, string> = {
  rm:       'Reporting Mgr',
  state:    'State',
  national: 'National',
};

/* ─── Mock data — three scopes per role ──────────────────────────────────────── */

const PEERS: Record<SalesRole, Record<ScopeFilter, SalesEntry[]>> = {
  /* ─── XSR — source of truth: MOCK_XSRS in team/page.tsx ─── */
  XSR: {
    // Exact 4 XSRs under SO Rajesh Kumar (Mumbai West)
    rm: [
      { name: 'Kiran Rao',    territory: 'Versova Beat',  achievementPct: 91, activeOutlets: 11, change: +1 },
      { name: 'Anil Sharma',  territory: 'Andheri Beat',  achievementPct: 82, activeOutlets: 18, change: +1, isMe: true },
      { name: 'Divya Pillai', territory: 'Juhu Beat',     achievementPct: 58, activeOutlets: 14, change: -2 },
      { name: 'Meena Joshi',  territory: 'DN Nagar Beat', achievementPct: 44, activeOutlets: 16, change:  0 },
    ],
    // Maharashtra: rm members + broader state XSRs
    state: [
      { name: 'Varun Kulkarni', territory: 'Pune Central',   achievementPct: 118, activeOutlets: 52, change: +3 },
      { name: 'Deepak Rane',    territory: 'Versova Beat',   achievementPct: 112, activeOutlets: 48, change: +2 },
      { name: 'Swati Pawar',    territory: 'Juhu Beat',      achievementPct: 104, activeOutlets: 44, change:  0 },
      { name: 'Manish Shinde',  territory: 'Nagpur East',    achievementPct: 101, activeOutlets: 43, change: +1 },
      { name: 'Kiran Rao',      territory: 'Versova Beat',   achievementPct:  91, activeOutlets: 11, change: +1 },
      { name: 'Anil Sharma',    territory: 'Andheri Beat',   achievementPct:  82, activeOutlets: 18, change: +1, isMe: true },
      { name: 'Rahul Desai',    territory: 'Goregaon Beat',  achievementPct:  76, activeOutlets: 36, change: -2 },
      { name: 'Divya Pillai',   territory: 'Juhu Beat',      achievementPct:  58, activeOutlets: 14, change: -2 },
      { name: 'Suresh Gaikwad', territory: 'Nashik West',    achievementPct:  51, activeOutlets: 30, change:  0 },
      { name: 'Meena Joshi',    territory: 'DN Nagar Beat',  achievementPct:  44, activeOutlets: 16, change:  0 },
      { name: 'Nitin More',     territory: 'Kandivali Beat', achievementPct:  39, activeOutlets: 28, change:  0 },
    ],
    national: [
      { name: 'Pradeep Iyer',   territory: 'Bengaluru Central', achievementPct: 124, activeOutlets: 58, change: +4 },
      { name: 'Lakshmi Nair',   territory: 'Chennai South',     achievementPct: 119, activeOutlets: 55, change: +2 },
      { name: 'Varun Kulkarni', territory: 'Pune Central',      achievementPct: 118, activeOutlets: 52, change: +3 },
      { name: 'Deepak Rane',    territory: 'Versova Beat',      achievementPct: 112, activeOutlets: 48, change: +2 },
      { name: 'Swati Pawar',    territory: 'Juhu Beat',         achievementPct: 104, activeOutlets: 44, change:  0 },
      { name: 'Manish Shinde',  territory: 'Nagpur East',       achievementPct: 101, activeOutlets: 43, change: +1 },
      { name: 'Kiran Rao',      territory: 'Versova Beat',      achievementPct:  91, activeOutlets: 11, change: +1 },
      { name: 'Rajan Pillai',   territory: 'Kochi Beat',        achievementPct:  86, activeOutlets: 40, change: -1 },
      { name: 'Anil Sharma',    territory: 'Andheri Beat',      achievementPct:  82, activeOutlets: 18, change: +1, isMe: true },
      { name: 'Rahul Desai',    territory: 'Goregaon Beat',     achievementPct:  76, activeOutlets: 36, change: -2 },
      { name: 'Divya Pillai',   territory: 'Juhu Beat',         achievementPct:  58, activeOutlets: 14, change: -2 },
      { name: 'Suresh Gaikwad', territory: 'Nashik West',       achievementPct:  51, activeOutlets: 30, change:  0 },
      { name: 'Meena Joshi',    territory: 'DN Nagar Beat',     achievementPct:  44, activeOutlets: 16, change:  0 },
      { name: 'Pawan Mishra',   territory: 'Delhi North',       achievementPct:  41, activeOutlets: 23, change: -1 },
      { name: 'Nitin More',     territory: 'Kandivali Beat',    achievementPct:  39, activeOutlets: 28, change:  0 },
    ],
  },

  /* ─── SO — source of truth: MOCK_SOS in team/page.tsx ─── */
  SO: {
    // Exact 4 SOs under ASM Priya Mehta (Mumbai Zone)
    rm: [
      { name: 'Sunita Desai', territory: 'Navi Mumbai', achievementPct: 93, activeOutlets:  38, change:  0 },
      { name: 'Nisha Verma',  territory: 'Mumbai East', achievementPct: 88, activeOutlets:  47, change: +2 },
      { name: 'Rajesh Kumar', territory: 'Mumbai West', achievementPct: 76, activeOutlets:  59, change: -1, isMe: true },
      { name: 'Arjun Patil',  territory: 'Thane City',  achievementPct: 55, activeOutlets:  52, change: -1 },
    ],
    state: [
      { name: 'Smita Wagh',     territory: 'Mumbai Central', achievementPct: 108, activeOutlets: 71, change: +1 },
      { name: 'Amey Joshi',     territory: 'Pune West',      achievementPct: 105, activeOutlets: 68, change: +2 },
      { name: 'Sunita Desai',   territory: 'Navi Mumbai',    achievementPct:  93, activeOutlets: 38, change:  0 },
      { name: 'Nisha Verma',    territory: 'Mumbai East',    achievementPct:  88, activeOutlets: 47, change: +2 },
      { name: 'Harish Tawde',   territory: 'Mumbai North',   achievementPct:  84, activeOutlets: 63, change: -1 },
      { name: 'Rajesh Kumar',   territory: 'Mumbai West',    achievementPct:  76, activeOutlets: 59, change: -1, isMe: true },
      { name: 'Sandesh More',   territory: 'Nashik',         achievementPct:  69, activeOutlets: 55, change:  0 },
      { name: 'Arjun Patil',    territory: 'Thane City',     achievementPct:  55, activeOutlets: 52, change: -1 },
      { name: 'Tushar Bhosale', territory: 'Aurangabad',     achievementPct:  48, activeOutlets: 44, change: -2 },
    ],
    national: [
      { name: 'Venkat Raman',   territory: 'Bengaluru North', achievementPct: 114, activeOutlets:  82, change: +3 },
      { name: 'Smita Wagh',     territory: 'Mumbai Central',  achievementPct: 108, activeOutlets:  71, change: +1 },
      { name: 'Amey Joshi',     territory: 'Pune West',       achievementPct: 105, activeOutlets:  68, change: +2 },
      { name: 'Sunita Desai',   territory: 'Navi Mumbai',     achievementPct:  93, activeOutlets:  38, change:  0 },
      { name: 'Nisha Verma',    territory: 'Mumbai East',     achievementPct:  88, activeOutlets:  47, change: +2 },
      { name: 'Harish Tawde',   territory: 'Mumbai North',    achievementPct:  84, activeOutlets:  63, change: -1 },
      { name: 'Sunita Sharma',  territory: 'Delhi East',      achievementPct:  81, activeOutlets:  60, change:  0 },
      { name: 'Rajesh Kumar',   territory: 'Mumbai West',     achievementPct:  76, activeOutlets:  59, change: -1, isMe: true },
      { name: 'Sandesh More',   territory: 'Nashik',          achievementPct:  69, activeOutlets:  55, change:  0 },
      { name: 'Arjun Patil',    territory: 'Thane City',      achievementPct:  55, activeOutlets:  52, change: -1 },
      { name: 'Tushar Bhosale', territory: 'Aurangabad',      achievementPct:  48, activeOutlets:  44, change: -2 },
      { name: 'Karthik Menon',  territory: 'Chennai Central', achievementPct:  43, activeOutlets:  41, change: -1 },
    ],
  },

  /* ─── ASM — source of truth: MOCK_ASMS in team/page.tsx ─── */
  ASM: {
    // Exact 4 ASMs under RSM Suresh Nair (Maharashtra)
    rm: [
      { name: 'Priya Mehta',     territory: 'Mumbai Zone', achievementPct: 78, activeOutlets: 196, change:  0, isMe: true },
      { name: 'Sonal Agrawal',   territory: 'Nashik Zone', achievementPct: 71, activeOutlets:  98, change:  0 },
      { name: 'Rohit Deshpande', territory: 'Pune Zone',   achievementPct: 64, activeOutlets: 143, change: -2 },
      { name: 'Vikram Bhosale',  territory: 'Nagpur Zone', achievementPct: 57, activeOutlets:  74, change: -1 },
    ],
    state: [
      { name: 'Priya Mehta',     territory: 'Mumbai Zone',   achievementPct: 78, activeOutlets: 196, change:  0, isMe: true },
      { name: 'Sonal Agrawal',   territory: 'Nashik Zone',   achievementPct: 71, activeOutlets:  98, change:  0 },
      { name: 'Rohit Deshpande', territory: 'Pune Zone',     achievementPct: 64, activeOutlets: 143, change: -2 },
      { name: 'Vikram Bhosale',  territory: 'Nagpur Zone',   achievementPct: 57, activeOutlets:  74, change: -1 },
      { name: 'Meera Deshpande', territory: 'Solapur Zone',  achievementPct: 52, activeOutlets:  62, change: -2 },
      { name: 'Vijay Salunkhe',  territory: 'Kolhapur Zone', achievementPct: 47, activeOutlets:  55, change:  0 },
    ],
    national: [
      { name: 'Ravi Shankar',    territory: 'Karnataka North', achievementPct: 91, activeOutlets: 218, change: +3 },
      { name: 'Priya Mehta',     territory: 'Mumbai Zone',     achievementPct: 78, activeOutlets: 196, change:  0, isMe: true },
      { name: 'Sonal Agrawal',   territory: 'Nashik Zone',     achievementPct: 71, activeOutlets:  98, change:  0 },
      { name: 'Rohit Deshpande', territory: 'Pune Zone',       achievementPct: 64, activeOutlets: 143, change: -2 },
      { name: 'Vikram Bhosale',  territory: 'Nagpur Zone',     achievementPct: 57, activeOutlets:  74, change: -1 },
      { name: 'Arun Krishnan',   territory: 'Hyderabad Zone',  achievementPct: 54, activeOutlets:  81, change: -1 },
      { name: 'Meera Deshpande', territory: 'Solapur Zone',    achievementPct: 52, activeOutlets:  62, change: -2 },
      { name: 'Vijay Salunkhe',  territory: 'Kolhapur Zone',   achievementPct: 47, activeOutlets:  55, change:  0 },
    ],
  },

  /* ─── RSM — source of truth: MOCK_RSMS in team/page.tsx ─── */
  RSM: {
    // Exact 4 RSMs under ZM Vikram Singh (West Zone)
    rm: [
      { name: 'Deepak Tiwari', territory: 'Gujarat',     achievementPct: 81, activeOutlets: 289, change: +2 },
      { name: 'Ananya Bose',   territory: 'Rajasthan',   achievementPct: 74, activeOutlets: 267, change:  0 },
      { name: 'Suresh Nair',   territory: 'Maharashtra', achievementPct: 72, activeOutlets: 511, change: -1, isMe: true },
      { name: 'Leela Iyer',    territory: 'Karnataka',   achievementPct: 68, activeOutlets: 342, change: -1 },
    ],
    state: [
      { name: 'Deepak Tiwari', territory: 'Gujarat',     achievementPct: 81, activeOutlets: 289, change: +2 },
      { name: 'Ananya Bose',   territory: 'Rajasthan',   achievementPct: 74, activeOutlets: 267, change:  0 },
      { name: 'Suresh Nair',   territory: 'Maharashtra', achievementPct: 72, activeOutlets: 511, change: -1, isMe: true },
      { name: 'Leela Iyer',    territory: 'Karnataka',   achievementPct: 68, activeOutlets: 342, change: -1 },
    ],
    national: [
      { name: 'Rajiv Menon',   territory: 'Tamil Nadu',     achievementPct: 88, activeOutlets: 410, change: +2 },
      { name: 'Deepak Tiwari', territory: 'Gujarat',        achievementPct: 81, activeOutlets: 289, change: +2 },
      { name: 'Pradeep Kumar', territory: 'Delhi NCR',      achievementPct: 77, activeOutlets: 380, change:  0 },
      { name: 'Ananya Bose',   territory: 'Rajasthan',      achievementPct: 74, activeOutlets: 267, change:  0 },
      { name: 'Suresh Nair',   territory: 'Maharashtra',    achievementPct: 72, activeOutlets: 511, change: -1, isMe: true },
      { name: 'Anand Verma',   territory: 'Uttar Pradesh',  achievementPct: 69, activeOutlets: 290, change: -1 },
      { name: 'Leela Iyer',    territory: 'Karnataka',      achievementPct: 68, activeOutlets: 342, change: -1 },
    ],
  },

  /* ─── ZNM — source of truth: MOCK_ZMS in team/page.tsx ─── */
  ZNM: {
    rm: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1, isMe: true },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
    state: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1, isMe: true },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
    national: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1, isMe: true },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
  },

  /* ─── NSM — sees MOCK_ZMS; no isMe (NSM is above the leaderboard) ─── */
  NSM: {
    rm: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1 },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
    state: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1 },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
    national: [
      { name: 'Vikram Singh',  territory: 'West Zone',  achievementPct: 74, activeOutlets: 1409, change: -1 },
      { name: 'Ravi Menon',    territory: 'South Zone', achievementPct: 71, activeOutlets: 1124, change: +2 },
      { name: 'Kavita Sharma', territory: 'North Zone', achievementPct: 68, activeOutlets:  987, change: +2 },
      { name: 'Arun Gupta',    territory: 'East Zone',  achievementPct: 66, activeOutlets:  834, change:  0 },
    ],
  },
};

/* ─── Scope sub-label ────────────────────────────────────────────────────────── */

const SCOPE_SUB: Record<SalesRole, Record<ScopeFilter, string>> = {
  XSR: { rm: 'Your SO\'s team · Mumbai West', state: 'Maharashtra · All XSRs', national: 'National · All XSRs' },
  SO:  { rm: 'Your ASM\'s team · Mumbai Zone', state: 'Maharashtra · All SOs',  national: 'National · All SOs'  },
  ASM: { rm: 'Your RSM\'s region · Maharashtra', state: 'Maharashtra · All ASMs', national: 'National · All ASMs' },
  RSM: { rm: 'Your ZM\'s zone · West Zone',    state: 'West Zone · All RSMs',   national: 'National · All RSMs' },
  ZNM: { rm: 'Pan-India · All Zones',          state: 'All Zones',              national: 'National · All ZNMs' },
  NSM: { rm: 'National overview',              state: 'All Zones',              national: 'National · All ZNMs' },
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function RankMedal({ rank }: { rank: number }) {
  if (rank === 1) return <Trophy className="h-4 w-4 text-yellow-500" />;
  if (rank === 2) return <Medal  className="h-4 w-4 text-gray-400"   />;
  if (rank === 3) return <Medal  className="h-4 w-4 text-amber-600"  />;
  return <span className="text-sm font-bold tabular-nums text-gray-500 w-4 text-center inline-block">{rank}</span>;
}

function ChangeChip({ change }: { change: number }) {
  if (change === 0) return <Minus className="h-3 w-3 text-gray-400" />;
  if (change > 0)   return (
    <span className="flex items-center gap-0.5 text-emerald-600 text-[11px] font-bold tabular-nums">
      <TrendingUp className="h-3 w-3" />+{change}
    </span>
  );
  return (
    <span className="flex items-center gap-0.5 text-red-500 text-[11px] font-bold tabular-nums">
      <TrendingDown className="h-3 w-3" />{change}
    </span>
  );
}

function pctColor(p: number) {
  return p >= 100 ? 'text-emerald-600' : p >= 85 ? 'text-amber-600' : 'text-red-500';
}
function pctBg(p: number) {
  return p >= 100 ? 'bg-emerald-50 text-emerald-700' : p >= 85 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-500';
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesLeaderboardPage() {
  const [role,  setRoleState] = useState<SalesRole>('SO');
  const [scope, setScope]     = useState<ScopeFilter>('rm');

  useEffect(() => {
    setRoleState(getRole());
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const ranked = useMemo(() => {
    const list = PEERS[role]?.[scope] ?? [];
    return [...list]
      .sort((a, b) => b.achievementPct - a.achievementPct)
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }, [role, scope]);

  const myEntry   = ranked.find((e) => e.isMe);
  const nextEntry = myEntry && myEntry.rank > 1 ? ranked[myEntry.rank - 2] : null;
  const ptsGap    = nextEntry ? nextEntry.achievementPct - myEntry!.achievementPct : null;

  return (
    <div className="space-y-4 fade-in">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">Leaderboard</h1>
        <p className="text-xs font-medium text-gray-500 mt-0.5">{SCOPE_SUB[role][scope]} · May 2026</p>
      </div>

      {/* ── Scope filter pills ── */}
      <div className="flex gap-2">
        {(['rm', 'state', 'national'] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`flex-1 py-2 rounded-xl text-xs font-semibold border transition-all ${
              scope === s
                ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
          >
            {SCOPE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* My rank hero */}
      {myEntry ? (
        <div className="rounded-2xl p-4 text-white flex items-center gap-4"
          style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #16213E 60%, #0f3460 100%)' }}>
          <div className="w-14 h-14 bg-white/10 rounded-xl flex flex-col items-center justify-center flex-shrink-0">
            <Trophy className="h-5 w-5 text-amber-300" />
            <p className="text-2xl font-black leading-none mt-0.5 tabular-nums">#{myEntry.rank}</p>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-bold truncate">{ROLE_NAMES[role]}</p>
            <p className="text-xs text-white/50 truncate">{ROLE_TERRITORY[role]}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <ChangeChip change={myEntry.change} />
              <span className="text-[11px] text-white/40">vs last month</span>
            </div>
            {ptsGap !== null && ptsGap > 0 && (
              <p className="text-xs text-amber-300 font-semibold mt-1 tabular-nums">
                +{ptsGap}% to reach #{myEntry.rank - 1}
              </p>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <p className={`text-3xl font-black tabular-nums ${myEntry.achievementPct >= 100 ? 'text-emerald-300' : 'text-white'}`}>
              {myEntry.achievementPct}%
            </p>
            <p className="text-[11px] text-white/40">achievement</p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl p-4 text-white"
          style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #0f3460 100%)' }}>
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6 text-white/40" />
            <div>
              <p className="text-sm font-bold">National Overview</p>
              <p className="text-xs text-white/50">Zonal rankings · May 2026</p>
            </div>
          </div>
        </div>
      )}

      {/* Top 3 podium */}
      {ranked.length >= 3 && (
        <div className="grid grid-cols-3 gap-2">
          {ranked.slice(0, 3).map((entry) => (
            <div key={entry.rank}
              className={`bg-white rounded-xl border p-3 text-center ${
                entry.rank === 1 ? 'border-yellow-200 bg-yellow-50/40' : 'border-gray-100'
              } ${entry.isMe ? 'ring-2 ring-[var(--brand-primary)]/30' : ''}`}
            >
              <div className="flex justify-center mb-1"><RankMedal rank={entry.rank} /></div>
              <p className={`text-xs font-bold leading-tight truncate ${entry.isMe ? 'text-[var(--brand-primary)]' : 'text-gray-800'}`}>
                {entry.name.split(' ')[0]}
              </p>
              <p className="text-[10px] text-gray-400 truncate mt-0.5">{entry.territory}</p>
              <p className={`text-sm font-black tabular-nums mt-1 ${pctColor(entry.achievementPct)}`}>
                {entry.achievementPct}%
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Full rankings */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Table header */}
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between bg-gray-50/60">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Name · Territory</p>
          <div className="flex items-center gap-6 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            <span className="hidden sm:block">Outlets</span>
            <span>Achiev.</span>
            <span title="Rank change vs last month">Δ Last Mo.</span>
          </div>
        </div>

        <div className="divide-y divide-gray-50">
          {ranked.map((entry) => (
            <div key={entry.name}
              className={`flex items-center gap-3 px-4 py-3 ${
                entry.isMe ? 'bg-emerald-50/60 border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-gray-50'
              }`}
            >
              {/* Rank */}
              <div className="w-5 flex items-center justify-center flex-shrink-0">
                <RankMedal rank={entry.rank} />
              </div>

              {/* Name + territory */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold truncate ${entry.isMe ? 'text-[var(--brand-primary)]' : 'text-gray-900'}`}>
                  {entry.name}
                  {entry.isMe && (
                    <span className="ml-1.5 text-[10px] font-semibold text-emerald-600 bg-emerald-100 rounded-full px-1.5 py-0.5">You</span>
                  )}
                </p>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="h-3 w-3 text-gray-300 shrink-0" />
                  <p className="text-[11px] text-gray-400 truncate">{entry.territory}</p>
                </div>
              </div>

              {/* Metrics */}
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right hidden sm:block">
                  <p className="text-xs font-semibold tabular-nums text-gray-700">{entry.activeOutlets.toLocaleString('en-IN')}</p>
                  <p className="text-[10px] text-gray-400">outlets</p>
                </div>
                <div className="text-right">
                  <span className={`text-xs font-bold tabular-nums px-2 py-0.5 rounded-full ${pctBg(entry.achievementPct)}`}>
                    {entry.achievementPct}%
                  </span>
                </div>
                <div className="w-10 flex justify-center">
                  <ChangeChip change={entry.change} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 justify-center">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />≥100% target
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />≥85%
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />&lt;85%
        </div>
      </div>

      <p className="text-[11px] text-gray-400 text-center pb-2">
        Ranked by secondary sales target achievement · Δ rank = change vs last month · Resets 1 Jun
      </p>
    </div>
  );
}
