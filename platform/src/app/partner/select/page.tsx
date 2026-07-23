'use client';

/* ─── Wave 3 — Outlet picker (/partner/select) ────────────────────────────────
   Interposed between login and the partner dashboard for partner logins. One login
   can operate multiple outlets (its own + login-less same-group siblings sharing its
   phone) and — when in an owner group — view a read-only group overview.

   Single-outlet logins NEVER see this: once /partner/me settles, a login with
   <= 1 operable outlet and no group overview is forwarded straight to the dashboard,
   preserving today's behaviour exactly.

   Selecting an operable outlet writes the `active_partner_id` cookie (setActivePartner)
   then goes to the dashboard. Selecting Group Overview CLEARS the cookie (the overview
   is login-scoped, not an operable outlet) then goes to /partner/group (built by FE-2).
─────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Store, Users, ChevronRight, CheckCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { usePartnerIdentity } from '@/lib/partner-identity';
import { setActivePartner } from '@/lib/active-partner-actions';

export default function PartnerSelectPage() {
  const router = useRouter();
  const identity = usePartnerIdentity();
  const { loading, operableOutlets, groupOverviewAvailable } = identity;
  const [navigating, setNavigating] = useState(false);

  // Single-outlet logins never see a picker — forward to the dashboard once /partner/me
  // settles. Guarded on !loading so we don't act on the false-while-loading defaults.
  const skipPicker = !loading && operableOutlets.length <= 1 && !groupOverviewAvailable;
  useEffect(() => {
    if (skipPicker) router.replace('/partner/dashboard');
  }, [skipPicker, router]);

  async function chooseOutlet(partnerId: string) {
    setNavigating(true);
    await setActivePartner(partnerId);
    router.push('/partner/dashboard');
  }

  async function chooseGroupOverview() {
    setNavigating(true);
    // Overview is login-scoped, not an operable outlet — clear any prior selection.
    await setActivePartner(null);
    router.push('/partner/group');
  }

  // While loading, or while we're mid-forward for a single-outlet login, show a spinner
  // (never flash the picker to a single-outlet user).
  if (loading || skipPicker) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Spinner size="xl" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Choose an outlet</h1>
        <p className="text-sm text-gray-500 mt-1">
          Select which outlet you want to work in.
        </p>
      </div>

      <div className="space-y-3">
        {operableOutlets.map((o) => (
          <button
            key={o.partnerId}
            type="button"
            disabled={navigating}
            onClick={() => chooseOutlet(o.partnerId)}
            className="w-full flex items-center gap-3 text-left bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-4 hover:border-[var(--brand-primary)] hover:shadow transition-all disabled:opacity-60"
          >
            <div className="w-10 h-10 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
              <Store className="h-5 w-5 text-[var(--brand-primary)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 truncate">{o.businessName}</p>
                {o.isOwnLogin && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 rounded-full px-1.5 py-0.5 shrink-0">
                    <CheckCircle className="h-3 w-3" /> Your outlet
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-400 truncate">{o.outletCode}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
          </button>
        ))}

        {groupOverviewAvailable && (
          <button
            type="button"
            disabled={navigating}
            onClick={chooseGroupOverview}
            className="w-full flex items-center gap-3 text-left bg-white rounded-xl border border-dashed border-gray-300 shadow-sm px-4 py-4 hover:border-[var(--brand-primary)] hover:shadow transition-all disabled:opacity-60"
          >
            <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-gray-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Group Overview</p>
              <p className="text-xs text-gray-400">Read-only summary across your group</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
          </button>
        )}
      </div>
    </div>
  );
}
