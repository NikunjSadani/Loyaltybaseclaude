/**
 * Return-to after sign-in (`/auth/login?next=<path>`), e.g. a client admin opening the
 * "remarks needed" email link while signed out lands back on `/admin/tickets?ticket=…`
 * after the OTP instead of on their dashboard.
 *
 * Open-redirect safe by construction: only a same-origin RELATIVE path is ever accepted
 * (must start with a single "/", no scheme, no protocol-relative "//", no backslashes or
 * control characters, never back into /auth), and only into a portal the signed-in role is
 * admitted to (admin / sales — partner logins always go through the outlet picker first).
 */

import { VISIBILITY_PHOTO_PREFIX, VISIBILITY_PHOTO_ROLES } from './visibility-photo-link';

const NEXT_PARAM = 'next';
const MAX_LEN = 1024;

/** PORTAL prefix → roles admitted (mirrors PORTAL_ROLES in auth-client; partner deliberately absent). */
const RETURN_TO_PORTALS: Record<string, string[]> = {
  '/admin': ['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF'],
  '/sales': ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
  // The Visibility report's photo links land back on the viewer page after sign-in.
  [VISIBILITY_PHOTO_PREFIX]: VISIBILITY_PHOTO_ROLES,
};

/** A safe same-origin relative path (path + query + hash), or null. Pure. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string' || raw.length > MAX_LEN) return null;
  // Exactly one leading slash; reject protocol-relative ("//evil", "/\\evil") and backslashes anywhere.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  // No control characters / whitespace tricks (e.g. "/\t/evil.com").
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://return-to.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://return-to.invalid') return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.startsWith('/auth') || path.startsWith('/api/')) return null;
  return path;
}

/** The safe `next` target for this role, or null (→ the caller uses the role's normal home). */
export function returnPathForRole(raw: string | null | undefined, role: string | null | undefined): string | null {
  const path = safeReturnPath(raw);
  if (!path || !role) return null;
  const portal = Object.keys(RETURN_TO_PORTALS).find((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
  return portal && RETURN_TO_PORTALS[portal].includes(role) ? path : null;
}

/** `/auth/login?next=<current path>` — or plain `/auth/login` when the current path isn't a safe target. */
export function loginUrlWithNext(currentPathWithQuery: string | null | undefined, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  const next = safeReturnPath(currentPathWithQuery);
  if (next) params.set(NEXT_PARAM, next);
  const qs = params.toString();
  return qs ? `/auth/login?${qs}` : '/auth/login';
}

/** Reads `?next=` from a query string (e.g. window.location.search). */
export function readNextParam(search: string | null | undefined): string | null {
  try {
    return new URLSearchParams(search ?? '').get(NEXT_PARAM);
  } catch {
    return null;
  }
}

/**
 * The `next` to carry on an edge login redirect — ONLY for a real document navigation (a user
 * opening the URL). RSC fetches, router prefetches and other non-document requests get no `next`
 * (their URL is an internal fetch, not where the user was going). `_rsc` is stripped. Self-contained
 * so the proxy's redirect branches can call it in one place. Returns null when no `next` applies.
 */
export function returnToForEdgeRedirect(
  pathname: string,
  search: string,
  headers: { get(name: string): string | null },
): string | null {
  const h = (n: string) => (headers.get(n) ?? '').toLowerCase();
  if (h('rsc') === '1' || h('next-router-prefetch') || h('next-router-state-tree')) return null;
  if (h('purpose') === 'prefetch' || h('sec-purpose').includes('prefetch')) return null;
  const dest = h('sec-fetch-dest');
  const isDocument = dest ? dest === 'document' : h('accept').includes('text/html');
  if (!isDocument) return null;
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const qs = params.toString();
  return safeReturnPath(`${pathname}${qs ? `?${qs}` : ''}`);
}
