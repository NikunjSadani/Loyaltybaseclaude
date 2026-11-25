'use client';

/**
 * Admin — Target history (owner 2026-11-25, all clients). Pick an outlet (or arrive with ?outletCode=) to see every
 * target change from an upload; "Download target history" gets the whole program's report (Downloads page).
 * Data: GET /api/admin/targets/history, GET /api/admin/targets/history/export (see components/admin/target-history).
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TargetHistoryDownloadButton, TargetHistoryPanel } from '@/components/admin/target-history';

function TargetHistoryInner() {
  const params = useSearchParams();
  const initial = (params?.get('outletCode') ?? '').trim();
  const [input, setInput] = useState(initial);
  const [outletCode, setOutletCode] = useState(initial);

  return (
    <div className="space-y-5 pb-10">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-gray-900">Target history</p>
          <p className="text-xs text-gray-500 mt-0.5">
            See how an outlet&apos;s targets changed (month, KPI, old → new, who, when, which upload). Only changes made
            since target history tracking started are recorded.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={e => { e.preventDefault(); setOutletCode(input.trim()); }}
        >
          <div>
            <label htmlFor="target-history-outlet" className="block text-xs font-medium text-gray-600 mb-1.5">Outlet ID</label>
            <input
              id="target-history-outlet"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="e.g. R00123"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
            />
          </div>
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40"
          >
            Show history
          </button>
          <TargetHistoryDownloadButton label="Download target history (all outlets)" />
        </form>
      </div>
      {outletCode
        ? <TargetHistoryPanel outletCode={outletCode} />
        : <p className="text-xs text-gray-500">Enter an Outlet ID to see its target history.</p>}
    </div>
  );
}

export default function TargetHistoryPage() {
  return (
    <Suspense fallback={null}>
      <TargetHistoryInner />
    </Suspense>
  );
}
