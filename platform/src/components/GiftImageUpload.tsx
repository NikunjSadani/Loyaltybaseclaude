'use client';

/**
 * GiftImageUpload — REAL file → portal image upload control shared by BOTH gift
 * editors:
 *   • the PLATFORM master editor  (/admin/gift-catalogue)     — GIFSY_ADMIN
 *   • the per-tenant reward editor (/admin/gifts, ItemModal)  — GIFSY_ADMIN + CLIENT_ADMIN
 *
 * It mirrors the existing branding-asset uploader (gifsy/clients/[slug] AssetSlot):
 * a hidden <input type=file>, a multipart POST to the ONE gift-image endpoint, a
 * spinner while in flight, an inline error, and a thumbnail preview of each stored
 * URL with a remove control. The endpoint sniffs magic bytes (images only) + caps at
 * 5 MB and returns the PUBLIC storage.googleapis.com URL, which renders directly in
 * an <img> (gift images aren't sensitive — owner-approved public, same bucket the
 * brand logos/favicons render from).
 *
 * The control speaks string[] (the stored `imageUrls` shape); each page adapts its
 * own form state around that. Auth flows via the /api proxy cookie (authHeader() is
 * intentionally empty — the same posture as the KYC + fulfilment uploads).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Upload, Loader2, ImageOff, X } from 'lucide-react';
import { authHeader } from '@/lib/api-client';

/** The ONE multipart gift-image endpoint both editors call (see GiftCatalogueController). */
export const GIFT_IMAGE_UPLOAD_URL = '/api/admin/gift-catalogue/image';

/** Client-side guards — must MIRROR the server (5 MB + image/* only) so the user gets
 *  instant feedback instead of streaming a bad file and waiting for a 400. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_PREFIX = 'image/';

/** POST the picked file and return the stored PUBLIC URL (or an error). */
export async function uploadGiftImage(
  file: File,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const fd = new FormData();
    fd.append('file', file);
    // Do NOT set Content-Type — the browser sets the multipart boundary.
    const res = await fetch(GIFT_IMAGE_UPLOAD_URL, {
      method: 'POST',
      headers: authHeader(),
      body: fd,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.success || !j?.data?.url) {
      return { ok: false, error: j?.error || j?.message || `Upload failed (HTTP ${res.status})` };
    }
    return { ok: true, url: j.data.url as string };
  } catch {
    return { ok: false, error: 'Network error — please try again.' };
  }
}

/** One thumbnail with a broken-image fallback + a remove button. */
function Thumb({ url, onRemove }: { url: string; onRemove: () => void }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);
  return (
    <div className="relative w-16 h-16 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center group">
      {broken ? (
        <ImageOff className="w-5 h-5 text-amber-400" aria-label="Preview unavailable" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="Gift image"
          className="max-h-full max-w-full object-contain"
          onError={() => setBroken(true)}
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove image"
        data-testid="gift-image-remove"
        // Visible on hover for mouse users, but also on keyboard focus and on
        // touch/coarse-pointer devices (where hover never fires) so it's reachable.
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

export function GiftImageUpload({
  value,
  onChange,
  onUploadingChange,
  disabled,
}: {
  /** Current stored image URLs. */
  value: string[];
  /** Called with the next array after an upload or a removal. */
  onChange: (urls: string[]) => void;
  /** Fires true while an upload is in flight and false when it settles, so the
   *  parent can block its own Save (otherwise a Save during an in-flight upload
   *  drops the image — the onChange lands after the modal unmounts). */
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The async upload resolves LATER — reading `value` from the closure captured
  // at upload-start would resurrect an image the user removed mid-upload (and use
  // a stale de-dupe set). A ref always holds the latest committed value.
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  const setBusy = (b: boolean) => {
    setUploading(b);
    onUploadingChange?.(b);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after an error
    if (!file) return;
    // Client-side guards MIRROR the server (5 MB + image/* only): instant, honest
    // feedback instead of streaming a bad file and waiting for a 400/413.
    if (!file.type.startsWith(ACCEPTED_IMAGE_PREFIX)) {
      setError('Please choose an image file (PNG, JPG, WEBP, or GIF).');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('Image is too large — the maximum size is 5 MB.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await uploadGiftImage(file);
    setBusy(false);
    if (!res.ok || !res.url) {
      setError(res.error ?? 'Upload failed');
      return;
    }
    // De-dupe + append against the LATEST value (not the stale closure).
    const current = valueRef.current;
    if (!current.includes(res.url)) onChange([...current, res.url]);
  };

  return (
    <div className="space-y-2" data-testid="gift-image-upload">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((url) => (
            <Thumb key={url} url={url} onRemove={() => onChange(value.filter((u) => u !== url))} />
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        data-testid="gift-image-input"
        onChange={onFile}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || disabled}
        aria-busy={uploading}
        data-testid="gift-image-upload-btn"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
      >
        {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
        {uploading ? 'Uploading…' : value.length > 0 ? 'Add another image' : 'Upload image'}
      </button>

      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}
