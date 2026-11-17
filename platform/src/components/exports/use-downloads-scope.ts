'use client';

/**
 * Which brand's Downloads the person is looking at — the same tenant the API scopes the list to
 * (the caller's own requests in their current, possibly assumed, brand).
 *
 *  - Gifsy operator working in a brand (assumed) → that brand.
 *  - Brand user (CLIENT_ADMIN / MIS_USER)        → the brand the shell already shows (clientConfig).
 *  - Gifsy operator NOT in a brand               → no brand: "files requested outside a brand".
 */
import { useEffect, useState } from 'react';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { useAssumedContext } from '@/lib/use-assumed-context';
import { getStoredUser } from '@/lib/auth-client';
import { seenStorageKey } from '@/lib/exports/seen';

export interface DownloadsScope {
  /** Brand name to show, or null when the list is the person's files outside any brand. */
  brandName: string | null;
  /** localStorage key for the "seen" ids (per user + brand). */
  seenKey: string;
}

export function useDownloadsScope(): DownloadsScope {
  const clientConfig = useClientConfig();
  const { brand: assumedBrand } = useAssumedContext();
  const [user, setUser] = useState<{ id: string | null; role: string | null }>({ id: null, role: null });
  useEffect(() => {
    try {
      const u = getStoredUser();
      setUser({ id: u?.id ?? null, role: u?.role ?? null });
    } catch {
      /* storage blocked — anonymous key */
    }
  }, []);

  const isGifsy = user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF';
  const brandName = assumedBrand
    ?? (isGifsy ? null : (clientConfig?.slug && clientConfig.slug !== 'default' ? clientConfig.branding?.displayName ?? null : null));
  const brandKey = assumedBrand ?? (isGifsy ? null : clientConfig?.slug ?? null);
  return { brandName, seenKey: seenStorageKey(user.id, brandKey) };
}
