'use client';

import { useEffect, useState } from 'react';
import { getStoredUser } from '@/lib/auth-client';

/**
 * True only for a GIFSY_ADMIN (the owner) — for UI that is GIFSY_ADMIN-only on the API (e.g. the
 * per-client Ticket remarks email, Help & videos authoring). A UX gate only; the API enforces.
 * Read AFTER mount (localStorage) so SSR and the first client paint agree — false until then, so an
 * owner-only control appears a frame late rather than flashing for a user who cannot use it.
 */
export function useIsGifsyAdmin(): boolean {
  const [is, setIs] = useState(false);
  useEffect(() => {
    setIs(getStoredUser()?.role === 'GIFSY_ADMIN');
  }, []);
  return is;
}
