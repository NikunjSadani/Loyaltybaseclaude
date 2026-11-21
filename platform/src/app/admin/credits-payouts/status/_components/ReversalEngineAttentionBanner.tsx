'use client';

/**
 * Wallet Reversal Engine — policy round A call-out banner (owner rule "no silent pass-throughs", 2026-11-16).
 *
 * Shows, above the credits reversal screen, everything that will make a POINTS reversal be refused and why:
 *  - approvals paused (wallet maintenance — the backfill window) + since when; GIFSY can lift a stuck pause;
 *  - wallets needing Gifsy attention (BLOCKED by the backfill / not yet prepared) with the reason — earning and
 *    redeeming on them keep working, only reversals are refused;
 *  - credits that couldn't be mapped to an outlet line (reversals of that line refused until Gifsy maps them);
 *  - historical clawbacks that took more than the wallet held: "recovered X, owed Y";
 *  - readiness, LOUD and up front: wallets with points history not yet prepared for reversals (Gifsy must run the
 *    wallet backfill before any points reversal); expiry-sweep lots that failed (retried by the next run);
 *    reversals refused because Gifsy must act (e.g. a credit with no position on a sequenced wallet).
 * Every tenant runs the same reversal rules (the per-tenant engine mode was retired), so this mounts for everyone.
 * Data: GET /api/admin/credits/reversal-engine/attention. Renders nothing when nothing needs attention.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, PauseCircle } from 'lucide-react';

interface AttentionWallet {
  walletId: string;
  partnerName: string | null;
  outletCodes: string[];
  status: 'BLOCKED' | 'NOT_BACKFILLED';
  reason: string;
}
interface UnmappedCredit {
  positionId: string;
  batchId: string;
  amount: number;
  reason: string;
}
interface ExpiryFailure {
  at: string;
  lotId: string | null;
  walletId: string | null;
  error: string | null;
}
interface Refusal {
  at: string;
  entityId: string;
  phase: string | null;
  code: string | null;
  message: string | null;
  outletCode: string | null;
  reason: string | null;
}
interface OwedClawback {
  creditReversalId: string;
  outletCode: string | null;
  label: string;
}
export interface ReversalAttention {
  /** The program these call-outs are about — "Resume approvals" targets exactly this one (fix round A, L6). */
  clientId?: string;
  /** Whether the program's wallets are prepared for points reversals; `message` is a plain-words line when not ready. */
  readiness?: { unsequencedWithHistory: number; blocked: number; ready: boolean; message: string | null };
  pause: { paused: boolean; since: string | null; by: string | null; reason: string | null; malformed?: boolean };
  wallets: AttentionWallet[];
  walletsTotal: number;
  unmappedCredits: UnmappedCredit[];
  unmappedTotal: number;
  owedClawbacks: OwedClawback[];
  owedTotal: number;
  expiryFailures?: ExpiryFailure[];
  expiryFailuresTotal?: number;
  /** Audit B8: expiries whose debt repayment could not all be booked on the credit (legacy lot drift). */
  expiryOffsetCapped?: Array<{
    at: string;
    walletId: string;
    lotId: string | null;
    batchId: string | null;
    outletCode: string | null;
    offsetNotRecorded: number | null;
    action: string;
  }>;
  expiryOffsetCappedTotal?: number;
  /** Fix round 3: V2 reversals that booked debt on a credit whose expiry history isn't linked (no lot). */
  expiryUntracked?: Array<{ at: string; creditReversalId: string; walletId: string | null; /** round 6: EVERY affected wallet (a reversal can span wallets) */ walletIds?: string[]; outletCode: string | null; owed: number | null; recovered?: number | null; action: string }>;
  expiryUntrackedTotal?: number;
  refusals?: Refusal[];
  refusalsTotal?: number;
}

const ATTENTION_URL = '/api/admin/credits/reversal-engine/attention';
const PAUSE_URL = '/api/admin/credits/reversal-engine/pause';

function fmtSince(iso: string | null): string {
  if (!iso) return 'an unknown time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN');
}

/** Round 6 (item 5): every wallet an untracked-expiry reversal touched — not only the first. */
export function untrackedWallets(u: { walletId: string | null; walletIds?: string[] }): string {
  const ids = u.walletIds && u.walletIds.length ? u.walletIds : u.walletId ? [u.walletId] : [];
  if (!ids.length) return '';
  return ids.length === 1 ? ` · wallet ${ids[0]}` : ` · ${ids.length} wallets: ${ids.join(', ')}`;
}

export default function ReversalEngineAttentionBanner({ canLiftPause = false }: { canLiftPause?: boolean }) {
  const [data, setData] = useState<ReversalAttention | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ATTENTION_URL);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setLoadError(json?.error ?? `Could not load reversal call-outs (HTTP ${res.status})`);
        return;
      }
      setLoadError(null);
      setData(json.data as ReversalAttention);
    } catch (e) {
      setLoadError(`Could not load reversal call-outs: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function liftPause() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(PAUSE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // L6: name the program explicitly — the server never falls back to a Gifsy user's home tenant.
        body: JSON.stringify({
          paused: false,
          reason: 'lifted from the credits reversal screen',
          ...(data?.clientId ? { clientId: data.clientId } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) setActionError(json?.error ?? `Could not resume approvals (HTTP ${res.status})`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    // Never silent: a failed call-out read is itself shown.
    return (
      <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        {loadError}
      </div>
    );
  }
  if (!data) return null;

  const paused = data.pause.paused;
  const parts: string[] = [];
  if (data.walletsTotal > 0) parts.push(`${data.walletsTotal} wallet${data.walletsTotal === 1 ? '' : 's'} need Gifsy attention`);
  if (data.unmappedTotal > 0) parts.push(`${data.unmappedTotal} credit${data.unmappedTotal === 1 ? '' : 's'} unmapped`);
  if (data.owedTotal > 0) parts.push(`${data.owedTotal} historical clawback${data.owedTotal === 1 ? '' : 's'} with points owed`);
  const expiryTotal = data.expiryFailuresTotal ?? 0;
  const refusalTotal = data.refusalsTotal ?? 0;
  const expiryFailures = data.expiryFailures ?? [];
  const refusals = data.refusals ?? [];
  if (expiryTotal > 0) parts.push(`${expiryTotal} points-expiry failure${expiryTotal === 1 ? '' : 's'} (last 30 days)`);
  const cappedTotal = data.expiryOffsetCappedTotal ?? 0;
  const capped = data.expiryOffsetCapped ?? [];
  if (cappedTotal > 0) parts.push(`${cappedTotal} points expir${cappedTotal === 1 ? 'y' : 'ies'} with debt not fully booked on the credit (last 30 days)`);
  const untrackedTotal = data.expiryUntrackedTotal ?? 0;
  const untracked = data.expiryUntracked ?? [];
  if (untrackedTotal > 0) parts.push(`${untrackedTotal} reversal${untrackedTotal === 1 ? '' : 's'} of a credit whose expiry history is unknown (last 30 days)`);
  if (refusalTotal > 0) parts.push(`${refusalTotal} points reversal${refusalTotal === 1 ? '' : 's'} refused — Gifsy must act (last 30 days)`);
  const notReady = !!data.readiness && !data.readiness.ready;
  const readinessMessage = notReady
    ? data.readiness?.message ||
      'Some wallets with points history are not yet prepared for reversals — Gifsy must prepare them before any points reversal'
    : null;
  if (!paused && parts.length === 0 && !readinessMessage) return null;

  return (
    <section
      aria-label="Points reversal call-outs"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-2"
    >
      {readinessMessage && (
        // Never buried in the details — wallets not prepared for reversals are shown up front.
        <div className="flex items-start gap-2" role="alert" data-testid="attention-readiness">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" aria-hidden />
          <p className="font-semibold text-red-800 break-words">{readinessMessage}</p>
        </div>
      )}
      {paused && (
        <div className="flex items-start gap-2" role="status">
          <PauseCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">
              {data.pause.malformed
                ? 'Points reversal approvals are paused — the pause setting is unreadable; contact Gifsy'
                : `Points reversal approvals are paused — wallet maintenance in progress (started ${fmtSince(data.pause.since)})`}
            </p>
            <p className="text-xs">New points reversal requests and approvals are refused until it ends. Payout reversals are not affected.</p>
          </div>
          {canLiftPause && (
            <button
              type="button"
              onClick={liftPause}
              disabled={busy}
              className="text-xs font-medium border border-amber-400 rounded-md px-2 py-1 hover:bg-amber-100 disabled:opacity-50"
            >
              {busy ? 'Resuming…' : 'Resume approvals'}
            </button>
          )}
        </div>
      )}
      {actionError && <p role="alert" className="text-xs text-red-700">{actionError}</p>}
      {parts.length > 0 && (
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">{parts.join(' · ')}</p>
            <p className="text-xs">Points reversals touching these are refused with the reason below. Earning and redeeming keep working.</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="text-xs font-medium flex items-center gap-1 hover:underline"
          >
            {open ? 'Hide' : 'Show'} details {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      )}
      {open && (
        <div className="space-y-3 text-xs">
          {refusals.length > 0 && (
            <div>
              <p className="font-semibold mb-1">Points reversals refused — Gifsy must act ({refusalTotal})</p>
              <ul className="space-y-1">
                {refusals.map((r, i) => (
                  <li key={`${r.entityId}-${r.at}-${i}`} className="break-words">
                    {fmtSince(r.at)}
                    {r.outletCode ? ` · outlet ${r.outletCode}` : ''} · {r.phase === 'APPROVE' ? 'approval' : 'request'} refused —{' '}
                    {r.message ?? r.code}
                    {r.reason ? ` (${r.reason})` : ''}
                  </li>
                ))}
              </ul>
              {refusalTotal > refusals.length && <p>…and {refusalTotal - refusals.length} more</p>}
            </div>
          )}
          {untracked.length > 0 && (
            <div data-testid="attention-expiry-untracked">
              <p className="font-semibold mb-1">Reversals of a credit whose expiry history is unknown ({untrackedTotal})</p>
              <ul className="space-y-1">
                {untracked.map((u, i) => (
                  <li key={`${u.creditReversalId}-${i}`} className="break-words">
                    {fmtSince(u.at)} · reversal {u.creditReversalId}
                    {u.outletCode ? ` · outlet ${u.outletCode}` : ''}
                    {untrackedWallets(u)}
                    {u.recovered ? ` · ${u.recovered} pts taken` : ''}
                    {u.owed ? ` · ${u.owed} pts booked as debt` : ''} — {u.action}
                  </li>
                ))}
              </ul>
              {untrackedTotal > untracked.length && <p>…and {untrackedTotal - untracked.length} more</p>}
            </div>
          )}
          {capped.length > 0 && (
            <div data-testid="attention-expiry-offset-capped">
              <p className="font-semibold mb-1">Expiry repaid debt beyond the credit&apos;s record ({cappedTotal})</p>
              <ul className="space-y-1">
                {capped.map((c, i) => (
                  <li key={`${c.lotId}-${c.at}-${i}`} className="break-words">
                    {fmtSince(c.at)} · wallet {c.walletId}
                    {c.outletCode ? ` · outlet ${c.outletCode}` : ''}
                    {c.offsetNotRecorded != null ? ` · ${c.offsetNotRecorded} pts not booked on the credit` : ''} — {c.action}
                  </li>
                ))}
              </ul>
              {cappedTotal > capped.length && <p>…and {cappedTotal - capped.length} more</p>}
            </div>
          )}
          {expiryFailures.length > 0 && (
            <div>
              <p className="font-semibold mb-1">Points-expiry failures ({expiryTotal}) — retried automatically by the next expiry run</p>
              <ul className="space-y-1">
                {expiryFailures.map((f, i) => (
                  <li key={`${f.lotId}-${f.at}-${i}`} className="break-words">
                    {fmtSince(f.at)} · lot {f.lotId ?? '?'} (wallet {f.walletId ?? '?'}) — {f.error ?? 'unknown error'}
                  </li>
                ))}
              </ul>
              {expiryTotal > expiryFailures.length && <p>…and {expiryTotal - expiryFailures.length} more</p>}
            </div>
          )}
          {data.wallets.length > 0 && (
            <div>
              <p className="font-semibold mb-1">Wallets needing Gifsy attention ({data.walletsTotal})</p>
              <ul className="space-y-1">
                {data.wallets.map((w) => (
                  <li key={w.walletId} className="break-words">
                    <span className="font-medium">{w.partnerName ?? w.walletId}</span>
                    {w.outletCodes.length > 0 && <> · {w.outletCodes.join(', ')}</>} ·{' '}
                    {w.status === 'BLOCKED' ? 'Blocked' : 'Not yet prepared'} — {w.reason}
                  </li>
                ))}
              </ul>
              {data.walletsTotal > data.wallets.length && <p>…and {data.walletsTotal - data.wallets.length} more</p>}
            </div>
          )}
          {data.unmappedCredits.length > 0 && (
            <div>
              <p className="font-semibold mb-1">Credits Gifsy must map ({data.unmappedTotal})</p>
              <ul className="space-y-1">
                {data.unmappedCredits.map((c) => (
                  <li key={c.positionId} className="break-words">
                    {c.amount} pts · batch {c.batchId} — {c.reason}
                  </li>
                ))}
              </ul>
              {data.unmappedTotal > data.unmappedCredits.length && <p>…and {data.unmappedTotal - data.unmappedCredits.length} more</p>}
            </div>
          )}
          {data.owedClawbacks.length > 0 && (
            <div>
              <p className="font-semibold mb-1">Historical clawbacks with points owed ({data.owedTotal})</p>
              <ul className="space-y-1">
                {data.owedClawbacks.map((o) => (
                  <li key={o.creditReversalId} className="break-words">
                    Reversal {o.creditReversalId}{o.outletCode ? ` · outlet ${o.outletCode}` : ''} — {o.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
