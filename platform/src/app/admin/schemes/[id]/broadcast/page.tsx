'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Megaphone, Send, Loader2, AlertCircle, CheckCircle, X, Plus,
  MessageSquare, Smartphone, History,
} from 'lucide-react';
import {
  schemeApi,
  type BroadcastChannel, type BroadcastScope, type BroadcastInput,
  type BroadcastRecipientFilter, type BroadcastResult, type SchemeBroadcastRow,
} from '@/lib/schemes';

// Recipient-filter facet keys grouped by the scope they belong to (used to strip
// stale cross-scope keys when the recipient scope changes).
const OUTLET_FILTER_KEYS: (keyof BroadcastRecipientFilter)[] = [
  'zones', 'programNames', 'programCategories', 'outletTypeIds', 'states',
];
const SALES_FILTER_KEYS: (keyof BroadcastRecipientFilter)[] = ['taggedSalesUserIds'];

// ─────────────────────────────────────────────────────────────────────────────
// Scheme broadcast tool (D29) — send an ad-hoc MSG91 message to eligible outlets
// and/or the tagged sales team, triggerable multiple times, with a send history.
// GIFSY_ADMIN only — enforced by admin/schemes/layout.tsx (RequireAuth allowedRoles
// GIFSY_ADMIN, which bounces any non-GIFSY admin to their own home) plus the backend
// broadcast/enrollment endpoints; the sidebar nav is additionally hidden via gifsyOnly.
// ─────────────────────────────────────────────────────────────────────────────

export default function BroadcastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);

  const [channel, setChannel] = useState<BroadcastChannel>('WHATSAPP');
  const [templateId, setTemplateId] = useState('');
  const [scope, setScope] = useState<BroadcastScope>('OUTLETS');
  const [bodyValues, setBodyValues] = useState<string[]>([]);
  const [filter, setFilter] = useState<BroadcastRecipientFilter>({});
  const [showFilter, setShowFilter] = useState(false);

  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<BroadcastResult | null>(null);
  // Billable send — a preview-gated confirm holds the dry-run count + the exact input to send.
  const [pending, setPending] = useState<{ count: number; input: BroadcastInput } | null>(null);

  const [history, setHistory] = useState<SchemeBroadcastRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    const res = await schemeApi.listBroadcasts(schemeId);
    if (res.success) setHistory(res.data.broadcasts);
    setLoadingHistory(false);
  }, [schemeId]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // Step 1 — dry-run the recipient count (no send) and open the confirm dialog. Broadcasting
  // is billable, so we never call broadcast() until the reviewer confirms the resolved count.
  const send = async () => {
    setSendError(null);
    setSendResult(null);
    if (!templateId.trim()) { setSendError('A MSG91 template id / name is required.'); return; }
    const cleanFilter = Object.fromEntries(
      Object.entries(filter).filter(([, v]) => Array.isArray(v) && v.length > 0),
    ) as BroadcastRecipientFilter;
    const input: BroadcastInput = {
      channel,
      templateId: templateId.trim(),
      recipientScope: scope,
      bodyValues: bodyValues.map((v) => v.trim()).filter(Boolean),
      recipientFilter: showFilter && Object.keys(cleanFilter).length > 0 ? cleanFilter : undefined,
    };
    setPreviewing(true);
    const res = await schemeApi.previewBroadcast(schemeId, input);
    setPreviewing(false);
    if (res.success) setPending({ count: res.data.recipientCount, input });
    else setSendError(res.error);
  };

  // Step 2 — the reviewer confirmed; send exactly the previewed input.
  const confirmSend = async () => {
    if (!pending) return;
    const input = pending.input;
    setPending(null);
    setSending(true);
    const res = await schemeApi.broadcast(schemeId, input);
    setSending(false);
    if (res.success) { setSendResult(res.data); await loadHistory(); }
    else setSendError(res.error);
  };

  const setFilterKey = (k: keyof BroadcastRecipientFilter, csv: string) =>
    setFilter((f) => ({ ...f, [k]: csv.split(',').map((s) => s.trim()).filter(Boolean) }));

  // Switching scope must drop filter keys that belong to the OTHER scope, otherwise a
  // value typed while the scope was SALES/BOTH lingers in state (its CsvField unmounts,
  // but the state key survives) and gets sent on the next broadcast (stale hidden input).
  const changeScope = (next: BroadcastScope) => {
    setScope(next);
    setFilter((f) => {
      const cleaned = { ...f };
      if (next === 'OUTLETS') for (const k of SALES_FILTER_KEYS) delete cleaned[k];
      if (next === 'SALES') for (const k of OUTLET_FILTER_KEYS) delete cleaned[k];
      return cleaned;
    });
  };

  return (
    <div className="space-y-5 fade-in max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/admin/schemes/${schemeId}`} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><ArrowLeft className="w-4 h-4" /></Link>
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2"><Megaphone className="w-5 h-5 text-[var(--brand-primary)]" /> Broadcast</h1>
          <p className="text-xs text-gray-500">Send a MSG91 message to this scheme&apos;s outlets and/or tagged sales team.</p>
        </div>
      </div>

      {/* Compose */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
        {/* Channel */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">Channel</label>
          <div className="flex gap-3">
            {([
              { value: 'WHATSAPP' as BroadcastChannel, Icon: MessageSquare, label: 'WhatsApp template' },
              { value: 'SMS' as BroadcastChannel, Icon: Smartphone, label: 'SMS / OTP template' },
            ]).map(({ value, Icon, label }) => (
              <button key={value} type="button" onClick={() => setChannel(value)}
                className={`flex-1 flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${channel === value ? 'border-[var(--brand-primary)] bg-green-50 text-[var(--brand-primary)]' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}>
                <Icon className="w-4 h-4" /><span className="text-sm font-semibold">{label}</span>
              </button>
            ))}
          </div>
          {channel === 'SMS' && (
            <p className="text-[11px] text-amber-600 mt-1.5 flex items-start gap-1"><AlertCircle className="w-3 h-3 mt-0.5" /> In non-prod (FIXED_OTP) SMS broadcasts do not actually deliver; WhatsApp templates do.</p>
          )}
        </div>

        {/* Template id */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">MSG91 template {channel === 'WHATSAPP' ? 'name' : 'id'} <span className="text-red-500">*</span></label>
          <input type="text" value={templateId} onChange={(e) => setTemplateId(e.target.value)}
            placeholder={channel === 'WHATSAPP' ? 'e.g. scheme_launch_v1' : 'e.g. 651a…'} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>

        {/* Recipients */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">Recipients</label>
          <div className="flex gap-2">
            {([
              { value: 'OUTLETS' as BroadcastScope, label: 'Outlets' },
              { value: 'SALES' as BroadcastScope, label: 'Sales team' },
              { value: 'BOTH' as BroadcastScope, label: 'Both' },
            ]).map(({ value, label }) => (
              <button key={value} type="button" onClick={() => changeScope(value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${scope === value ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Optional filter */}
        <div>
          <button type="button" onClick={() => setShowFilter((s) => !s)} className="text-xs text-[var(--brand-primary)] hover:underline">
            {showFilter ? 'Hide recipient filter' : 'Narrow recipients (optional)'}
          </button>
          {showFilter && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 bg-gray-50 border border-gray-100 rounded-lg p-3">
              {(scope === 'OUTLETS' || scope === 'BOTH') && (
                <>
                  <CsvField label="Zones" onChange={(v) => setFilterKey('zones', v)} />
                  <CsvField label="Program names" onChange={(v) => setFilterKey('programNames', v)} />
                  <CsvField label="Program categories" onChange={(v) => setFilterKey('programCategories', v)} />
                  <CsvField label="Outlet type ids" onChange={(v) => setFilterKey('outletTypeIds', v)} />
                  <CsvField label="States" onChange={(v) => setFilterKey('states', v)} />
                </>
              )}
              {(scope === 'SALES' || scope === 'BOTH') && (
                <CsvField label="Tagged sales user ids" onChange={(v) => setFilterKey('taggedSalesUserIds', v)} />
              )}
              <p className="sm:col-span-2 text-[11px] text-gray-400">Comma-separated. Empty = the full selected scope.</p>
            </div>
          )}
        </div>

        {/* Body values */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Template variables (body_1, body_2, …)</label>
          <div className="space-y-1.5">
            {bodyValues.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-gray-400 font-mono w-12">body_{i + 1}</span>
                <input type="text" value={v} onChange={(e) => setBodyValues((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                  className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs" />
                <button type="button" onClick={() => setBodyValues((prev) => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <button type="button" onClick={() => setBodyValues((prev) => [...prev, ''])} className="text-xs text-[var(--brand-primary)] flex items-center gap-1 hover:text-green-700"><Plus className="w-3 h-3" /> Add variable</button>
          </div>
        </div>

        {sendError && <p className="text-xs text-red-500 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{sendError}</p>}
        {sendResult && (
          <p className="text-xs text-green-600 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />
            Sent to {sendResult.recipientCount} recipient{sendResult.recipientCount === 1 ? '' : 's'} — {sendResult.sentCount} sent{sendResult.failedCount > 0 ? `, ${sendResult.failedCount} failed` : ''}.
          </p>
        )}

        <div className="flex justify-end">
          <button onClick={send} disabled={sending || previewing}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
            {sending || previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {previewing ? 'Checking recipients…' : sending ? 'Sending…' : 'Send broadcast'}
          </button>
        </div>
      </div>

      {/* Billable-send confirm (preview-gated) */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setPending(null)} aria-hidden />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Megaphone className="w-4.5 h-4.5 text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">Send broadcast?</p>
                <p className="text-xs text-gray-600 mt-1">
                  This will message <strong className="text-gray-900">{pending.count}</strong> recipient{pending.count === 1 ? '' : 's'}. Send?
                </p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPending(null)}
                className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={confirmSend} disabled={pending.count === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-60">
                <Send className="w-3.5 h-3.5" /> Send now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <History className="w-4 h-4 text-gray-400" /><p className="text-sm font-semibold text-gray-800">Send history</p>
        </div>
        {loadingHistory ? (
          <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 text-gray-300 animate-spin" /></div>
        ) : history.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-gray-400">No broadcasts sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>{['When', 'Channel', 'Recipients', 'Template', 'Sent / Failed'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2 text-xs text-gray-600">{new Date(b.createdAt).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2 text-xs text-gray-700">{b.channel}</td>
                    <td className="px-4 py-2 text-xs text-gray-700">{b.recipientScope}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 font-mono truncate max-w-[10rem]">{b.templateId}</td>
                    <td className="px-4 py-2 text-xs"><span className="text-green-600 font-medium">{b.sentCount}</span> / <span className={b.failedCount > 0 ? 'text-red-500 font-medium' : 'text-gray-400'}>{b.failedCount}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CsvField({ label, onChange }: { label: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] text-gray-500 mb-1">{label}</label>
      <input type="text" onChange={(e) => onChange(e.target.value)} placeholder="a, b, c" className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white" />
    </div>
  );
}
