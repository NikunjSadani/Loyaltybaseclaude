'use client';

/**
 * /admin/offers — "This month's offers" admin (OFFER-TILES-PLAN F4).
 *
 * Per-tenant, DISPLAY-ONLY tiles shown on the partner dashboard. The tenant is JWT-scoped by the
 * backend — this page NEVER sends a clientId. Every BE 400 message (human field labels) is shown
 * verbatim. Month switching ignores stale list responses (request sequence id), and the month
 * picker is a month + year <select> pair (type="month" is unsupported in Firefox/Safari).
 *
 *   GET    /api/admin/offers?month=YYYY-MM    → { month, tiles }
 *   GET    /api/admin/offers/segment-options  → { programNames, zones, states }
 *   POST   /api/admin/offers                  → { tile }
 *   PATCH  /api/admin/offers/:id              → { tile }
 *   DELETE /api/admin/offers/:id              → { id }
 *   POST   /api/admin/offers/copy-month       → { created, skipped, tiles }
 *   GET    /api/settings/outlet-types · GET /api/admin/kpis?enabledOnly=true (existing)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Copy, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { istMonthKey } from '@/lib/ist-date';
import {
  listOffers, getOfferSegmentOptions, getOfferOutletTypes, getOfferKpis, updateOffer, deleteOffer,
  copyOffersMonth, groupOffers, formatOfferValue, formatOfferDayShort, formatMonthLabel,
  previousMonth, offerPickerYears, OFFER_GROUP_LABEL,
  type OfferTileAdmin, type OfferSegmentOptions, type OfferOutletTypeOption, type OfferKpiOption,
} from '@/lib/offers';
import { OfferForm } from './_components/offer-form';

const EMPTY_SEGMENTS: OfferSegmentOptions = { programNames: [], zones: [], states: [] };

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Month + year <select> pair — works in every browser (no type="month"). Emits 'YYYY-MM'. */
function MonthYearPicker({
  month, currentYear, onChange,
}: { month: string; currentYear: number; onChange: (m: string) => void }) {
  const [y, m] = month ? month.split('-').map(Number) : [NaN, NaN];
  const sel = 'rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900';
  return (
    <fieldset className="flex gap-1.5" data-testid="offers-month" disabled={!month}>
      <legend className="block text-xs font-semibold text-gray-700 mb-1">Month</legend>
      <select
        aria-label="Month"
        data-testid="offers-month-select"
        className={sel}
        value={month ? String(m) : ''}
        onChange={(e) => onChange(`${y}-${String(Number(e.target.value)).padStart(2, '0')}`)}
      >
        {!month && <option value="">—</option>}
        {MONTH_NAMES.map((name, i) => <option key={name} value={String(i + 1)}>{name}</option>)}
      </select>
      <select
        aria-label="Year"
        data-testid="offers-year-select"
        className={sel}
        value={month ? String(y) : ''}
        onChange={(e) => onChange(`${e.target.value}-${String(m).padStart(2, '0')}`)}
      >
        {!month && <option value="">—</option>}
        {month && offerPickerYears(currentYear, y).map((yr) => <option key={yr} value={String(yr)}>{yr}</option>)}
      </select>
    </fieldset>
  );
}

export default function OffersAdminPage() {
  const toast = useToast();

  // Month is computed in an effect (no render-time Date ⇒ no hydration mismatch).
  const [month, setMonth] = useState('');
  const [currentYear, setCurrentYear] = useState(0);
  const [tiles, setTiles] = useState<OfferTileAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [segments, setSegments] = useState<OfferSegmentOptions>(EMPTY_SEGMENTS);
  const [outletTypes, setOutletTypes] = useState<OfferOutletTypeOption[]>([]);
  const [kpis, setKpis] = useState<OfferKpiOption[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OfferTileAdmin | null>(null);
  const [deleting, setDeleting] = useState<OfferTileAdmin | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyCount, setCopyCount] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Latest list request — an older month's response that lands late is ignored.
  const listSeq = useRef(0);
  const copySeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    const m = istMonthKey(new Date());
    setMonth(m);
    setCurrentYear(Number(m.slice(0, 4)));
  }, []);

  // Reference data for the form + list labels (loaded once; failures degrade to empty lists).
  useEffect(() => {
    let alive = true;
    getOfferSegmentOptions().then((r) => { if (alive && r.success && r.data) setSegments({ ...EMPTY_SEGMENTS, ...r.data }); });
    getOfferOutletTypes().then((t) => { if (alive) setOutletTypes(t); });
    getOfferKpis().then((k) => { if (alive) setKpis(k); });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (m: string) => {
    if (!m) return;
    const seq = ++listSeq.current;
    setLoading(true);
    setError(null);
    const r = await listOffers(m);
    if (seq !== listSeq.current) return; // a newer month was requested meanwhile — drop this one
    if (r.success) {
      setTiles(Array.isArray(r.data?.tiles) ? r.data.tiles : []);
    } else {
      setTiles([]);
      setError(r.error || 'Could not load offers.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(month); }, [month, load]);

  const fromMonth = month ? previousMonth(month) : '';
  const typeLabel = useMemo(() => new Map(outletTypes.map((t) => [t.code, t.label])), [outletTypes]);
  const kpiLabel = useMemo(() => new Map(kpis.map((k) => [k.code, k.label])), [kpis]);

  function audience(t: OfferTileAdmin): string {
    const parts = [
      ...t.programNames,
      ...t.outletTypeCodes.map((c) => typeLabel.get(c) ?? c),
      ...t.zones,
      ...t.states,
    ];
    return parts.length === 0 ? 'All outlets' : parts.join(' · ');
  }

  async function togglePublish(t: OfferTileAdmin) {
    setTogglingId(t.id);
    setError(null);
    const r = await updateOffer(t.id, { isActive: !t.isActive });
    setTogglingId(null);
    if (!r.success) { setError(r.error || 'Could not update the tile.'); return; }
    const updated = r.data?.tile;
    if (updated) setTiles((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    else void load(month);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    const r = await deleteOffer(deleting.id);
    setBusy(false);
    if (!r.success) { setError(r.error || 'Could not delete the tile.'); setDeleting(null); return; }
    setDeleting(null);
    toast.success('Offer tile deleted');
    void load(month);
  }

  async function openCopy() {
    const seq = ++copySeq.current;
    const src = fromMonth;
    setCopyCount(null);
    setCopyError(null);
    setCopyOpen(true);
    // Sources = last month's tiles that START in last month (BE copy-month semantics).
    const r = await listOffers(src);
    if (seq !== copySeq.current) return;
    if (!r.success || !Array.isArray(r.data?.tiles)) {
      // A failed count is NOT "nothing to copy" — say so and keep Copy disabled.
      const msg = !r.success ? r.error : '';
      setCopyError(msg || `Could not check ${formatMonthLabel(src)}'s tiles. Close and try again.`);
      return;
    }
    setCopyCount(r.data.tiles.filter((t) => t.validFrom.startsWith(`${src}-`)).length);
  }

  async function confirmCopy() {
    setBusy(true);
    const r = await copyOffersMonth(fromMonth, month);
    setBusy(false);
    setCopyOpen(false);
    if (!r.success) { setError(r.error || 'Could not copy last month.'); return; }
    toast.success(`Created ${r.data?.created ?? 0}, skipped ${r.data?.skipped ?? 0} (already copied)`);
    void load(month);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">This month&apos;s offers</h2>
          <p className="text-sm text-gray-500">
            Display-only tiles on the partner dashboard. They never credit or compute points.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <MonthYearPicker month={month} currentYear={currentYear} onChange={setMonth} />
          <Button variant="outline" onClick={openCopy} disabled={!month} data-testid="copy-month-btn">
            <Copy className="h-4 w-4" /> Copy last month
          </Button>
          <Button
            variant="primary"
            onClick={() => { setEditing(null); setFormOpen(true); }}
            disabled={!month}
            data-testid="new-tile-btn"
          >
            <Plus className="h-4 w-4" /> New tile
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" data-testid="offers-error" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Spinner size="lg" /></div>
      ) : tiles.length === 0 ? (
        !error && (
          <div data-testid="offers-empty" className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
            No offers for this month yet.
          </div>
        )
      ) : (
        groupOffers(tiles).map(({ group, tiles: gt }) => (
          <section key={group} className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">{OFFER_GROUP_LABEL[group]}</h3>
            <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {gt.map((t) => (
                <div key={t.id} data-testid="offer-row" className="flex flex-wrap items-center gap-4 px-4 py-3">
                  <div className="w-28 shrink-0 text-lg font-extrabold text-[var(--brand-primary)]">
                    {formatOfferValue(t)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {t.product ? `${t.product} · ` : ''}{t.label}
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      {formatOfferDayShort(t.validFrom)} – {formatOfferDayShort(t.validTo)} · {audience(t)}
                      {t.kpiCode ? ` · Progress: ${kpiLabel.get(t.kpiCode) ?? t.kpiCode}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={t.isActive}
                    aria-label={`${t.isActive ? 'Published' : 'Draft'} — toggle publish for ${t.label}`}
                    disabled={togglingId === t.id}
                    onClick={() => togglePublish(t)}
                    data-testid="publish-toggle"
                    className={`rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                      t.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {t.isActive ? 'Published' : 'Draft'}
                  </button>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" aria-label={`Edit ${t.label}`}
                      onClick={() => { setEditing(t); setFormOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${t.label}`} onClick={() => setDeleting(t)}>
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      <OfferForm
        open={formOpen}
        tile={editing}
        month={month}
        segmentOptions={segments}
        outletTypes={outletTypes}
        kpis={kpis}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          toast.success(editing ? 'Offer tile updated' : 'Offer tile created');
          void load(month);
        }}
      />

      <Modal
        open={deleting !== null}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title="Delete offer tile?"
        description={deleting ? `"${deleting.label}" will disappear from the partner dashboard.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="destructive" loading={busy} onClick={confirmDelete} data-testid="confirm-delete">
            Delete
          </Button>
        </div>
      </Modal>

      <Modal
        open={copyOpen}
        onOpenChange={(o) => { if (!o) setCopyOpen(false); }}
        title="Copy last month"
        description="Copies land as drafts. Publish each one when it is ready."
      >
        <div className="space-y-4" data-testid="copy-modal">
          {copyError ? (
            <p role="alert" data-testid="copy-count-error" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {copyError}
            </p>
          ) : copyCount === null ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : copyCount === 0 ? (
            <p className="text-sm text-gray-600">
              No tiles start in {formatMonthLabel(fromMonth)}, so there is nothing to copy.
            </p>
          ) : (
            <p className="text-sm text-gray-600">
              Copy {copyCount} tile{copyCount !== 1 ? 's' : ''} from {formatMonthLabel(fromMonth)} into{' '}
              {formatMonthLabel(month)} as drafts? Tiles already copied are skipped.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCopyOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!copyCount || !!copyError}
              onClick={confirmCopy}
              data-testid="confirm-copy"
            >
              Copy as drafts
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
