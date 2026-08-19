'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Loader2, ArrowRight } from 'lucide-react';
import { assumeTenant } from '@/lib/auth-client';

interface Brand {
  id?: string;
  slug: string;
  internalName: string;
  status: string;
}

/** Compact sidebar dropdown ("menu") vs. an expanded inline picker ("panel"). */
type Variant = 'menu' | 'panel';

/**
 * "Work in brand" — the GIFSY operator-context switcher (A2/#51, RBAC Option-X P5).
 *
 * Fed by GET /api/gifsy/my-assumable-clients, which returns the CALLER's assumable
 * brands: for the owner (GIFSY_ADMIN) every ACTIVE/ONBOARDING tenant; for a limited
 * GIFSY_STAFF only their granted brands (possibly empty). On select it exchanges the
 * gifsy session for a tenant-scoped token (existing `assumeTenant` flow) and lands the
 * operator in the admin shell for that brand. The persistent context is shown by
 * <OperatorBanner/>.
 *
 * Variants:
 *  - `menu`  (default) — the compact "Work in brand ▾" dropdown in the /gifsy sidebar
 *    footer. Owner uses this; behaviour unchanged.
 *  - `panel` — an expanded inline picker for the GIFSY_STAFF launchpad. Handles the
 *    three staff cases explicitly: exactly one granted brand → one-click "Work in
 *    {brand}"; multiple → a picker; zero → a clear empty state.
 */
export function BrandSwitcher({ variant = 'menu' }: { variant?: Variant } = {}) {
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(variant === 'panel');
  const [loaded, setLoaded] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const loadBrands = useCallback(() => {
    setLoading(true);
    setError(null);
    // Auth is the httpOnly `token` cookie (AF-6); same-origin fetch carries it and the
    // proxy injects the backend Bearer — no client Authorization header needed.
    fetch('/api/gifsy/my-assumable-clients')
      .then((r) => r.json())
      .then((j) => setBrands(
        // Operator can assume ACTIVE and ONBOARDING tenants (ONBOARDING un-dead-ends a
        // freshly onboarded brand); INACTIVE stays hidden. ACTIVE first so live brands
        // read primary.
        ((j.data?.clients ?? []) as Brand[])
          .filter((c) => c.status === 'ACTIVE' || c.status === 'ONBOARDING')
          .sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1)),
      ))
      .catch(() => setError('Could not load brands'))
      .finally(() => { setLoading(false); setLoaded(true); });
  }, []);

  // Panel loads eagerly (it IS the page's primary content); menu loads lazily on open.
  useEffect(() => {
    if (variant === 'panel') loadBrands();
  }, [variant, loadBrands]);

  useEffect(() => {
    if (variant !== 'menu' || !open || loaded) return;
    loadBrands();
  }, [variant, open, loaded, loadBrands]);

  // Close the menu dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const pick = useCallback(async (slug: string) => {
    setSwitching(slug);
    setError(null);
    try {
      await assumeTenant(slug);
      // Land the operator in the admin shell for the brand they just entered.
      window.location.href = '/admin/dashboard';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Switch failed');
      setSwitching(null);
    }
  }, []);

  // ── Panel variant — the GIFSY_STAFF launchpad ─────────────────────────────────
  if (variant === 'panel') {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-sm text-white/50 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your brands…
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={loadBrands}
            className="px-3 py-1.5 text-xs font-medium border border-white/20 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    if (brands.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center text-center gap-2 rounded-xl border border-white/10 bg-white/5 py-12 px-6">
          <Building2 className="w-6 h-6 text-white/30" />
          <p className="text-sm font-medium text-white/70">No brands assigned yet</p>
          <p className="text-xs text-white/40">Ask your admin to grant you a brand to work in.</p>
        </div>
      );
    }
    // Exactly one granted brand → one-click entry.
    if (brands.length === 1) {
      const only = brands[0];
      return (
        <button
          onClick={() => pick(only.slug)}
          disabled={!!switching}
          className="w-full flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-4 py-4 text-left transition-colors disabled:opacity-50"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center text-sm font-bold shrink-0">
              {only.internalName[0]}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-white truncate">Work in {only.internalName}</span>
              <span className="block text-xs text-white/40 truncate">{only.slug}</span>
            </span>
          </span>
          {switching === only.slug
            ? <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            : <ArrowRight className="w-4 h-4 text-white/40 shrink-0" />}
        </button>
      );
    }
    // Multiple granted brands → a picker.
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-white/40 mb-1">Choose a brand to work in</p>
        {brands.map((b) => (
          <button
            key={b.slug}
            onClick={() => pick(b.slug)}
            disabled={!!switching}
            className="w-full flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-4 py-3 text-left transition-colors disabled:opacity-50"
          >
            <span className="flex items-center gap-3 min-w-0">
              <span className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-xs font-bold shrink-0">
                {b.internalName[0]}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-white truncate">{b.internalName}</span>
                  {b.status === 'ONBOARDING' && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-1 py-px">
                      Onboarding
                    </span>
                  )}
                </span>
                <span className="block text-xs text-white/40 truncate">{b.slug}</span>
              </span>
            </span>
            {switching === b.slug
              ? <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              : <ArrowRight className="w-4 h-4 text-white/40 shrink-0" />}
          </button>
        ))}
      </div>
    );
  }

  // ── Menu variant — the compact sidebar dropdown (owner) ───────────────────────
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm bg-white/5 text-white/80 hover:bg-white/10 transition-colors"
      >
        <span className="flex items-center gap-2"><Building2 className="w-4 h-4" /> Work in brand</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 right-0 rounded-lg border border-white/10 bg-gray-900 shadow-xl py-1 z-50 max-h-72 overflow-auto">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/50">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading brands…
            </div>
          )}
          {error && <div className="px-3 py-2 text-xs text-red-400">{error}</div>}
          {!loading && !error && brands.length === 0 && (
            <div className="px-3 py-2 text-xs text-white/40">No brands available.</div>
          )}
          {brands.map((b) => (
            <button
              key={b.slug}
              onClick={() => pick(b.slug)}
              disabled={!!switching}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left text-white/80 hover:bg-white/10 disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate">{b.internalName}</span>
                {b.status === 'ONBOARDING' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-1 py-px">
                    Onboarding
                  </span>
                )}
              </span>
              {switching === b.slug
                ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                : <span className="text-[10px] text-white/30 font-mono shrink-0">{b.slug}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
