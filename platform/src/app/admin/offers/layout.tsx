import { RequireAuth } from '@/components/auth/require-auth';
import { OffersFeatureGate } from './_components/offers-feature-gate';

/**
 * Route guard for /admin/offers ("This month's offers") — GIFSY_ADMIN (assumed into a tenant) +
 * CLIENT_ADMIN, AND the tenant feature `offerTiles` (default OFF). Matches the `offersAdmin` +
 * `featureFlag: 'offerTiles'` nav gate in admin/layout.tsx so nav visibility and direct-URL access
 * agree. The backend independently scopes every read/write to the caller's tenant.
 */
export default function OffersLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>
      <OffersFeatureGate>{children}</OffersFeatureGate>
    </RequireAuth>
  );
}
