'use client';

/**
 * Live simulator — the sticky right-hand panel of the rule builder.
 *
 * The author types one sample outlet's achievement / target / segment values; we POST the CURRENT
 * draft config + that context to the pure `simulate` route (the backend evaluator is the single source
 * of truth — no second JS evaluator ships to the browser). It renders the SimulateResult: config errors
 * when invalid, else the EvalOutcome — big final points (or SKIP reason / ERROR) + the per-node trace
 * ladder (which, for a slab, IS the marginal-vs-whole breakdown). Debounced auto-run + a manual button.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, AlertCircle, SkipForward, Sparkles, Loader2 } from 'lucide-react';
import { simulate } from '@/lib/points-engine/api';
import type { RuleConfigDraft, SimulateResult, TraceStep } from '@/lib/points-engine/types';
import { labelCls } from './kit';

interface SampleContext {
  achievements: Record<string, string>;
  targets: Record<string, string>;
  segment: { program: string; programCategory: string; outletType: string };
}

/** Which achievement / target KPIs the draft references, so the simulator asks for exactly those. */
function referencedKpis(draft: RuleConfigDraft): { achievements: string[]; targets: string[] } {
  const ach = new Set<string>();
  const tgt = new Set<string>();
  for (const inp of draft.inputs) {
    if (inp.kpiCode) ach.add(inp.kpiCode);
    if (inp.source) {
      const idx = inp.source.indexOf(':');
      const kind = idx >= 0 ? inp.source.slice(0, idx) : inp.source;
      const key = idx >= 0 ? inp.source.slice(idx + 1) : '';
      if (!key) continue;
      if (kind === 'achievement') ach.add(key);
      else if (kind === 'target') tgt.add(key);
      else if (kind === 'pct') {
        ach.add(key);
        tgt.add(key);
      }
    }
  }
  return { achievements: [...ach], targets: [...tgt] };
}

function toNumOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function SimulatorPanel({ draft }: { draft: RuleConfigDraft }) {
  const { achievements: achKpis, targets: tgtKpis } = useMemo(() => referencedKpis(draft), [draft]);

  const [ctx, setCtx] = useState<SampleContext>({
    achievements: {},
    targets: {},
    segment: { program: '', programCategory: '', outletType: '' },
  });
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const reqId = useRef(0);

  const run = useCallback(async () => {
    const id = ++reqId.current;
    setRunning(true);
    setCallError(null);
    const achievements: Record<string, number | null> = {};
    for (const k of achKpis) achievements[k] = toNumOrNull(ctx.achievements[k] ?? '');
    const targets: Record<string, number | null> = {};
    for (const k of tgtKpis) targets[k] = toNumOrNull(ctx.targets[k] ?? '');

    const res = await simulate({
      attachsTo: draft.attachsTo,
      output: draft.output,
      rounding: draft.rounding,
      inputs: draft.inputs,
      pipeline: draft.pipeline,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo,
      context: {
        achievements,
        targets,
        segment: {
          program: ctx.segment.program || null,
          programCategory: ctx.segment.programCategory || null,
          outletType: ctx.segment.outletType || null,
        },
      },
    });
    if (id !== reqId.current) return; // a newer run superseded this one
    if (res.success) setResult(res.data);
    else setCallError(res.error ?? 'Simulation failed');
    setRunning(false);
  }, [achKpis, tgtKpis, ctx, draft]);

  // Debounced auto-run whenever the draft or sample context changes.
  useEffect(() => {
    const t = setTimeout(() => void run(), 400);
    return () => clearTimeout(t);
  }, [run]);

  const setAch = (k: string, v: string) =>
    setCtx((c) => ({ ...c, achievements: { ...c.achievements, [k]: v } }));
  const setTgt = (k: string, v: string) =>
    setCtx((c) => ({ ...c, targets: { ...c.targets, [k]: v } }));
  const setSeg = (k: keyof SampleContext['segment'], v: string) =>
    setCtx((c) => ({ ...c, segment: { ...c.segment, [k]: v } }));

  const numCls =
    'w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-bold text-gray-900">Live simulator</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-primary)] px-2.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Simulate
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* Sample context */}
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Sample outlet</p>

          {achKpis.length === 0 && tgtKpis.length === 0 && (
            <p className="text-xs text-gray-400">Add inputs to the rule to supply sample achievement / target values.</p>
          )}

          {achKpis.length > 0 && (
            <div className="grid grid-cols-1 gap-2">
              {achKpis.map((k) => (
                <div key={`a-${k}`}>
                  <label htmlFor={`sim-ach-${k}`} className={labelCls}>Achievement · {k}</label>
                  <input
                    id={`sim-ach-${k}`}
                    type="number"
                    value={ctx.achievements[k] ?? ''}
                    placeholder="blank = missing"
                    onChange={(e) => setAch(k, e.target.value)}
                    className={numCls}
                  />
                </div>
              ))}
            </div>
          )}

          {tgtKpis.length > 0 && (
            <div className="grid grid-cols-1 gap-2">
              {tgtKpis.map((k) => (
                <div key={`t-${k}`}>
                  <label htmlFor={`sim-tgt-${k}`} className={labelCls}>Target · {k}</label>
                  <input
                    id={`sim-tgt-${k}`}
                    type="number"
                    value={ctx.targets[k] ?? ''}
                    placeholder="blank = missing"
                    onChange={(e) => setTgt(k, e.target.value)}
                    className={numCls}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2">
            {(['program', 'programCategory', 'outletType'] as const).map((f) => (
              <div key={f}>
                <label htmlFor={`sim-seg-${f}`} className={labelCls}>Segment · {f}</label>
                <input
                  id={`sim-seg-${f}`}
                  value={ctx.segment[f]}
                  placeholder="(blank)"
                  onChange={(e) => setSeg(f, e.target.value)}
                  className={numCls}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Result */}
        <div className="border-t border-gray-100 pt-3">
          {callError ? (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" /> {callError}
            </div>
          ) : !result ? (
            <p className="text-xs text-gray-400">Enter sample values to see the computed points.</p>
          ) : !result.valid ? (
            <div className="space-y-1.5 rounded-xl border border-red-200 bg-red-50 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold text-red-700">
                <AlertCircle className="h-4 w-4" /> Rule config is not yet valid
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-red-700">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <OutcomeView result={result} />
          )}
        </div>
      </div>
    </div>
  );
}

function OutcomeView({ result }: { result: SimulateResult }) {
  const outcome = result.outcome;
  if (!outcome) return null;

  return (
    <div className="space-y-3">
      {outcome.status === 'OK' && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-green-600">Points awarded</p>
          <p className="text-3xl font-extrabold text-green-700">{outcome.points.toLocaleString()}</p>
        </div>
      )}
      {outcome.status === 'SKIP' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
            <SkipForward className="h-4 w-4" /> Row skipped (surfaced for review)
          </div>
          <p className="mt-1 text-[11px] text-amber-700">{outcome.reason}</p>
        </div>
      )}
      {outcome.status === 'ERROR' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-red-700">
            <AlertCircle className="h-4 w-4" /> Evaluation error
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-red-700">
            {outcome.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {outcome.trace.length > 0 && <TraceLadder trace={outcome.trace} />}
    </div>
  );
}

function TraceLadder({ trace }: { trace: TraceStep[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Step-by-step trace</p>
      <ol className="space-y-1.5">
        {trace.map((s, i) => (
          <li key={`${s.nodeId}-${i}`} className="rounded-lg border border-gray-100 bg-gray-50 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-500">{s.type}</span>
              <span className="text-[11px] font-semibold tabular-nums">
                <span className={s.delta > 0 ? 'text-green-600' : s.delta < 0 ? 'text-red-600' : 'text-gray-400'}>
                  {s.delta > 0 ? '+' : ''}
                  {s.delta.toLocaleString()}
                </span>
                <span className="text-gray-400"> → </span>
                <span className="text-gray-900">{s.pointsAfter.toLocaleString()}</span>
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-gray-600">{s.detail}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
