import type { Metadata } from 'next';

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
          {/* Logo placeholder */}
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-14 h-14 bg-[var(--brand-primary)] rounded-2xl flex items-center justify-center shadow-lg">
              <svg viewBox="0 0 40 40" className="w-8 h-8 fill-white">
                <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
              </svg>
            </div>
            <div className="text-left">
              <p className="text-white font-bold text-xl leading-tight">Deoleo</p>
              <p className="text-white/60 text-sm">Trade Loyalty</p>
            </div>
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

      {/* Mobile top strip */}
      <div className="lg:hidden bg-[#1A1A2E] px-6 pt-10 pb-8 flex items-center gap-3">
        <div className="w-10 h-10 bg-[var(--brand-primary)] rounded-xl flex items-center justify-center">
          <svg viewBox="0 0 40 40" className="w-6 h-6 fill-white">
            <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
          </svg>
        </div>
        <div>
          <p className="text-white font-bold text-base">Deoleo Trade Loyalty</p>
          <p className="text-white/50 text-xs">Sign in to continue</p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 bg-gray-50">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
