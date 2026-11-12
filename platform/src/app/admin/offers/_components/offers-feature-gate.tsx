'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { authHeader } from '@/lib/api-client';
import { normalizeFeatures } from '@/lib/tenant-features';

const CONFIG_ENDPOINT = '/api/admin/settings/config';

type GateState = 'loading' | 'on' | 'off' | 'error';

/**
 * Renders the Offers admin only when the current tenant's `offerTiles` feature is ON (served by
 * the authenticated /admin/settings/config endpoint — the same source the admin nav reads). The
 * flag controls the WHOLE feature: this admin page AND the partner-dashboard tiles.
 *
 * An un-assumed GIFSY_ADMIN resolves to the platform tenant, whose flag is OFF, so they see the
 * "assume a tenant" hint instead of a page that would 400 on every call. A FAILED settings fetch
 * (network / non-2xx / bad body) is NOT "not enabled" — it shows "Couldn't load settings" + Retry.
 * (Fetched here rather than via useTenantFeatures, which folds errors into the default flags.)
 */
export function OffersFeatureGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(CONFIG_ENDPOINT, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const res = (await r.json()) as { success?: boolean; data?: { features?: unknown } } | null;
        if (!res || res.success === false || !res.data) throw new Error('bad body');
        return normalizeFeatures(res.data.features).offerTiles;
      })
      .then((on) => { if (!cancelled) setState(on ? 'on' : 'off'); })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => { setState('loading'); setAttempt((a) => a + 1); }, []);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-64" data-testid="offers-gate-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div role="alert" className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-6" data-testid="offers-gate-error">
        <h2 className="text-base font-semibold text-gray-900">Couldn&apos;t load settings</h2>
        <p className="mt-1 text-sm text-gray-700">
          We could not check whether This Month&apos;s Offers is enabled for this tenant.
        </p>
        <Button variant="outline" className="mt-3" onClick={retry} data-testid="offers-gate-retry">
          Retry
        </Button>
      </div>
    );
  }

  if (state === 'off') {
    return (
      <div className="max-w-lg rounded-xl border border-gray-200 bg-white p-6" data-testid="offers-disabled">
        <h2 className="text-base font-semibold text-gray-900">This Month&apos;s Offers is not enabled</h2>
        <p className="mt-1 text-sm text-gray-600">
          Offers are switched on per tenant by Gifsy. If you are a Gifsy admin, assume a tenant that
          has the feature enabled.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
