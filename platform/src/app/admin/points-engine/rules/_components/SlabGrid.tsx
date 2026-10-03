'use client';

/**
 * Slab band grid — the editor for a slab node's tiers.
 *
 * Half-open [from, to) bands; the last band's `to` is blank = ∞. Mirrors the backend contiguity rule
 * (each band's `to` must equal the next band's `from`) with an inline gap/overlap hint so the author
 * fixes it before publish. Rate and flat are both optional per band (the evaluator treats missing as 0).
 */

import React from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { SlabBand } from '@/lib/points-engine/types';
import { inputCls } from './kit';

/** Returns a human gap/overlap message for the first offending adjacency, or null when contiguous. */
export function bandIssue(bands: SlabBand[]): string | null {
  for (let i = 0; i < bands.length - 1; i++) {
    const cur = bands[i];
    const nxt = bands[i + 1];
    if (cur.to === null) return `Band ${i + 1} is open-ended (∞) but is not the last band.`;
    if (Number.isFinite(cur.to) && Number.isFinite(nxt.from) && cur.to !== nxt.from) {
      return cur.to! > nxt.from
        ? `Overlap: band ${i + 1} ends at ${cur.to} but band ${i + 2} starts at ${nxt.from}.`
        : `Gap: band ${i + 1} ends at ${cur.to} but band ${i + 2} starts at ${nxt.from}.`;
    }
  }
  const last = bands[bands.length - 1];
  if (last && last.to !== null && Number.isFinite(last.to) && !(last.to > last.from)) {
    return `Band ${bands.length}: "to" must be greater than "from".`;
  }
  return null;
}

export function SlabGrid({
  bands,
  onChange,
  disabled,
}: {
  bands: SlabBand[];
  onChange: (bands: SlabBand[]) => void;
  disabled?: boolean;
}) {
  const setBand = (i: number, patch: Partial<SlabBand>) =>
    onChange(bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  const addBand = () => {
    const last = bands[bands.length - 1];
    const from = last && last.to !== null && Number.isFinite(last.to) ? last.to : (last?.from ?? 0);
    // New row inserted before the open-ended tail: previous last becomes bounded, new tail is ∞.
    const next = bands.map((b, idx) => (idx === bands.length - 1 && b.to === null ? { ...b, to: from } : b));
    onChange([...next, { from, to: null, rate: last?.rate ?? 0 }]);
  };

  const removeBand = (i: number) => {
    if (bands.length <= 1) return;
    const next = bands.filter((_, idx) => idx !== i);
    // Keep the last band open-ended.
    if (next.length > 0) next[next.length - 1] = { ...next[next.length - 1], to: null };
    onChange(next);
  };

  const issue = bandIssue(bands);
  const cell = `${inputCls} py-1.5`;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">To <span className="normal-case text-gray-300">(blank = ∞)</span></th>
              <th className="px-3 py-2">Rate / unit</th>
              <th className="px-3 py-2">Flat +</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => {
              const isLast = i === bands.length - 1;
              return (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      value={Number.isFinite(b.from) ? b.from : 0}
                      disabled={disabled}
                      onChange={(e) => setBand(i, { from: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className={cell}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      value={b.to === null ? '' : b.to}
                      disabled={disabled}
                      placeholder={isLast ? '∞' : ''}
                      onChange={(e) =>
                        setBand(i, { to: e.target.value === '' ? null : Number(e.target.value) })
                      }
                      className={cell}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      value={b.rate ?? ''}
                      disabled={disabled}
                      placeholder="0"
                      onChange={(e) =>
                        setBand(i, { rate: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      className={cell}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      value={b.flat ?? ''}
                      disabled={disabled}
                      placeholder="0"
                      onChange={(e) =>
                        setBand(i, { flat: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      className={cell}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      disabled={disabled || bands.length <= 1}
                      onClick={() => removeBand(i)}
                      title="Remove band"
                      className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {issue && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {issue}
        </div>
      )}

      {!disabled && (
        <button
          type="button"
          onClick={addBand}
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add band
        </button>
      )}
    </div>
  );
}
