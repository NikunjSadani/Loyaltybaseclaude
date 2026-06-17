'use client';

import { use, useState, useEffect } from 'react';
import { ArrowLeft, Tag, Users, Wallet, ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SchemeBuilder } from '@/components/admin/scheme-builder';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';

// ─── Backend scheme shape (from GET /api/schemes/:id → data.scheme) ──────────

interface ApiScheme {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  status: string;
  schemeType: string;
  rewardType: string;
  startDate: string;
  endDate: string;
  holdingPeriodDays?: number | null;
  budgetPaise?: number | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  ACTIVE:    'bg-green-100 text-green-700',
  DRAFT:     'bg-gray-100 text-gray-600',
  UPCOMING:  'bg-blue-100 text-blue-700',
  ARCHIVED:  'bg-gray-100 text-gray-500',
  EXPIRED:   'bg-red-50 text-red-500',
  CANCELLED: 'bg-red-100 text-red-600',
};

export default function SchemeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const isNew = id === 'new';

  const [scheme,  setScheme]  = useState<ApiScheme | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    api.get<{ scheme: ApiScheme }>(`/api/schemes/${id}`)
      .then((result) => {
        if (result.success) {
          setScheme(result.data.scheme);
        } else {
          setError(result.error);
        }
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-500">Failed to load scheme.</p>
        <p className="mt-1 text-xs text-gray-500">{error}</p>
        <Link href="/admin/schemes" className="mt-3 inline-block text-xs text-[var(--brand-primary)] hover:underline">
          Back to schemes
        </Link>
      </div>
    );
  }

  const handleSave = () => {
    // Draft save is local-only for now; builder shows its own state
  };

  const handlePublish = (_data: unknown, newSchemeId: string) => {
    // Redirect to the new scheme's detail page after successful publish
    router.push(`/admin/schemes/${newSchemeId}`);
  };

  const handleArchive = async () => {
    if (!scheme) return;
    if (!confirm('Archive this scheme? Partners will stop earning from this scheme.')) return;
    const result = await api.patch<{ scheme: ApiScheme }>(`/api/schemes/${scheme.id}`, { status: 'ARCHIVED' });
    if (result.success) {
      setScheme(result.data.scheme);
    } else {
      alert(`Failed to archive: ${result.error}`);
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
              {isNew ? 'Create New Scheme' : (scheme?.name ?? id)}
            </h1>
            <p className="text-xs text-gray-500">
              {isNew
                ? 'Configure all details below to create a new incentive scheme'
                : `Scheme ID: ${id} · Code: ${scheme?.code ?? '—'}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!isNew && scheme && (
            <>
              <Link
                href={`/admin/schemes/${id}/enrollments`}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg hover:bg-green-50 transition-colors"
              >
                <ClipboardList className="w-3.5 h-3.5" />
                Enrollments
              </Link>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[scheme.status] ?? 'bg-gray-100 text-gray-600'}`}>
                {scheme.status}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Stats (only for existing schemes) */}
      {!isNew && scheme && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">—</p>
              <p className="text-xs text-gray-500">Partners Enrolled</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-lg">
              <Wallet className="w-4 h-4 text-green-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">—</p>
              <p className="text-xs text-gray-500">Total Payout Earned</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded-lg">
              <Tag className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{scheme.schemeType}</p>
              <p className="text-xs text-gray-500">Scheme Type</p>
            </div>
          </div>
        </div>
      )}

      {/* Scheme Builder */}
      <SchemeBuilder
        schemeId={isNew ? undefined : id}
        initialData={(!isNew && scheme) ? {
          name:             scheme.name,
          description:      scheme.description ?? '',
          startDate:        scheme.startDate.slice(0, 10),
          endDate:          scheme.endDate.slice(0, 10),
          holdingPeriodDays: String(scheme.holdingPeriodDays ?? 30),
        } : undefined}
        onSave={handleSave}
        onPublish={handlePublish}
        onArchive={handleArchive}
      />
    </div>
  );
}
