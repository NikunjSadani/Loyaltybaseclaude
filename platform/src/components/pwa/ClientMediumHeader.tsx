'use client';

// -----------------------------------------------------------------------------
// ClientMediumHeader — tags every same-origin /api request with
// `X-Client-Medium: app | browser` for the Usage Report (lib/client-medium.ts).
//
// The fetch patch is installed when THIS MODULE IS EVALUATED in the browser — before
// any page effect fires its first request — not in an effect (effects of the page
// run before a sibling's, so an effect-installed patch would miss the first calls).
// The effect below is only a belt-and-braces re-check (idempotent). All tenants: the
// header carries no personal data and only feeds the Usage Report. Renders nothing.
// -----------------------------------------------------------------------------
import { useEffect } from 'react';
import { installClientMediumHeader } from '@/lib/client-medium';

if (typeof window !== 'undefined') installClientMediumHeader();

export default function ClientMediumHeader() {
  useEffect(() => {
    installClientMediumHeader();
  }, []);
  return null;
}
