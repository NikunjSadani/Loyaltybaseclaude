'use client';

import { use, useState } from 'react';
import { ArrowLeft, ClipboardList, Megaphone, BarChart3, Loader2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SchemeManager } from '@/components/admin/SchemeManager';
import { schemeApi, type CreateSchemeInput } from '@/lib/schemes';

// ─────────────────────────────────────────────────────────────────────────────
// Admin scheme detail:
//   /admin/schemes/new  → create form (DRAFT or ACTIVE, D6) → redirect to :id
//   /admin/schemes/:id  → SchemeManager (Details / Audience / Enrollment form)
//                          + quick links to Enrollments / Broadcast / Report
// ─────────────────────────────────────────────────────────────────────────────

export default function SchemeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/admin/schemes" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">{isNew ? 'Create scheme' : 'Manage scheme'}</h1>
            <p className="text-xs text-gray-500">
              {isNew ? 'A scheme is a data-collection instrument — configure the form + audience next.' : `Scheme ID: ${id}`}
            </p>
          </div>
        </div>
        {!isNew && (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/admin/schemes/${id}/enrollments`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg hover:bg-green-50 transition-colors">
              <ClipboardList className="w-3.5 h-3.5" /> Enrollments
            </Link>
            <Link href={`/admin/schemes/${id}/broadcast`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
              <Megaphone className="w-3.5 h-3.5" /> Broadcast
            </Link>
            <Link href={`/admin/schemes/${id}/report`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
              <BarChart3 className="w-3.5 h-3.5" /> Report
            </Link>
          </div>
        )}
      </div>

      {isNew ? <CreateSchemeForm /> : <SchemeManager schemeId={id} />}
    </div>
  );
}

// ── Create form ───────────────────────────────────────────────────────────────

function CreateSchemeForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [createAs, setCreateAs] = useState<'DRAFT' | 'ACTIVE'>('DRAFT');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError('Scheme name is required.'); return; }
    if (!startDate || !endDate) { setError('Start and end dates are required.'); return; }
    if (new Date(endDate) < new Date(startDate)) { setError('End date must be on or after the start date.'); return; }

    const codeBase = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20).replace(/^_|_$/g, '');
    const code = `${codeBase || 'SCHEME'}_${Date.now().toString(36).toUpperCase()}`;

    const input: CreateSchemeInput = {
      code,
      name: name.trim(),
      description: description.trim() || undefined,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      status: createAs,
    };

    setSubmitting(true);
    const res = await schemeApi.create(input);
    setSubmitting(false);
    if (res.success) router.push(`/admin/schemes/${res.data.scheme.id}`);
    else setError(res.error);
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Scheme name <span className="text-red-500">*</span></label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Visibility Audit"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What data is this scheme collecting?"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] resize-none" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Start date <span className="text-red-500">*</span></label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">End date <span className="text-red-500">*</span></label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-2">Create as</label>
          <div className="flex gap-3">
            {([
              { value: 'DRAFT' as const, label: 'Draft', desc: 'Configure the form + audience before it goes live.' },
              { value: 'ACTIVE' as const, label: 'Active', desc: 'Immediately visible to eligible fillers.' },
            ]).map(({ value, label, desc }) => (
              <button key={value} type="button" onClick={() => setCreateAs(value)}
                className={`flex-1 text-left p-3 rounded-xl border-2 transition-all ${createAs === value ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <p className={`text-sm font-semibold ${createAs === value ? 'text-[var(--brand-primary)]' : 'text-gray-800'}`}>{label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-500 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{error}</p>}

      <div className="flex justify-end gap-3">
        <Link href="/admin/schemes" className="px-5 py-2.5 text-sm font-medium border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">Cancel</Link>
        <button onClick={submit} disabled={submitting}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {submitting ? 'Creating…' : 'Create scheme'}
        </button>
      </div>
    </div>
  );
}
