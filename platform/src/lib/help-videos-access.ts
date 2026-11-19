'use client';

import { useEffect, useState } from 'react';
import { getStoredUser } from '@/lib/auth-client';

/**
 * Help & videos authoring is GIFSY_ADMIN-only on the API (@Roles('GIFSY_ADMIN') + tenancy:* permissions, and a
 * service-level check). The console hides its entry point from anyone else (e.g. GIFSY_STAFF) so they never land on
 * a page that can only 403. Read AFTER mount (localStorage) so SSR and the first client paint agree — false until
 * then, i.e. the link appears a frame late rather than flashing for a user who cannot use it.
 */
export function useCanManageHelpVideos(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    setCan(getStoredUser()?.role === 'GIFSY_ADMIN');
  }, []);
  return can;
}
