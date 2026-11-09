'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';
import {
  formatOfferValue, formatOfferDay, offerProgressView, OFFER_GROUP_LABEL, type OfferTilePartner,
} from '@/lib/offers';
import { OFFER_TILE_TONE } from './offer-tile-card';

/** Bottom-sheet override for the shared Radix Modal (focus trap + Esc come from Radix). The bottom
 *  padding adds the iOS home-indicator safe area so the footer is never under it. */
export const SHEET_CLASS =
  'top-auto bottom-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none rounded-b-none ' +
  'pb-[calc(1.5rem+env(safe-area-inset-bottom))] ' +
  'sm:left-1/2 sm:-translate-x-1/2 sm:max-w-lg';

/** Brand name for the D5 disclaimer; the neutral placeholder config counts as "unknown". */
export function offerBrandName(displayName: string | null | undefined): string {
  const n = (displayName ?? '').trim();
  if (!n || n === DEFAULT_CLIENT_CONFIG.branding.displayName) return 'your brand';
  return n;
}

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/**
 * Detail sheet for one tile. `tile === null` ⇒ closed. Plain text only (no HTML injection).
 * The LAST opened tile is kept while the sheet animates closed, so the content never flickers
 * to empty / "Offer" mid-close (React's derive-state-from-props pattern — no effect, no ref).
 */
export function OfferSheet({ tile, onClose }: { tile: OfferTilePartner | null; onClose: () => void }) {
  const brand = offerBrandName(useClientConfig()?.branding?.displayName);
  const [lastTile, setLastTile] = useState<OfferTilePartner | null>(tile);
  if (tile !== null && tile !== lastTile) setLastTile(tile);
  const shown = tile ?? lastTile;
  const pr = shown?.progress ?? null;
  const hasTarget = !!pr && pr.target !== null && pr.target > 0;
  const { unlocked } = offerProgressView(pr);

  return (
    <Modal
      open={tile !== null}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={shown?.label ?? 'Offer'}
      description={shown ? OFFER_GROUP_LABEL[shown.group] : undefined}
      className={SHEET_CLASS}
    >
      {shown && (
        <div className="space-y-4" data-testid="offer-sheet">
          <div>
            <p
              data-testid="offer-sheet-value"
              className={`text-3xl font-extrabold leading-tight ${(OFFER_TILE_TONE[shown.group] ?? OFFER_TILE_TONE.TARGET_REWARD).sheetValue} [overflow-wrap:anywhere]`}
            >
              {formatOfferValue(shown)}
              {shown.unitLabel && (
                <span className="ml-1.5 text-sm font-medium text-gray-600">{shown.unitLabel}</span>
              )}
            </p>
            {shown.product && <p className="mt-1 text-sm font-semibold text-gray-900">{shown.product}</p>}
          </div>

          {pr && (
            <div className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700" data-testid="offer-sheet-progress">
              <p className="font-semibold text-gray-900">Your progress · {pr.kpiName}</p>
              {hasTarget ? (
                <p className="mt-0.5">
                  {fmt(pr.achieved)} / {fmt(pr.target as number)}{pr.unit ? ` ${pr.unit}` : ''}
                  {pr.pct !== null ? ` · ${pr.pct}%` : ''}
                </p>
              ) : (
                <p className="mt-0.5 text-gray-600">No target set for this month yet.</p>
              )}
              {unlocked && (
                <p className="mt-0.5 font-bold text-emerald-700" data-testid="offer-sheet-unlocked">Unlocked</p>
              )}
            </div>
          )}

          {shown.details && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-600">Details</h3>
              <p className="mt-1 whitespace-pre-line text-sm text-gray-700">{shown.details}</p>
            </div>
          )}

          <p className="text-xs font-medium text-gray-600">Valid till {formatOfferDay(shown.validTo)}</p>

          <p className="border-t border-gray-100 pt-3 text-xs text-gray-600" data-testid="offer-sheet-footer">
            Offer details are shared by {brand}. Terms apply.
          </p>
        </div>
      )}
    </Modal>
  );
}
