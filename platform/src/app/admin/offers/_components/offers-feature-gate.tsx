'use client';

import React from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useTenantFeatures } from '@/lib/tenant-features';

/**
 * Renders the Offers admin only when the current tenant's `offerTiles` feature is ON (served by
 * the authenticated /admin/settings/config endpoint — the same source the admin nav reads).
 * An un-assumed GIFSY_ADMIN resolves to the platform tenant, whose flag is OFF, so they see the
 * "assume a tenant" hint instead of a page that would 400 on every call.
 */
export function OffersFeatureGate({ children }: { children: React.ReactNode }) {
  const { features, loading } = useTenantFeatures('/api/admin/settings/config');

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64" data-testid="offers-gate-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!features.offerTiles) {
    return (
      <div className="max-w-lg rounded-xl border border-gray-200 bg-white p-6" data-testid="offers-disabled">
        <h2 className="text-base font-semibold text-gray-900">This Month&apos;s Offers is not enabled</h2>
        <p className="mt-1 text-sm text-gray-500">
          Offers are switched on per tenant by Gifsy. If you are a Gifsy admin, assume a tenant that
          has the feature enabled.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
