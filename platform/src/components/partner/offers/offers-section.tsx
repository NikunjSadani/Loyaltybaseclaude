'use client';

import React, { useEffect, useState } from 'react';
import {
  fetchPartnerOffers, groupOffers, sectionValidTill, OFFER_GROUP_LABEL, type OfferTilePartner,
} from '@/lib/offers';
import { OfferTileCard } from './offer-tile-card';
import { OfferSheet } from './offer-sheet';

/**
 * "This month's offers" — partner dashboard section (both dashboard variants).
 *
 * Mounted by the dashboard ONLY when the tenant's `offerTiles` flag is ON — the flag controls the
 * WHOLE feature (admin page AND these partner tiles), so a flag-OFF tenant (Deoleo) never mounts
 * this and makes zero offers requests.
 *
 * Self-fetching + self-hiding, like SchemesCard: `tiles` starts null so the FIRST render is
 * empty on server AND client (no hydration mismatch — the #58 lesson: no localStorage / Date
 * reads before mount). It stays absent (zero DOM) when the API returns no tile for this outlet
 * or errors.
 */
export function OffersSection() {
  const [tiles, setTiles] = useState<OfferTilePartner[] | null>(null);
  const [open, setOpen] = useState<OfferTilePartner | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPartnerOffers()
      .then((t) => { if (!cancelled) setTiles(t); })
      .catch(() => { if (!cancelled) setTiles([]); });
    return () => { cancelled = true; };
  }, []);

  if (!tiles || tiles.length === 0) return null;

  const validTill = sectionValidTill(tiles);

  return (
    <section data-testid="offers-section" aria-labelledby="offers-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="offers-heading" className="text-sm font-semibold text-gray-900">This month&apos;s offers</h2>
        {validTill && (
          <span data-testid="offers-valid-till" className="shrink-0 text-xs text-gray-600">
            Valid till {validTill}
          </span>
        )}
      </div>
      {groupOffers(tiles).map(({ group, tiles: gt }) => (
        <div key={group} className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{OFFER_GROUP_LABEL[group]}</p>
          <div data-testid={`offers-grid-${group}`} className="grid grid-cols-2 gap-2">
            {gt.map((t) => (
              <OfferTileCard key={t.id} tile={t} showValidTo={!validTill} onOpen={() => setOpen(t)} />
            ))}
          </div>
        </div>
      ))}
      <OfferSheet tile={open} onClose={() => setOpen(null)} />
    </section>
  );
}
