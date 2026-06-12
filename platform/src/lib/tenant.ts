/**
 * Tenant resolution helpers for API routes.
 *
 * The Edge Middleware sets `x-tenant-slug` on every request based on the
 * subdomain (e.g. deoleo.loyaltybase.in → "deoleo").
 * API routes call getClientIdFromRequest() to scope all DB queries.
 */

export const DEFAULT_CLIENT_ID = 'deoleo';

/**
 * Extracts the clientId from the `x-tenant-slug` request header.
 * Falls back to DEFAULT_CLIENT_ID (Deoleo) when the header is absent —
 * covers localhost dev and any edge case where middleware didn't run.
 */
export function getClientIdFromRequest(req: {
  headers: { get: (key: string) => string | null };
}): string {
  const slug = req.headers.get('x-tenant-slug');
  if (!slug || slug.trim() === '') return DEFAULT_CLIENT_ID;
  return slug.trim().toLowerCase();
}
