'use client';

import React from 'react';
import { Check } from 'lucide-react';
import { pctBarColor } from '@/lib/targets';
import {
  formatOfferValue, formatOfferDayShort, offerProgressView, type OfferTilePartner,
} from '@/lib/offers';

/**
 * One offer tile — big value first, then the unit label on its OWN line, product and headline;
 * a thin progress bar when the tile is KPI-linked AND this outlet has a target.
 *
 * Narrow screens (320–360px ⇒ ~116px of tile content): the value NEVER truncates to "+…" — it
 * shrinks (text-xl → text-2xl from 380px) and may wrap; the unit label, product and headline
 * are what truncate. "Unlocked" shows exactly when the API says so, and the bar is never full
 * without it (offerProgressView). A real <button> with a concise aria-label (headline + value +
 * progress) so screen readers get the whole tile in one announcement. Pure render (no Date /
 * storage reads) so the admin live preview can reuse it verbatim.
 */
export function OfferTileCard({
  tile,
  showValidTo = false,
  onOpen,
}: {
  tile: OfferTilePartner;
  /** Show a compact "till 15 Nov" on the tile (when the section has no shared validTo). */
  showValidTo?: boolean;
  onOpen?: () => void;
}) {
  const value = formatOfferValue(tile);
  const pr = tile.progress;
  const { showBar, pct, unlocked } = offerProgressView(pr);
  const isText = tile.valueType === 'TEXT';

  const ariaLabel = [
    tile.label,
    [value, tile.unitLabel].filter(Boolean).join(' '),
    tile.product,
    unlocked ? 'Unlocked' : showBar ? `${pct}% of target` : null,
    showValidTo ? `till ${formatOfferDayShort(tile.validTo)}` : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      data-testid="offer-tile"
      className="flex h-full w-full min-w-0 flex-col items-start gap-1 rounded-2xl border border-gray-100 bg-white p-3 text-left shadow-sm transition-transform active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
    >
      <span
        data-testid="offer-tile-value"
        className={`block w-full font-extrabold leading-tight text-[var(--brand-primary)] [overflow-wrap:anywhere] ${
          isText ? 'text-lg min-[380px]:text-xl' : 'text-xl min-[380px]:text-2xl'
        }`}
      >
        {value}
      </span>
      {tile.unitLabel && (
        <span data-testid="offer-tile-unit" className="block w-full truncate text-xs font-medium text-gray-600">
          {tile.unitLabel}
        </span>
      )}
      {tile.product && (
        <span className="w-full truncate text-xs font-semibold text-gray-900">{tile.product}</span>
      )}
      <span className="line-clamp-2 w-full text-[11px] leading-snug text-gray-600">{tile.label}</span>

      {(showBar || unlocked) && (
        <span className="mt-auto w-full space-y-1 pt-1">
          {showBar && (
            <span
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${pr!.kpiName} progress`}
              className="block h-1.5 w-full overflow-hidden rounded-full bg-gray-100"
            >
              <span
                className={`block h-full rounded-full ${unlocked ? 'bg-emerald-500' : pctBarColor(pct)}`}
                style={{ width: `${pct}%` }}
              />
            </span>
          )}
          {unlocked ? (
            <span
              data-testid="offer-tile-unlocked"
              className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-bold text-emerald-700"
            >
              <Check className="h-3 w-3" aria-hidden="true" /> Unlocked
            </span>
          ) : (
            <span className="block text-xs font-semibold text-gray-600">{pct}%</span>
          )}
        </span>
      )}

      {showValidTo && (
        <span className={`${showBar || unlocked ? '' : 'mt-auto '}pt-0.5 text-xs text-gray-600`}>
          till {formatOfferDayShort(tile.validTo)}
        </span>
      )}
    </button>
  );
}
