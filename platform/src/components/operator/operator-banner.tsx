'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert, LogOut } from 'lucide-react';
import { getAssumedBrand, clearAssumedContext, exitTenant } from '@/lib/auth-client';
import { getAssumedContext } from '@/lib/auth-actions';

/**
 * Persistent "Working in <Brand>" banner (A2/#51). Shown across every shell whenever
 * a GIFSY operator is in an assumed tenant context, so they can never act on the
 * wrong brand's data by mistake (the Salesforce "Login As" / Stripe account-indicator
 * guardrail). "Exit" restores the gifsy (home) operator session.
 */
export function OperatorBanner() {
  const [brand, setBrand] = useState<string | null>(null);

  useEffect(() => {
    // Optimistic instant render from the localStorage hint…
    setBrand(getAssumedBrand());
    // …then reconcile against SERVER TRUTH (the actual httpOnly cookie). This is the
    // AF-6 self-heal: if the real token isn't an assumed-tenant token (expired, exited
    // in another tab, stale hint), the banner clears — it can never mislead the operator.
    let alive = true;
    const reconcile = () => {
      getAssumedContext()
        .then(({ brandName }) => {
          if (!alive) return;
          setBrand(brandName);
          if (!brandName) clearAssumedContext();
        })
        .catch(() => {});
    };
    reconcile();
    // Re-check on tab focus + cross-tab assume/exit.
    const onStorage = () => setBrand(getAssumedBrand());
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', reconcile);
    return () => {
      alive = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', reconcile);
    };
  }, []);

  if (!brand) return null;

  return (
    <div className="sticky top-0 z-[60] flex items-center justify-center gap-3 bg-amber-500 text-amber-950 text-sm font-medium px-4 py-1.5 shadow">
      <ShieldAlert className="w-4 h-4 shrink-0" />
      <span>
        Gifsy operator — working in <strong>{brand}</strong>
      </span>
      <button
        onClick={async () => {
          await exitTenant();
          window.location.href = '/gifsy';
        }}
        className="inline-flex items-center gap-1 rounded bg-amber-950/10 hover:bg-amber-950/20 px-2 py-0.5 transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" /> Exit to platform
      </button>
    </div>
  );
}
