'use client';

import Link from 'next/link';
import {
  Upload,
  BarChart2,
  Settings2,
  ArrowRight,
  Coins,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';

export default function CreditsPayoutsHubPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const cards = [
    {
      href:        '/admin/credits-payouts/upload',
      icon:        Upload,
      title:       'Upload Credits',
      description: 'Download the pre-populated template, fill in values, and upload points or payout data for the previous month.',
      color:       'bg-blue-50 text-blue-600',
      always:      true,
    },
    {
      href:        '/admin/credits-payouts/status',
      icon:        BarChart2,
      title:       'Payout Status',
      description: 'View payout status per outlet — Pending, Paid, or Failed. Download the report.',
      color:       'bg-emerald-50 text-emerald-600',
      always:      true,
    },
    {
      href:        '/admin/credits-payouts/fields',
      icon:        Settings2,
      title:       'Field Configuration',
      description: 'Add or deactivate credit fields. Configure outlet-type award types and payout classification.',
      color:       'bg-purple-50 text-purple-600',
      always:      false,   // Gifsy admin only
    },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
          <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">Credits & Payouts</h2>
          <p className="text-sm text-gray-500">
            Bulk-upload monthly points and payout data for enrolled outlets.
          </p>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cards
          .filter((c) => c.always || isGifsy)
          .map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.href}
                href={card.href}
                className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-[var(--brand-primary)] hover:shadow-sm transition-all"
              >
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-lg ${card.color} flex items-center justify-center flex-shrink-0`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-gray-900 text-sm">{card.title}</h3>
                      <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-[var(--brand-primary)] transition-colors flex-shrink-0" />
                    </div>
                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">{card.description}</p>
                  </div>
                </div>
              </Link>
            );
          })}
      </div>

      {/* Info note */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <p className="text-xs text-amber-800">
          <span className="font-semibold">Note:</span>{' '}
          Uploads are for the <strong>previous month only</strong>. The upload window closes on the
          configured cutoff day (default: 10th of the current month). Points are credited immediately
          upon confirmation; INR payouts are processed by Gifsy via bank transfer.
        </p>
      </div>
    </div>
  );
}
