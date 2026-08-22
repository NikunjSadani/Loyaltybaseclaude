'use client';

/**
 * Publish + pricing dialog — publish a Gift Master to one or many tenants and set the
 * ₹ selling price per tenant. For each tenant we SHOW the points cost derived from that
 * tenant's conversion rate (points-per-₹) and let the operator OVERRIDE it.
 *
 * Data:
 *   GET  /api/admin/gift-masters/:id/publish  → { items: TenantPublishRow[] }
 *   POST /api/admin/gift-masters/:id/publish  → { publications: [...], unpublishClientIds: [...] }
 *
 * The GET returning each tenant's conversionRate is an ASSUMPTION flagged in the report:
 * we need the rate here to show the ₹→points derivation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertTriangle, Send, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { formatINR } from '@/lib/money';
import {
  type TenantPublishRow,
  type GiftMasterSummary,
  derivePointsCost,
  parseRupeesToPaise,
} from '@/lib/gift-catalogue';

/** Per-tenant editable draft state, keyed by clientId. */
interface DraftRow {
  clientId: string;
  clientName: string;
  conversionRate: number;
  selected: boolean;
  /** ₹ price as typed. */
  priceRupees: string;
  /** manual points override as typed; blank = use the derived value. */
  pointsOverride: string;
}

function toDraft(rows: TenantPublishRow[]): DraftRow[] {
  return rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    conversionRate: r.conversionRate,
    selected: r.published,
    priceRupees: r.sellingValuePaise != null ? String(r.sellingValuePaise / 100) : '',
    // Only show an explicit override when the stored points differ from the derived
    // value; otherwise leave blank so it tracks the ₹ price.
    pointsOverride:
      r.pointsCost != null &&
      r.sellingValuePaise != null &&
      derivePointsCost(r.sellingValuePaise, r.conversionRate) !== r.pointsCost
        ? String(r.pointsCost)
        : '',
  }));
}

export function PublishDialog({
  master,
  onClose,
  onPublished,
}: {
  master: GiftMasterSummary;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await api.get<{ items: TenantPublishRow[] } | TenantPublishRow[]>(
      `/api/admin/gift-masters/${master.id}/publish`,
    );
    if (res.success) {
      const items = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      setRows(toDraft(items));
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [master.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (clientId: string, patch: Partial<DraftRow>) => {
    setRows((prev) => prev.map((r) => (r.clientId === clientId ? { ...r, ...patch } : r)));
  };

  /** The effective points cost for a row: override if given+valid, else derived. */
  const effectivePoints = (r: DraftRow): number | null => {
    const override = r.pointsOverride.trim();
    if (override !== '') {
      const n = Number(override);
      return Number.isInteger(n) && n >= 0 ? n : null;
    }
    const paise = parseRupeesToPaise(r.priceRupees);
    return derivePointsCost(paise, r.conversionRate);
  };

  const selectedRows = rows.filter((r) => r.selected);

  // A selected row must have a valid ₹ price AND a resolvable points cost.
  const rowErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const r of selectedRows) {
      const paise = parseRupeesToPaise(r.priceRupees);
      if (paise == null || paise <= 0) {
        errs[r.clientId] = 'Enter a valid ₹ selling price.';
        continue;
      }
      if (r.pointsOverride.trim() !== '') {
        const n = Number(r.pointsOverride.trim());
        if (!Number.isInteger(n) || n < 0) {
          errs[r.clientId] = 'Points override must be a whole number (0 or more).';
          continue;
        }
      } else if (!(r.conversionRate > 0)) {
        errs[r.clientId] =
          'This tenant has no valid conversion rate — enter a points override to publish.';
      }
    }
    return errs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const hasRowErrors = Object.keys(rowErrors).length > 0;

  async function doPublish() {
    if (inFlight.current) return; // sync double-submit guard
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);

    const publications = selectedRows.map((r) => ({
      clientId: r.clientId,
      sellingValuePaise: parseRupeesToPaise(r.priceRupees)!,
      pointsCost: effectivePoints(r)!,
    }));
    const unpublishClientIds = rows.filter((r) => !r.selected).map((r) => r.clientId);

    const res = await api.post<unknown>(`/api/admin/gift-masters/${master.id}/publish`, {
      publications,
      unpublishClientIds,
    });
    setSaving(false);
    inFlight.current = false;
    if (res.success) {
      onPublished();
    } else {
      setSaveError(res.error);
      setConfirming(false);
    }
  }

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => { if (!o) onClose(); }}
        title="Publish & price"
        description={`${master.name} · ${master.code}`}
        className="max-w-3xl"
      >
        {/* Body */}
        <div>
          {loading && (
            <div className="py-12 text-center text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
              Loading tenants…
            </div>
          )}

          {!loading && loadError && (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-8 text-center text-sm">
              <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
              <p className="text-red-700">{loadError}</p>
              <button
                onClick={() => void load()}
                className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !loadError && rows.length === 0 && (
            <div className="py-12 text-center text-sm text-gray-500">
              No tenants are available to publish to.
            </div>
          )}

          {!loading && !loadError && rows.length > 0 && (
            <div className="space-y-3" data-testid="publish-rows">
              <p className="text-xs text-gray-500">
                Tick a tenant to publish this master to it, then set the ₹ selling price. The
                points cost is derived from that tenant&apos;s conversion rate — override it if
                needed.
              </p>
              {rows.map((r) => {
                const paise = parseRupeesToPaise(r.priceRupees);
                const derived = derivePointsCost(paise, r.conversionRate);
                const eff = effectivePoints(r);
                const overridden = r.pointsOverride.trim() !== '';
                const err = rowErrors[r.clientId];
                return (
                  <div
                    key={r.clientId}
                    data-testid={`publish-row-${r.clientId}`}
                    className={`border rounded-xl px-4 py-3 ${
                      r.selected ? 'border-gray-300 bg-white' : 'border-gray-150 bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={r.selected}
                        aria-label={`Publish to ${r.clientName}`}
                        data-testid={`publish-select-${r.clientId}`}
                        onChange={(e) => update(r.clientId, { selected: e.target.checked })}
                        className="w-4 h-4 accent-[var(--brand-primary)]"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-gray-900">{r.clientName}</p>
                        <p className="text-[11px] text-gray-400">
                          {r.conversionRate > 0
                            ? `${r.conversionRate} points per ₹`
                            : 'No conversion rate set'}
                        </p>
                      </div>
                    </div>

                    {r.selected && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 pl-7">
                        {/* ₹ price */}
                        <div>
                          <label
                            className="block text-[11px] font-medium text-gray-500 mb-1"
                            htmlFor={`price-${r.clientId}`}
                          >
                            Selling price (₹)
                          </label>
                          <input
                            id={`price-${r.clientId}`}
                            type="text"
                            inputMode="decimal"
                            value={r.priceRupees}
                            data-testid={`publish-price-${r.clientId}`}
                            placeholder="e.g. 1499"
                            onChange={(e) => update(r.clientId, { priceRupees: e.target.value })}
                            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
                          />
                        </div>

                        {/* Derived points (read-only display) */}
                        <div>
                          <label className="block text-[11px] font-medium text-gray-500 mb-1">
                            Derived points
                          </label>
                          <div
                            data-testid={`publish-derived-${r.clientId}`}
                            className="w-full border border-gray-100 bg-gray-50 rounded-lg px-3 py-1.5 text-sm text-gray-700 tabular-nums"
                          >
                            {derived != null ? derived.toLocaleString('en-IN') : '—'}
                          </div>
                        </div>

                        {/* Override */}
                        <div>
                          <label
                            className="block text-[11px] font-medium text-gray-500 mb-1"
                            htmlFor={`override-${r.clientId}`}
                          >
                            Points override
                          </label>
                          <input
                            id={`override-${r.clientId}`}
                            type="text"
                            inputMode="numeric"
                            value={r.pointsOverride}
                            data-testid={`publish-override-${r.clientId}`}
                            placeholder="(optional)"
                            onChange={(e) => update(r.clientId, { pointsOverride: e.target.value })}
                            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
                          />
                        </div>

                        <div className="sm:col-span-3 flex items-center gap-2">
                          <p
                            className="text-[11px] text-gray-500"
                            data-testid={`publish-effective-${r.clientId}`}
                          >
                            Members pay{' '}
                            <span className="font-semibold text-gray-800">
                              {eff != null ? `${eff.toLocaleString('en-IN')} points` : '—'}
                            </span>
                            {paise != null && paise > 0 && (
                              <span className="text-gray-400"> for {formatINR(paise)}</span>
                            )}
                            {overridden && (
                              <span className="ml-1 text-amber-600">(overridden)</span>
                            )}
                          </p>
                          {overridden && (
                            <button
                              type="button"
                              onClick={() => update(r.clientId, { pointsOverride: '' })}
                              className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800"
                            >
                              <RotateCcw className="w-3 h-3" />
                              Reset to derived
                            </button>
                          )}
                        </div>

                        {err && (
                          <p
                            className="sm:col-span-3 flex items-start gap-1.5 text-[11px] text-red-600"
                            data-testid={`publish-error-${r.clientId}`}
                          >
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            {err}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && !loadError && rows.length > 0 && (
          <div className="mt-5 -mx-6 px-6 pt-4 border-t border-gray-100 flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              {selectedRows.length === 0
                ? 'No tenants selected — saving will unpublish this master everywhere.'
                : `Publishing to ${selectedRows.length} tenant${selectedRows.length !== 1 ? 's' : ''}.`}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100"
              >
                Cancel
              </button>
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={hasRowErrors || saving}
                data-testid="publish-open-confirm"
              >
                <Send className="w-4 h-4" />
                Publish
              </Button>
            </div>
          </div>
        )}

        {saveError && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-red-600" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {saveError}
          </p>
        )}
      </Modal>

      {/* Confirm step — nested Modal. A transparent overlay avoids a double-dark backdrop
          stacking on the main dialog's overlay. */}
      <Modal
        open={confirming}
        onOpenChange={(o) => { if (!o) setConfirming(false); }}
        title="Confirm publish"
        description={
          selectedRows.length === 0
            ? 'This will unpublish the master from all tenants. In-flight orders are unaffected.'
            : `Publish "${master.name}" to ${selectedRows.length} tenant${
                selectedRows.length !== 1 ? 's' : ''
              } at the prices shown? This makes it redeemable by those tenants' members.`
        }
        className="max-w-sm"
        overlayClassName="bg-transparent"
      >
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            onClick={() => setConfirming(false)}
            className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100"
          >
            Back
          </button>
          <Button
            variant="primary"
            onClick={() => { void doPublish(); }}
            loading={saving}
            data-testid="publish-confirm"
          >
            Confirm publish
          </Button>
        </div>
      </Modal>
    </>
  );
}
