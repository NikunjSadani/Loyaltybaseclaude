'use server';

/**
 * Wave 3 — active-outlet selection cookie (`active_partner_id`).
 *
 * One partner login can operate multiple outlets (its own + login-less same-group
 * siblings sharing its phone). The picker (/partner/select) and the shell switcher
 * write the chosen ChannelPartner id here; the edge proxy (src/proxy.ts) reads this
 * cookie and injects header `x-active-partner-id` on every `/api/*` request.
 *
 * This is UX STATE, not a credential: the BACKEND re-authorizes the id on every
 * request (a foreign id → 403), so a tampered cookie can never widen access. It is
 * httpOnly only for hygiene (no need for JS to read it) — there is NO token swap
 * here, unlike auth-actions.ts's assume/exit. Absent/empty cookie = operate the
 * login's OWN outlet, byte-identical to today's single-outlet behaviour.
 */

import { cookies } from 'next/headers';

const WEEK = 60 * 60 * 24 * 7;

const cookieOptions = (maxAge: number) => ({
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge,
  path: '/',
});

/**
 * Select the outlet this login operates. A non-null `partnerId` sets the selection
 * cookie; `null` clears it (revert to the login's own outlet — used by the Group
 * Overview entry, which is login-scoped rather than an operable outlet).
 */
export async function setActivePartner(
  partnerId: string | null,
): Promise<{ success: boolean }> {
  const cookieStore = await cookies();
  if (partnerId) {
    cookieStore.set('active_partner_id', partnerId, cookieOptions(WEEK));
  } else {
    cookieStore.delete('active_partner_id');
  }
  return { success: true };
}
