import type { Metadata } from 'next';
import { SiteFooter } from '@/components/layout/site-footer';

export const metadata: Metadata = {
  title: 'Sign In',
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Brand panel – desktop left / mobile top strip */}
      <div className="hidden lg:flex lg:w-1/2 bg-[#1A1A2E] flex-col items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[var(--brand-primary)]/10" />
        <div className="absolute -bottom-32 -right-16 w-80 h-80 rounded-full bg-[var(--brand-primary)]/5" />

        <div className="relative z-10 text-center max-w-sm">
          {/* Deoleo wordmark — white variant on the dark brand panel */}
          <div className="flex flex-col items-center gap-2 mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/deoleo-wordmark-white.png" alt="Deoleo" className="h-10 w-auto" />
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

      {/* Mobile top strip — Deoleo wordmark (white on dark) */}
      <div className="lg:hidden bg-[#1A1A2E] px-6 pt-10 pb-8 flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/deoleo-wordmark-white.png" alt="Deoleo" className="h-7 w-auto" />
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
