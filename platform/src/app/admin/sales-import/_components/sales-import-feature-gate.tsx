'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { authHeader } from '@/lib/api-client';
import { normalizeFeatures, ADMIN_FEATURES_URL } from '@/lib/tenant-features';

// Flags-only read (readable by an assumed GIFSY_STAFF without tenancy:read) — same `features` blob as /config.
const CONFIG_ENDPOINT = ADMIN_FEATURES_URL;

type GateState = 'loading' | 'on' | 'off' | 'error';

/**
 * Renders Sales Import only when the current tenant's `salesImport` feature is ON (same source as the admin nav:
 * the authenticated /admin/settings/features endpoint). Copy of the Offers gate. An un-assumed GIFSY_ADMIN resolves
 * to the platform tenant (flag OFF) → the "assume a tenant" hint. A FAILED fetch is NOT "not enabled": it shows
 * "Couldn't load settings" + Retry. The backend re-checks the flag (uncached) on every write anyway.
 */
export function SalesImportFeatureGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(CONFIG_ENDPOINT, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const res = (await r.json()) as { success?: boolean; data?: { features?: unknown } } | null;
        if (!res || res.success === false || !res.data) throw new Error('bad body');
        return normalizeFeatures(res.data.features).salesImport;
      })
      .then((on) => { if (!cancelled) setState(on ? 'on' : 'off'); })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => { setState('loading'); setAttempt((a) => a + 1); }, []);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-64" data-testid="sales-import-gate-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div role="alert" className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-6" data-testid="sales-import-gate-error">
        <h2 className="text-base font-semibold text-gray-900">Couldn&apos;t load settings</h2>
        <p className="mt-1 text-sm text-gray-700">We could not check whether Sales Import is enabled for this tenant.</p>
        <Button variant="outline" className="mt-3" onClick={retry}>Retry</Button>
      </div>
    );
  }

  if (state === 'off') {
    return (
      <div className="max-w-lg rounded-xl border border-gray-200 bg-white p-6" data-testid="sales-import-disabled">
        <h2 className="text-base font-semibold text-gray-900">Sales Import is not enabled</h2>
        <p className="mt-1 text-sm text-gray-600">
          Sales Import is switched on per tenant by Gifsy. If you are a Gifsy admin, assume a tenant that has the
          feature enabled.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
