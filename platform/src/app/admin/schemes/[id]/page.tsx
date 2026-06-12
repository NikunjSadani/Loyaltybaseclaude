'use client';

import { use } from 'react';
import { ArrowLeft, Tag, Users, Wallet, ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { SchemeBuilder } from '@/components/admin/scheme-builder';
import { IncentiveType, CalculationMethod, ChannelPartnerClass } from '@/types';

const SCHEME_DATA: Record<string, {
  id: string;
  name: string;
  description: string;
  status: string;
  startDate: string;
  endDate: string;
  incentiveType: IncentiveType;
  calculationMethod: CalculationMethod;
  applicableClasses: ChannelPartnerClass[];
  holdingPeriodDays: string;
  partnersEnrolled: number;
  totalPayout: string;
  isNew?: boolean;
}> = {
  SCH001: {
    id: 'SCH001',
    name: 'Summer Push Q1 2025',
    description: 'Slab-based sales incentive for Q1 summer season. Targets billing growth across key partner classes.',
    status: 'ACTIVE',
    startDate: '2025-04-01',
    endDate: '2025-06-30',
    incentiveType: IncentiveType.SALES,
    calculationMethod: CalculationMethod.SLAB,
    applicableClasses: [ChannelPartnerClass.GOLD, ChannelPartnerClass.SILVER, ChannelPartnerClass.PLATINUM],
    holdingPeriodDays: '30',
    partnersEnrolled: 1243,
    totalPayout: '₹28.4L',
  },
  new: {
    id: 'new',
    name: '',
    description: '',
    status: 'DRAFT',
    startDate: '',
    endDate: '',
    incentiveType: IncentiveType.SALES,
    calculationMethod: CalculationMethod.SLAB,
    applicableClasses: [ChannelPartnerClass.GOLD],
    holdingPeriodDays: '30',
    partnersEnrolled: 0,
    totalPayout: '—',
    isNew: true,
  },
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  DRAFT: 'bg-gray-100 text-gray-600',
  UPCOMING: 'bg-blue-100 text-blue-700',
  ARCHIVED: 'bg-gray-100 text-gray-500',
  EXPIRED: 'bg-red-50 text-red-500',
};

export default function SchemeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const scheme = SCHEME_DATA[id] ?? SCHEME_DATA['new'];

  const handleSave = (data: unknown) => {
    console.log('Save draft:', data);
    alert('Scheme saved as draft.');
  };

  const handlePublish = (data: unknown) => {
    console.log('Publish:', data);
    alert('Scheme published successfully! Partners will be notified.');
  };

  const handleArchive = () => {
    if (confirm('Archive this scheme? Partners will stop earning from this scheme.')) {
      alert('Scheme archived.');
    }
  };

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/schemes"
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {scheme.isNew ? 'Create New Scheme' : scheme.name}
            </h1>
            <p className="text-xs text-gray-500">
              {scheme.isNew ? 'Configure all details below to create a new incentive scheme' : `Scheme ID: ${scheme.id}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!scheme.isNew && (
            <>
              <Link
                href={`/admin/schemes/${scheme.id}/enrollments`}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg hover:bg-green-50 transition-colors"
              >
                <ClipboardList className="w-3.5 h-3.5" />
                Enrollments
              </Link>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[scheme.status]}`}>
                {scheme.status}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Stats (only for existing schemes) */}
      {!scheme.isNew && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{scheme.partnersEnrolled.toLocaleString()}</p>
              <p className="text-xs text-gray-500">Partners Enrolled</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-lg">
              <Wallet className="w-4 h-4 text-green-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{scheme.totalPayout}</p>
              <p className="text-xs text-gray-500">Total Payout Earned</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded-lg">
              <Tag className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{scheme.applicableClasses.length}</p>
              <p className="text-xs text-gray-500">Partner Classes</p>
            </div>
          </div>
        </div>
      )}

      {/* Scheme Builder */}
      <SchemeBuilder
        schemeId={scheme.isNew ? undefined : scheme.id}
        initialData={scheme.isNew ? undefined : {
          name: scheme.name,
          description: scheme.description,
          startDate: scheme.startDate,
          endDate: scheme.endDate,
          incentiveType: scheme.incentiveType,
          calculationMethod: scheme.calculationMethod,
          applicableClasses: scheme.applicableClasses,
          holdingPeriodDays: scheme.holdingPeriodDays,
          slabs: [
            { id: 's1', from: '0', to: '100000', rate: '1.5' },
            { id: 's2', from: '100000', to: '250000', rate: '2.0' },
            { id: 's3', from: '250000', to: '', rate: '2.5' },
          ],
        }}
        onSave={handleSave}
        onPublish={handlePublish}
        onArchive={handleArchive}
      />
    </div>
  );
}
