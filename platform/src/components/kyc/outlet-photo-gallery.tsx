'use client';

import React, { useState } from 'react';
import { X, Camera, ChevronLeft, ChevronRight, ImageIcon } from 'lucide-react';

export interface OutletPhoto {
  id:           string;
  fileUrl:      string;
  documentType: 'OUTLET_PHOTO' | 'SHOP_ESTABLISHMENT' | string;
  createdAt:    string;
}

interface Props {
  photos: OutletPhoto[];
}

/**
 * OutletPhotoGallery
 *
 * Shows a "View Photos (N)" button instead of pre-loading thumbnails.
 * Tapping the button opens a full-screen lightbox with prev / next navigation.
 * This is bandwidth-friendly: images are only fetched when the user explicitly opens the gallery.
 */
export function OutletPhotoGallery({ photos }: Props) {
  const [open,       setOpen]       = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);

  const prev = () => setPhotoIndex((i) => Math.max(0, i - 1));
  const next = () => setPhotoIndex((i) => Math.min(photos.length - 1, i + 1));

  return (
    <div>
      {/* ── Heading ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-3">
        <Camera className="h-3.5 w-3.5 text-gray-400" />
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
          {photos.length > 0 ? `Outlet Photos (${photos.length})` : 'Outlet Photos'}
        </p>
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {photos.length === 0 && (
        <p className="text-xs text-gray-400 italic">
          No outlet photos available for this enrollment.
        </p>
      )}

      {/* ── Lazy "View Photos" button ─────────────────────────────────────── */}
      {photos.length > 0 && (
        <button
          data-testid="outlet-photo-view-btn"
          type="button"
          onClick={() => { setPhotoIndex(0); setOpen(true); }}
          className="flex items-center gap-2 text-sm font-medium text-[var(--brand-primary)] hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40 rounded"
        >
          <ImageIcon className="h-4 w-4 shrink-0" />
          View Photos ({photos.length})
        </button>
      )}

      {/* ── Lightbox — only rendered (and images only fetched) when open ──── */}
      {open && (
        <div
          data-testid="outlet-photo-lightbox"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-w-full max-h-full flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Photo */}
            <img
              src={photos[photoIndex].fileUrl}
              alt={`Outlet photo ${photoIndex + 1} of ${photos.length}`}
              className="max-w-[90vw] max-h-[75vh] rounded-lg object-contain"
            />

            {/* Counter + navigation */}
            {photos.length > 1 && (
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  data-testid="photo-prev"
                  aria-label="Previous photo"
                  onClick={prev}
                  disabled={photoIndex === 0}
                  className="p-2 rounded-full bg-white/20 hover:bg-white/30 text-white disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>

                <span
                  data-testid="photo-counter"
                  className="text-sm font-semibold text-white tabular-nums"
                >
                  {photoIndex + 1} / {photos.length}
                </span>

                <button
                  type="button"
                  data-testid="photo-next"
                  aria-label="Next photo"
                  onClick={next}
                  disabled={photoIndex === photos.length - 1}
                  className="p-2 rounded-full bg-white/20 hover:bg-white/30 text-white disabled:opacity-30 transition-colors"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            )}

            {/* Close button */}
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="absolute -top-3 -right-3 bg-white rounded-full p-1 shadow-lg"
            >
              <X className="h-4 w-4 text-gray-700" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
