/**
 * Page-size ceilings for list endpoints (memory-safety, 2026-11-13).
 *
 * Every `limit` / `pageSize` query param carries an `@Max`, so `?limit=100000` can never
 * load a whole tenant into one request. 100 is the default ceiling; a list whose screen
 * genuinely asks for more gets its own named constant with the FE caller noted.
 */
export const PAGE_SIZE_MAX = 100;

/**
 * GET /v1/kyc — the admin KYC screen (platform/src/app/admin/kyc/page.tsx) loads
 * `?limit=500` in one call, so this list keeps 500 as its ceiling.
 */
export const KYC_LIST_MAX_LIMIT = 500;
