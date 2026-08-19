/* ─── RBAC Option-X P6 — admin route → required-permission map ─────────────────
   Mirrors the NAV config in src/app/admin/layout.tsx: each admin route (and the
   child paths under it) maps to the natural permission key from the backend
   catalog (api/src/common/rbac/permissions.ts). A GIFSY_STAFF operator who lacks
   the mapped permission for the route they land on is shown <AccessDenied/> by
   the AdminRouteGuard — the nav item STAYS visible; accessing it lands on a clear
   message rather than a raw 403 or a hidden item.

   This gates GIFSY_STAFF ONLY (usePermissions().has() is always true for every
   other role), so this map never affects the owner or any other role.

   Routes deliberately left UNGATED (fail-OPEN to the page — the backend still
   403s their data) because their natural permission is genuinely ambiguous:
     - /admin/dashboard   (Overview landing — no single resource)
     - /admin/sales       (Sales Data — no dedicated sales-data permission key)
   Add a route here to gate it; omit it to leave it open.
─────────────────────────────────────────────────────────────────────────────── */

/**
 * Route-prefix → permission. Keys are matched most-specific-first: a pathname
 * matches a key when it equals the key OR starts with `key + '/'`, and the
 * LONGEST matching key wins. So '/admin/users/outlets' resolves to partners:read
 * even though '/admin/users' (users:read) is also a prefix. Note the '/'-boundary:
 * '/admin/tds-config' does NOT match the '/admin/tds' key (no slash between).
 */
export const ROUTE_PERMISSIONS: Record<string, string> = {
  // Dashboards (analytics/reporting reads)
  '/admin/dashboards':               'reports:read',
  '/admin/dashboards/kyc':           'kyc:read',
  '/admin/dashboards/program-health':'reports:read',
  '/admin/dashboards/operations':    'reports:read',
  '/admin/dashboards/finance':       'reports:read',

  // KYC (viewing the queue/approvals is a read; the approve ACTION is gated at
  // action-level with kyc:gifsy_approve)
  '/admin/kyc':                      'kyc:read',
  '/admin/kyc/approvals':            'kyc:read',

  // User management group
  '/admin/users':                    'users:read',
  '/admin/users/outlets':            'partners:read',
  '/admin/users/parents':            'partners:read',
  '/admin/hierarchy':                'sales_org:read',

  // Schemes (GIFSY-operated) + tenant read-only scheme reports
  '/admin/schemes':                  'schemes:read',
  '/admin/scheme-reports':           'schemes:read',

  // Outlet wallet (points viewer + adjust — money-adjacent)
  '/admin/outlet-wallet':            'wallet:read',

  // Visibility (POSM) + tenant read-only reports
  '/admin/visibility':               'visibility:read',
  '/admin/visibility-reports':       'visibility:read',

  // Visibility self-billing invoices (list + upload)
  '/admin/invoices':                 'invoices:read',

  // Redemption payouts + fund
  '/admin/payouts':                  'payouts:read',

  // Gift catalogue
  '/admin/gifts':                    'rewards:read',

  // Targets & achievements
  '/admin/targets':                  'targets:read',

  // Awards & credits → payouts (upload / status / payout / fields)
  '/admin/credits-payouts':          'credits:read',

  // TDS & invoicing section — each maps to the TDS-view permission.
  // Listed explicitly because these are SIBLING paths (/admin/tds-config, not
  // /admin/tds/config) so the '/'-boundary prefix match won't fold them together.
  '/admin/tds':                      'payouts:view_tds',
  '/admin/tds-config':               'payouts:view_tds',
  '/admin/tds-payouts':              'payouts:view_tds',
  '/admin/tds-recovery':             'payouts:view_tds',
  '/admin/tds-rcm':                  'payouts:view_tds',
  '/admin/gst-reimbursements':       'payouts:view_tds',

  // Support tickets
  '/admin/tickets':                  'support:read',

  // Engagement (banners)
  '/admin/banners':                  'engagement:read',

  // Reporting & analytics
  '/admin/reports':                  'reports:read',
  '/admin/app-adoption':             'reports:read',

  // Tenancy & platform configuration
  '/admin/settings':                 'tenancy:read',
};

/**
 * Resolve the permission required to VIEW the given admin path, or null when the
 * path is intentionally ungated (fail-open) or unknown. Most-specific (longest)
 * matching key wins; matching uses an exact hit or a '/'-boundary prefix so a
 * deep sub-path (e.g. /admin/users/123/edit) inherits its section's permission.
 */
export function requiredPermissionForPath(pathname: string): string | null {
  let bestKey: string | null = null;
  for (const key of Object.keys(ROUTE_PERMISSIONS)) {
    if (pathname === key || pathname.startsWith(key + '/')) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? ROUTE_PERMISSIONS[bestKey] : null;
}
