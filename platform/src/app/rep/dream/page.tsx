'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Sparkles, Gift, Target, TrendingUp, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints } from '@/lib/utils';
import { formatISTDate } from '@/lib/ist-date';
import { authHeader } from '@/lib/api-client';
import {
  mapDream,
  pct,
  forecastFromRate,
  onTimeBadge,
  addMonths,
  type ApiEmployeeDream,
  type Dream,
} from '../_lib/employee';

/* ─── REP Dream Reward ────────────────────────────────────────────────────────
   The employee's single aspirational goal: a hero (reward + points-required), a big
   progress ring (redeemable ÷ required), the backend forecast ETA (HIDDEN when the
   server can't forecast — never faked), and a CLIENT-ONLY "Plan your finish" panel
   that lets the employee try an assumed earn rate + a target date to see a projected
   completion and whether they'd land on time. The panel never writes to the server —
   it is pure what-if math on top of the real `pointsRemaining`. ────────────────── */

const RATE_MIN = 1000;
const RATE_MAX = 30000;
const RATE_STEP = 500;
const RATE_FALLBACK = 5000; // used when the backend reports a 0 earn rate (no history).

/** Snap a raw earn rate to the slider's [min,max] range on the step grid. */
function seedRate(monthly: number): number {
  const base = monthly > 0 ? monthly : RATE_FALLBACK;
  const snapped = Math.round(base / RATE_STEP) * RATE_STEP;
  return Math.max(RATE_MIN, Math.min(RATE_MAX, snapped));
}

/** Local yyyy-mm-dd for an <input type="date"> value (calendar date, tz-naive). */
function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ── Progress ring (inline SVG) ── */
function ProgressRing({
  percent,
  size = 168,
  stroke = 14,
  children,
}: {
  percent: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * circ;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--brand-primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

export default function RepDreamPage() {
  const router = useRouter();
  const [dream, setDream] = useState<Dream | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A single reference instant for all what-if projections in this view (deterministic,
  // never a hardcoded date). Captured once on mount.
  const [now] = useState(() => new Date());

  // "Plan your finish" client-only state.
  const [rate, setRate] = useState<number>(RATE_FALLBACK);
  const [targetStr, setTargetStr] = useState<string>(() => toDateInput(addMonths(new Date(), 2)));
  const [activePreset, setActivePreset] = useState<number | null>(2);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetch('/api/rewards/employee/dream', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: ApiEmployeeDream; error?: string }) => {
        if (json.success && json.data) {
          const mapped = mapDream(json.data);
          setDream(mapped);
          setRate(seedRate(mapped.monthlyEarnRate));
        } else {
          setError(json.error ?? 'Could not load your Dream Reward');
        }
      })
      .catch(() => setError('Could not load your Dream Reward'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const targetDate = useMemo(() => {
    if (!targetStr) return null;
    const d = new Date(`${targetStr}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [targetStr]);

  const projected = useMemo(
    () => (dream ? forecastFromRate(dream.pointsRemaining, rate, now) : null),
    [dream, rate, now],
  );

  const badge = useMemo(() => onTimeBadge(projected, targetDate), [projected, targetDate]);

  const pickPreset = (months: number) => {
    setActivePreset(months);
    setTargetStr(toDateInput(addMonths(now, months)));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center fade-in">
        <Target className="h-12 w-12 text-gray-300" />
        <p className="text-sm text-red-500">{error}</p>
        <Button variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  /* ── Empty state: no dream chosen yet ── */
  if (!dream || !dream.reward) {
    return (
      <div className="fade-in">
        <button
          type="button"
          onClick={() => router.push('/rep')}
          className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> Home
        </button>
        <div className="flex flex-col items-center justify-center py-16 gap-5 text-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center bg-[var(--brand-primary)]/10">
            <Sparkles className="h-9 w-9 text-[var(--brand-primary)]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Choose your Dream Reward</h1>
            <p className="text-sm text-gray-500 mt-1.5 max-w-xs">
              Pick one big reward to aim for. We&apos;ll track your progress and show when you&apos;ll
              reach it.
            </p>
          </div>
          <Button variant="primary" onClick={() => router.push('/rep/rewards')}>
            Browse rewards
          </Button>
        </div>
      </div>
    );
  }

  const reward = dream.reward;
  const percent = pct(dream.redeemablePoints, dream.pointsRequired);

  return (
    <div className="space-y-5 fade-in">
      <button
        type="button"
        onClick={() => router.push('/rep')}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" /> Home
      </button>

      {/* ── Hero ── */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
        }}
      >
        <div className="px-4 pt-4 pb-5">
          <div className="flex items-center gap-1.5 mb-3">
            <Sparkles className="h-3.5 w-3.5 text-white/70" />
            <p className="text-[11px] font-bold tracking-wider text-white/70">YOUR DREAM REWARD</p>
          </div>
          <div className="rounded-xl bg-white/95 h-44 flex items-center justify-center overflow-hidden">
            {reward.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={reward.imageUrl} alt="" className="max-h-full max-w-full object-contain p-3" />
            ) : (
              <Gift className="h-16 w-16 text-gray-300" />
            )}
          </div>
          <h1 className="text-lg font-extrabold text-white leading-snug mt-3">{reward.name}</h1>
          <p className="text-sm font-semibold text-white/80 mt-0.5">
            {formatPoints(dream.pointsRequired)} pts to unlock
          </p>
        </div>
      </div>

      {/* ── Progress ring + stats ── */}
      <div className="flex flex-col items-center gap-5 py-2">
        <ProgressRing percent={percent}>
          <span className="text-3xl font-extrabold text-gray-900 leading-none">{percent}%</span>
          <span className="text-[11px] font-medium text-gray-400 mt-1">of the way there</span>
        </ProgressRing>

        {dream.reached ? (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-emerald-50 border border-emerald-200">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            <p className="text-sm font-bold text-emerald-700">You&apos;ve reached your Dream Reward 🎉</p>
          </div>
        ) : dream.forecastDate ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <CalendarClock className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
            <span>
              Estimated completion{' '}
              <span className="font-bold text-gray-900">{formatISTDate(dream.forecastDate)}</span>
            </span>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 w-full">
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3.5 text-center">
            <p className="text-[11px] font-semibold text-gray-400">Current points</p>
            <p className="text-xl font-extrabold text-gray-900 mt-1">
              {formatPoints(dream.redeemablePoints)}
            </p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3.5 text-center">
            <p className="text-[11px] font-semibold text-gray-400">Points to be earned</p>
            <p className="text-xl font-extrabold text-[var(--brand-primary)] mt-1">
              {formatPoints(dream.pointsRemaining)}
            </p>
          </div>
        </div>
      </div>

      {/* ── Plan your finish (client-only what-if) ── */}
      {!dream.reached && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
            <p className="text-sm font-bold text-gray-900">Plan your finish</p>
          </div>
          <div className="px-4 py-4 space-y-5">
            {/* Earn-rate slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="dream-rate" className="text-xs font-medium text-gray-600">
                  If I earn per month
                </label>
                <span className="text-sm font-extrabold text-[var(--brand-primary)]">
                  {formatPoints(rate)} pts
                </span>
              </div>
              <input
                id="dream-rate"
                type="range"
                min={RATE_MIN}
                max={RATE_MAX}
                step={RATE_STEP}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="w-full accent-[var(--brand-primary)]"
              />
              <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                <span>{formatPoints(RATE_MIN)}</span>
                <span>{formatPoints(RATE_MAX)}</span>
              </div>
            </div>

            {/* Projected completion */}
            <div className="rounded-xl bg-gray-50 px-3.5 py-3 flex items-center justify-between">
              <p className="text-xs font-medium text-gray-500">Projected completion</p>
              <p className="text-sm font-bold text-gray-900">
                {projected ? formatISTDate(projected) : '—'}
              </p>
            </div>

            {/* Target date */}
            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">I want it by</p>
              <div className="flex gap-2 mb-2.5">
                {[1, 2, 3].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => pickPreset(m)}
                    className={
                      'flex-1 px-2 py-1.5 rounded-full text-xs font-semibold transition-colors ' +
                      (activePreset === m
                        ? 'bg-[var(--brand-primary)] text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200')
                    }
                  >
                    {m} {m === 1 ? 'month' : 'months'}
                  </button>
                ))}
              </div>
              <input
                type="date"
                value={targetStr}
                onChange={(e) => {
                  setActivePreset(null);
                  setTargetStr(e.target.value);
                }}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
            </div>

            {/* On-time / late verdict */}
            {projected && targetDate ? (
              <div>
                <span
                  className={
                    'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ' +
                    (badge.onTime
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-red-50 text-red-700 border-red-200')
                  }
                >
                  {badge.onTime ? 'On time' : `~${badge.daysLate} days late`}
                </span>
                <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                  {badge.onTime
                    ? `At ${formatPoints(rate)} pts a month you'd reach your Dream Reward on or before ${formatISTDate(targetDate)}.`
                    : `At ${formatPoints(rate)} pts a month you'd land about ${badge.daysLate} day${badge.daysLate === 1 ? '' : 's'} after ${formatISTDate(targetDate)}. Earn a little more each month to close the gap.`}
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-400">Pick a target date to see if you&apos;re on track.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Change dream ── */}
      <Button variant="outline" className="w-full" onClick={() => router.push('/rep/rewards')}>
        Change Dream Reward
      </Button>
    </div>
  );
}
