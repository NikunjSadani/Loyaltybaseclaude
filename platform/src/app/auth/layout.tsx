import type { Metadata } from 'next';
import { SiteFooter } from '@/components/layout/site-footer';
import { getTenantConfig } from '@/lib/platform/server';

export const metadata: Metadata = {
  title: 'Sign In',
};

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Per-tenant login branding: resolve the tenant from the request host and use its
  // uploaded white wordmark. Falls back to a hex mark + the tenant display name when no
  // wordmark is set — mirroring the post-login sidebar (components/layout/sidebar.tsx), so
  // pre- and post-login branding match. On the default/operator host this resolves to the
  // same config that was previously hardcoded.
  const config = await getTenantConfig();
  const wordmarkWhiteUrl = config.branding.wordmarkWhiteUrl;
  const brandName = config.branding.displayName || 'LoyaltyBase';

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Brand panel – desktop left / mobile top strip */}
      <div className="hidden lg:flex lg:w-1/2 bg-[#1A1A2E] flex-col items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[var(--brand-primary)]/10" />
        <div className="absolute -bottom-32 -right-16 w-80 h-80 rounded-full bg-[var(--brand-primary)]/5" />

        <div className="relative z-10 text-center max-w-sm">
          {/* Per-tenant white wordmark on the dark brand panel; else a hex mark + name. */}
          <div className="flex flex-col items-center gap-2 mb-8">
            {wordmarkWhiteUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={wordmarkWhiteUrl} alt={brandName} className="h-10 w-auto" />
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 40 40" className="w-6 h-6 fill-white">
                    <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                  </svg>
                </div>
                <span className="text-white font-bold text-2xl leading-tight">{brandName}</span>
              </div>
            )}
            <p className="text-white/60 text-sm">Trade Loyalty</p>
          </div>

          <h1 className="text-3xl font-bold text-white mb-4 leading-snug">
            Earn rewards every<br />time you sell
          </h1>
          <p className="text-white/60 text-base">
            Track targets, collect points, and redeem incredible rewards — all in one place.
          </p>

          <div className="mt-12 grid grid-cols-3 gap-4">
            {[
              { label: 'Partners', value: '50K+' },
              { label: 'Points Redeemed', value: '₹2Cr+' },
              { label: 'Schemes', value: '120+' },
            ].map((stat) => (
              <div key={stat.label} className="bg-white/5 rounded-xl p-4 text-center">
                <p className="text-white font-bold text-xl">{stat.value}</p>
                <p className="text-white/50 text-xs mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile top strip — per-tenant wordmark (white on dark); else hex mark + name */}
      <div className="lg:hidden bg-[#1A1A2E] px-6 pt-10 pb-8 flex items-center gap-3">
        {wordmarkWhiteUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wordmarkWhiteUrl} alt={brandName} className="h-7 w-auto" />
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center shrink-0">
              <svg viewBox="0 0 40 40" className="w-4 h-4 fill-white">
                <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
              </svg>
            </div>
            <span className="text-white font-bold text-lg leading-tight">{brandName}</span>
          </div>
        )}
        <div className="border-l border-white/20 pl-3">
          <p className="text-white/70 text-xs font-medium">Trade Loyalty</p>
          <p className="text-white/50 text-xs">Sign in to continue</p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-12 bg-gray-50">
        <div className="w-full max-w-sm">{children}</div>
        <SiteFooter />
      </div>
    </div>
  );
}
