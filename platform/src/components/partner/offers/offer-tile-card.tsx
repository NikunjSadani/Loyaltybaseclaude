'use client';

import React from 'react';
import { Check } from 'lucide-react';
import {
  formatOfferValue, formatOfferDayShort, offerProgressView, type OfferGroup, type OfferTilePartner,
} from '@/lib/offers';

/**
 * Per-group colour treatment (owner-approved mockup).
 *
 * TARGET_REWARD — soft tint of the TENANT brand colour, reusing the root-layout brand variables
 * (`buildCssVariables`: `--brand-primary` + `--brand-primary-light` = 8% primary into white). Text
 * uses a DERIVED dark shade (40% primary into black) rather than `--brand-primary-dark` (only 12%
 * darker — fails 4.5:1 for a light brand). That pair is ≥ 5.7:1 for ANY primary colour (worst case
 * is a white primary). The fallbacks mirror `SAFE_PRIMARY` (#16a34a) in case the vars are absent.
 *
 * EXTRA_SCHEME — amber-50 / amber-200 border; value + product amber-900 (8.7:1), secondary amber-800 (6.8:1).
 */
// Full literal class strings (no interpolation) — Tailwind generates CSS by scanning source text.
const BRAND_TEXT = 'text-[color:color-mix(in_srgb,var(--brand-primary,#16a34a)_40%,black)]';

export const OFFER_TILE_TONE: Record<OfferGroup, {
  card: string; value: string; strong: string; muted: string; sheetValue: string;
}> = {
  TARGET_REWARD: {
    card: 'border-[color:color-mix(in_srgb,var(--brand-primary,#16a34a)_25%,white)] bg-[var(--brand-primary-light,#ecf8f0)]',
    value: BRAND_TEXT,
    strong: BRAND_TEXT,
    muted: BRAND_TEXT,
    sheetValue: 'text-[var(--brand-primary)]',
  },
  EXTRA_SCHEME: {
    card: 'border-amber-200 bg-amber-50',
    value: 'text-amber-900',
    strong: 'text-amber-900',
    muted: 'text-amber-800',
    sheetValue: 'text-amber-700',
  },
};

/** Tile-only bar fill: the -700 shades of the shared `pctBarColor` scale, so the fill keeps
 *  ≥ 5:1 against the white track on either tinted card (the -400/-500 shades do not). */
export function offerTileBarColor(pct: number, unlocked: boolean): string {
  if (unlocked || pct >= 100) return 'bg-emerald-700';
  if (pct >= 80) return 'bg-amber-700';
  if (pct >= 60) return 'bg-orange-700';
  return 'bg-red-700';
}

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
  const tone = OFFER_TILE_TONE[tile.group] ?? OFFER_TILE_TONE.TARGET_REWARD;

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
      data-group={tile.group}
      className={`flex h-full w-full min-w-0 flex-col items-start gap-1 rounded-2xl border ${tone.card} p-3 text-left shadow-sm transition-transform active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]`}
    >
      <span
        data-testid="offer-tile-value"
        className={`block w-full font-extrabold leading-tight ${tone.value} [overflow-wrap:anywhere] ${
          isText ? 'text-lg min-[380px]:text-xl' : 'text-xl min-[380px]:text-2xl'
        }`}
      >
        {value}
      </span>
      {tile.unitLabel && (
        <span data-testid="offer-tile-unit" className={`block w-full truncate text-xs font-medium ${tone.muted}`}>
          {tile.unitLabel}
        </span>
      )}
      {tile.product && (
        <span data-testid="offer-tile-product" className={`w-full truncate text-xs font-semibold ${tone.strong}`}>{tile.product}</span>
      )}
      <span data-testid="offer-tile-label" className={`line-clamp-2 w-full text-[11px] leading-snug ${tone.muted}`}>{tile.label}</span>

      {(showBar || unlocked) && (
        <span className="mt-auto w-full space-y-1 pt-1">
          {showBar && (
            <span
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${pr!.kpiName} progress`}
              className="block h-1.5 w-full overflow-hidden rounded-full bg-white"
            >
              <span
                data-testid="offer-tile-bar-fill"
                className={`block h-full rounded-full ${offerTileBarColor(pct, unlocked)}`}
                style={{ width: `${pct}%` }}
              />
            </span>
          )}
          {unlocked ? (
            <span
              data-testid="offer-tile-unlocked"
              className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200"
            >
              <Check className="h-3 w-3" aria-hidden="true" /> Unlocked
            </span>
          ) : (
            <span data-testid="offer-tile-pct" className={`block text-xs font-semibold ${tone.muted}`}>{pct}%</span>
          )}
        </span>
      )}

      {showValidTo && (
        <span className={`${showBar || unlocked ? '' : 'mt-auto '}pt-0.5 text-xs ${tone.muted}`}>
          till {formatOfferDayShort(tile.validTo)}
        </span>
      )}
    </button>
  );
}
