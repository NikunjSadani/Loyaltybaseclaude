import Link from 'next/link';
import { Building2, CheckCircle, Clock, AlertCircle, TrendingUp, Users } from 'lucide-react';
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry';
import { buildClientSummary } from '@/lib/platform/platform-admin';

export default function GifsyOverviewPage() {
  const summaries = Object.values(CLIENT_REGISTRY).map(buildClientSummary);

  const active     = summaries.filter((s) => s.status === 'ACTIVE').length;
  const onboarding = summaries.filter((s) => s.status === 'ONBOARDING').length;
  const inactive   = summaries.filter((s) => s.status === 'INACTIVE').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Platform Overview</h1>
        <p className="text-sm text-white/50 mt-0.5">All clients onboarded on Gifsy Loyalty Platform</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Clients',   value: summaries.length, icon: Building2,    color: 'text-white/70' },
          { label: 'Active',          value: active,            icon: CheckCircle,  color: 'text-green-400' },
          { label: 'Onboarding',      value: onboarding,        icon: Clock,        color: 'text-amber-400' },
          { label: 'Inactive',        value: inactive,          icon: AlertCircle,  color: 'text-red-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-3">
            <Icon className={`w-5 h-5 shrink-0 ${color}`} />
            <div>
              <p className="text-xl font-bold text-white">{value}</p>
              <p className="text-xs text-white/40">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Client cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white/70">All Clients</h2>
          <Link href="/gifsy/clients/new"
            className="px-3 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity">
            + Onboard Client
          </Link>
        </div>

        <div className="space-y-2">
          {summaries.map((s) => (
            <Link key={s.slug} href={`/gifsy/clients/${s.slug}`}
              className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-3 hover:bg-white/8 hover:border-white/20 transition-all group">

              {/* Colour dot */}
              <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold text-white"
                style={{ backgroundColor: s.primaryColor }}>
                {s.displayName[0]}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{s.displayName}</p>
                <p className="text-xs text-white/40">{s.slug}.loyaltybase.in</p>
              </div>

              <div className="flex items-center gap-4 text-xs text-white/50 shrink-0">
                <span>{s.partnerClassCount} classes</span>
                <span>{s.enabledFeatureCount} features on</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${
                  s.status === 'ACTIVE'      ? 'bg-green-500/20 text-green-400' :
                  s.status === 'ONBOARDING'  ? 'bg-amber-500/20 text-amber-400' :
                                               'bg-red-500/20 text-red-400'
                }`}>
                  {s.status}
                </span>
                <TrendingUp className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
