'use client';

import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Loader2 } from 'lucide-react';
import { assumeTenant, getToken } from '@/lib/auth-client';

interface Brand {
  slug: string;
  internalName: string;
  status: string;
}

/**
 * "Work in brand ▾" — the GIFSY operator-context switcher (A2/#51). Lists the real
 * tenants (GET /api/gifsy/clients), and on select exchanges the gifsy session for a
 * tenant-scoped GIFSY_ADMIN token, then lands the operator in the admin shell for
 * that brand. The persistent context is shown by <OperatorBanner/>.
 */
export function BrandSwitcher() {
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || brands.length > 0) return;
    setLoading(true);
    fetch('/api/gifsy/clients', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => r.json())
      .then((j) => setBrands(
        // Operator can assume ACTIVE and ONBOARDING tenants (backend now allows
        // assuming ONBOARDING — this is what un-dead-ends a freshly onboarded tenant).
        // INACTIVE stays hidden. ACTIVE first, then ONBOARDING, so live brands read primary.
        (j.data?.clients ?? [])
          .filter((c: Brand) => c.status === 'ACTIVE' || c.status === 'ONBOARDING')
          .sort((a: Brand, b: Brand) =>
            (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1)),
      ))
      .catch(() => setError('Could not load brands'))
      .finally(() => setLoading(false));
  }, [open, brands.length]);

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function pick(slug: string) {
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
  }

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
