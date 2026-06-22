'use client';

import { useState, useEffect } from 'react';
import { Tag } from 'lucide-react';
import {
  MASTER_OUTLET_TYPES,
  type OutletType,
} from '@/lib/platform/outlet-types';
import { authHeader } from '@/lib/api-client';

/* ─── API types & mapping ──────────────────────────────────────────────────── */
interface ApiOutletTypeConfig {
  outletTypeCode: string;
  outletTypeName: string;
  displayName?: string | null;
  isEnabled: boolean;
}

function mapApiOutletType(c: ApiOutletTypeConfig): OutletType {
  return {
    code:        c.outletTypeCode,
    name:        c.displayName ?? c.outletTypeName,
    description: '',
    isActive:    c.isEnabled,
    createdAt:   '',
  };
}

// Use 'platform' as the default client slug for the global outlet types view
const OUTLET_TYPE_CLIENT_SLUG = 'platform';

/**
 * Global outlet-type master list — READ-ONLY.
 *
 * Creating / renaming / globally toggling outlet types has no backend (there is no global
 * OutletType CRUD by design), so this page only DISPLAYS the catalog. The real, persisted
 * control is **per client** on the client-detail page (enable/disable + display-name override),
 * which upserts OutletTypeClientConfig. Showing fake Add/Rename/Toggle buttons here would be
 * misleading (they only mutated local state), so they have been removed.
 */
export default function OutletTypesPage() {
  // Initial state = MASTER_OUTLET_TYPES so existing synchronous tests keep passing.
  // The useEffect silently overrides with live API data when available.
  const [types, setTypes] = useState<OutletType[]>(MASTER_OUTLET_TYPES);

  useEffect(() => {
    fetch(`/api/gifsy/clients/${OUTLET_TYPE_CLIENT_SLUG}/outlet-type-configs`, { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: { success: boolean; data?: ApiOutletTypeConfig[]; error?: string }) => {
        if (json.success && Array.isArray(json.data)) {
          setTypes(json.data.map(mapApiOutletType));
        }
        // On failure, keep initial MASTER_OUTLET_TYPES (best-effort fallback)
      })
      .catch(() => { /* silent fail — keep static fallback */ });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white" role="heading">Outlet Types</h1>
        <p className="text-sm text-white/50 mt-0.5">
          Global master list of outlet types across the platform.
        </p>
      </div>

      {/* Info note */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-xs text-blue-300 flex items-start gap-2">
        <Tag className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          This catalog is read-only. To enable, disable, or rename a type <strong>for a specific
          client</strong>, open that client&apos;s detail page — those changes are saved per tenant.
        </span>
      </div>

      {/* Outlet type list */}
      <div className="space-y-2">
        {types.map((t) => (
          <div
            key={t.code}
            className="border border-white/10 rounded-xl px-5 py-4 bg-white/5 flex items-center gap-4"
          >
            {/* Code chip — only shown when code differs from current name */}
            <div className="shrink-0 w-36">
              {t.code !== t.name && (
                <span className="font-mono text-xs text-white/40 bg-white/5 border border-white/10 px-2 py-1 rounded-md">
                  {t.code}
                </span>
              )}
            </div>

            {/* Name */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">{t.name}</p>
              {t.description && (
                <p className="text-xs text-white/40 mt-0.5">{t.description}</p>
              )}
            </div>

            {/* Status badge */}
            <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
              t.isActive
                ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                : 'bg-red-500/15 text-red-400 border border-red-500/20'
            }`}>
              {t.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
        ))}
      </div>

      {/* Footer note */}
      <p className="text-xs text-white/30 text-center">
        Per-tenant outlet type configuration is managed in each client&apos;s detail page.
      </p>
    </div>
  );
}
