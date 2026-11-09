'use client';

import React from 'react';
import { Modal } from '@/components/ui/modal';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';
import { formatOfferValue, formatOfferDay, OFFER_GROUP_LABEL, type OfferTilePartner } from '@/lib/offers';

/** Bottom-sheet override for the shared Radix Modal (focus trap + Esc come from Radix). */
const SHEET_CLASS =
  'top-auto bottom-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none rounded-b-none ' +
  'sm:left-1/2 sm:-translate-x-1/2 sm:max-w-lg';

/** Brand name for the D5 disclaimer; the neutral placeholder config counts as "unknown". */
export function offerBrandName(displayName: string | null | undefined): string {
  const n = (displayName ?? '').trim();
  if (!n || n === DEFAULT_CLIENT_CONFIG.branding.displayName) return 'your brand';
  return n;
}

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Detail sheet for one tile. `tile === null` ⇒ closed. Plain text only (no HTML injection). */
export function OfferSheet({ tile, onClose }: { tile: OfferTilePartner | null; onClose: () => void }) {
  const brand = offerBrandName(useClientConfig()?.branding?.displayName);
  const pr = tile?.progress ?? null;
  const hasTarget = !!pr && pr.target !== null && pr.target > 0;

  return (
    <Modal
      open={tile !== null}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={tile?.label ?? 'Offer'}
      description={tile ? OFFER_GROUP_LABEL[tile.group] : undefined}
      className={SHEET_CLASS}
    >
      {tile && (
        <div className="space-y-4" data-testid="offer-sheet">
          <div>
            <p className="text-3xl font-extrabold leading-tight text-[var(--brand-primary)]">
              {formatOfferValue(tile)}
              {tile.unitLabel && (
                <span className="ml-1.5 text-sm font-medium text-gray-500">{tile.unitLabel}</span>
              )}
            </p>
            {tile.product && <p className="mt-1 text-sm font-semibold text-gray-900">{tile.product}</p>}
          </div>

          {pr && (
            <div className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700" data-testid="offer-sheet-progress">
              <p className="font-semibold text-gray-900">Your progress · {pr.kpiName}</p>
              {hasTarget ? (
                <p className="mt-0.5">
                  {fmt(pr.achieved)} / {fmt(pr.target as number)}{pr.unit ? ` ${pr.unit}` : ''}
                  {pr.pct !== null ? ` · ${pr.pct}%` : ''}
                  {pr.unlocked && <span className="ml-1 font-bold text-emerald-700">· Unlocked</span>}
                </p>
              ) : (
                <p className="mt-0.5 text-gray-500">No target set for this month yet.</p>
              )}
            </div>
          )}

          {tile.details && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Details</h3>
              <p className="mt-1 whitespace-pre-line text-sm text-gray-700">{tile.details}</p>
            </div>
          )}

          <p className="text-xs font-medium text-gray-600">Valid till {formatOfferDay(tile.validTo)}</p>

          <p className="border-t border-gray-100 pt-3 text-[11px] text-gray-400" data-testid="offer-sheet-footer">
            Offer details are shared by {brand}. Terms apply.
          </p>
        </div>
      )}
    </Modal>
  );
}
