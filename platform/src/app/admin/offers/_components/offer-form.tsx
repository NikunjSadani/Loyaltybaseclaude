'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { OfferTileCard } from '@/components/partner/offers/offer-tile-card';
import {
  createOffer, updateOffer, monthBounds, OFFER_GROUP_LABEL, OFFER_GROUP_ORDER, OFFER_VALUE_TYPE_LABEL,
  OFFER_LIMITS, OFFER_VALUE_PLACEHOLDER,
  type OfferGroup, type OfferValueType, type OfferTileAdmin, type OfferTileInput,
  type OfferSegmentOptions, type OfferOutletTypeOption, type OfferKpiOption, type OfferTilePartner,
} from '@/lib/offers';

const INPUT =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]';
const LABEL = 'block text-xs font-semibold text-gray-700 mb-1';

interface FormState {
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: string;
  valueText: string;
  unitLabel: string;
  product: string;
  label: string;
  details: string;
  validFrom: string;
  validTo: string;
  sortOrder: string;
  isActive: boolean;
  programNames: string[];
  outletTypeCodes: string[];
  zones: string[];
  states: string[];
  kpiCode: string;
}

function initialState(tile: OfferTileAdmin | null, month: string): FormState {
  if (tile) {
    return {
      group: tile.group,
      valueType: tile.valueType,
      valueNumber: tile.valueNumber === null ? '' : String(tile.valueNumber),
      valueText: tile.valueText ?? '',
      unitLabel: tile.unitLabel ?? '',
      product: tile.product ?? '',
      label: tile.label,
      details: tile.details ?? '',
      validFrom: tile.validFrom,
      validTo: tile.validTo,
      sortOrder: String(tile.sortOrder),
      isActive: tile.isActive,
      programNames: tile.programNames,
      outletTypeCodes: tile.outletTypeCodes,
      zones: tile.zones,
      states: tile.states,
      kpiCode: tile.kpiCode ?? '',
    };
  }
  const { first, last } = month ? monthBounds(month) : { first: '', last: '' };
  return {
    group: 'TARGET_REWARD', valueType: 'POINTS', valueNumber: '', valueText: '', unitLabel: '',
    product: '', label: '', details: '', validFrom: first, validTo: last, sortOrder: '0',
    isActive: true, programNames: [], outletTypeCodes: [], zones: [], states: [], kpiCode: '',
  };
}

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/**
 * Client-side checks that mirror the backend validator, so the admin gets an immediate, specific
 * message (the browser's native constraint UI is skipped by programmatic submits and is
 * inconsistent across browsers). The backend stays the authority — its message is shown verbatim.
 */
function validateOfferForm(f: FormState): string | null {
  if (f.label.trim() === '') return 'Headline is required.';
  if (f.valueType === 'TEXT') {
    if (f.valueText.trim() === '') return `Value text is required (1–${OFFER_LIMITS.valueText} characters).`;
  } else {
    const n = Number(f.valueNumber);
    if (f.valueNumber.trim() === '' || !Number.isFinite(n)) return 'Value is required.';
    if (n <= 0) return 'Value must be greater than 0.';
    const max = f.valueType === 'PERCENT' ? OFFER_LIMITS.percentMax : OFFER_LIMITS.valueMax;
    if (n > max) return `Value must be at most ${max.toLocaleString('en-IN')}${f.valueType === 'PERCENT' ? '%' : ''}.`;
  }
  const so = Number(f.sortOrder);
  if (f.sortOrder.trim() !== '' &&
      (!Number.isInteger(so) || so < OFFER_LIMITS.sortOrderMin || so > OFFER_LIMITS.sortOrderMax)) {
    return `Sort order must be a whole number from ${OFFER_LIMITS.sortOrderMin} to ${OFFER_LIMITS.sortOrderMax.toLocaleString('en-IN')}.`;
  }
  if (f.validFrom && f.validTo && f.validTo < f.validFrom) return 'Valid to must be on or after Valid from.';
  return null;
}

/** Form state → the §3.3 OfferTileInput body. Numeric types null valueText; TEXT nulls valueNumber. */
function toOfferInput(f: FormState): OfferTileInput {
  const isText = f.valueType === 'TEXT';
  const n = Number(f.valueNumber);
  return {
    group: f.group,
    valueType: f.valueType,
    valueNumber: isText || f.valueNumber.trim() === '' || !Number.isFinite(n) ? null : n,
    valueText: isText ? orNull(f.valueText) : null,
    unitLabel: orNull(f.unitLabel),
    product: orNull(f.product),
    label: f.label.trim(),
    details: orNull(f.details),
    validFrom: f.validFrom,
    validTo: f.validTo,
    sortOrder: Number.isFinite(Number(f.sortOrder)) ? Math.trunc(Number(f.sortOrder)) : 0,
    isActive: f.isActive,
    programNames: f.programNames,
    outletTypeCodes: f.outletTypeCodes,
    zones: f.zones,
    states: f.states,
    kpiCode: f.kpiCode === '' ? null : f.kpiCode,
  };
}

/** Checkbox list — nothing ticked means "all". */
function MultiCheck({
  label, testId, options, selected, onChange,
}: {
  label: string;
  testId: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  // Keep any saved value that is no longer in the option list visible (so it can be unticked).
  const all = [
    ...options,
    ...selected.filter((s) => !options.some((o) => o.value === s)).map((s) => ({ value: s, label: s })),
  ];
  return (
    <fieldset data-testid={testId}>
      <legend className={LABEL}>
        {label} <span className="font-normal text-gray-400">· none ticked = all</span>
      </legend>
      {all.length === 0 ? (
        <p className="text-xs text-gray-400">No values in the outlet master yet.</p>
      ) : (
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
          {all.map((o) => {
            const on = selected.includes(o.value);
            return (
              <label
                key={o.value}
                className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                  on ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-gray-900' : 'border-gray-200 text-gray-600'
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={on}
                  onChange={() => onChange(on ? selected.filter((s) => s !== o.value) : [...selected, o.value])}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

export function OfferForm({
  open, tile, month, segmentOptions, outletTypes, kpis, onClose, onSaved,
}: {
  open: boolean;
  /** null ⇒ create; otherwise edit this tile. */
  tile: OfferTileAdmin | null;
  month: string;
  segmentOptions: OfferSegmentOptions;
  outletTypes: OfferOutletTypeOption[];
  kpis: OfferKpiOption[];
  onClose: () => void;
  onSaved: (tile: OfferTileAdmin) => void;
}) {
  const [f, setF] = useState<FormState>(() => initialState(tile, month));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever the modal opens for a (possibly different) tile.
  useEffect(() => {
    if (open) {
      setF(initialState(tile, month));
      setError(null);
    }
  }, [open, tile, month]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  const isText = f.valueType === 'TEXT';
  const kpi = kpis.find((k) => k.code === f.kpiCode) ?? null;

  // Live preview — EXACTLY the partner tile component, with illustrative progress.
  const preview: OfferTilePartner = useMemo(() => {
    const body = toOfferInput(f);
    return {
      id: 'preview', group: body.group, valueType: body.valueType,
      // Empty value ⇒ placeholder (formatOfferValue renders '—' for a null number), never '+0 pts'.
      valueNumber: body.valueNumber, valueText: isText ? (body.valueText ?? OFFER_VALUE_PLACEHOLDER) : null,
      unitLabel: body.unitLabel, product: body.product, label: body.label || 'Headline',
      details: body.details, validTo: body.validTo,
      progress: body.kpiCode
        ? { kpiCode: body.kpiCode, kpiName: kpi?.label ?? body.kpiCode, unit: kpi?.unit ?? '',
            target: 100, achieved: 60, pct: 60, unlocked: false }
        : null,
    };
  }, [f, isText, kpi]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateOfferForm(f);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(null);
    const body = toOfferInput(f);
    const res = tile ? await updateOffer(tile.id, body) : await createOffer(body);
    setSaving(false);
    if (!res.success) {
      setError(res.error || 'Could not save the offer.');
      return;
    }
    if (res.data?.tile) onSaved(res.data.tile);
    onClose();
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={tile ? 'Edit offer tile' : 'New offer tile'}
      description="Display-only content for the partner dashboard. Tiles never credit points."
      className="max-w-3xl"
    >
      <form onSubmit={submit} className="grid gap-5 md:grid-cols-[1fr_200px]" data-testid="offer-form">
        <div className="space-y-4">
          <fieldset>
            <legend className={LABEL}>Group</legend>
            <div className="flex flex-wrap gap-3">
              {OFFER_GROUP_ORDER.map((g) => (
                <label key={g} className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="radio" name="group" value={g} checked={f.group === g} onChange={() => set('group', g)} />
                  {OFFER_GROUP_LABEL[g]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="offer-value-type" className={LABEL}>Value type</label>
              <select
                id="offer-value-type"
                className={INPUT}
                value={f.valueType}
                onChange={(e) => set('valueType', e.target.value as OfferValueType)}
              >
                {(Object.keys(OFFER_VALUE_TYPE_LABEL) as OfferValueType[]).map((v) => (
                  <option key={v} value={v}>{OFFER_VALUE_TYPE_LABEL[v]}</option>
                ))}
              </select>
            </div>
            <div>
              {isText ? (
                <>
                  <label htmlFor="offer-value-text" className={LABEL}>Value text (max {OFFER_LIMITS.valueText})</label>
                  <input
                    id="offer-value-text"
                    className={INPUT}
                    required
                    maxLength={OFFER_LIMITS.valueText}
                    value={f.valueText}
                    onChange={(e) => set('valueText', e.target.value)}
                    placeholder="Free kit"
                  />
                </>
              ) : (
                <>
                  <label htmlFor="offer-value-number" className={LABEL}>
                    Value {f.valueType === 'PERCENT' ? '(%)' : f.valueType === 'RUPEES' ? '(₹)' : '(points)'}
                  </label>
                  <input
                    id="offer-value-number"
                    className={INPUT}
                    type="number"
                    inputMode="decimal"
                    required
                    min="0.01"
                    max={f.valueType === 'PERCENT' ? OFFER_LIMITS.percentMax : OFFER_LIMITS.valueMax}
                    step="0.01"
                    value={f.valueNumber}
                    onChange={(e) => set('valueNumber', e.target.value)}
                  />
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="offer-unit" className={LABEL}>Unit label</label>
              <input id="offer-unit" className={INPUT} maxLength={OFFER_LIMITS.unitLabel} value={f.unitLabel}
                onChange={(e) => set('unitLabel', e.target.value)} placeholder="per case" />
            </div>
            <div>
              <label htmlFor="offer-product" className={LABEL}>Product</label>
              <input id="offer-product" className={INPUT} maxLength={OFFER_LIMITS.product} value={f.product}
                onChange={(e) => set('product', e.target.value)} placeholder="ADHO 50 ml" />
            </div>
          </div>

          <div>
            <label htmlFor="offer-label" className={LABEL}>Headline</label>
            <input id="offer-label" className={INPUT} maxLength={OFFER_LIMITS.label} required value={f.label}
              onChange={(e) => set('label', e.target.value)} placeholder="Earn on every case" />
          </div>

          <div>
            <label htmlFor="offer-details" className={LABEL}>Details / terms</label>
            <textarea id="offer-details" className={INPUT} rows={3} maxLength={OFFER_LIMITS.details} value={f.details}
              onChange={(e) => set('details', e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="offer-from" className={LABEL}>Valid from</label>
              <input id="offer-from" type="date" className={INPUT} required value={f.validFrom}
                onChange={(e) => set('validFrom', e.target.value)} />
            </div>
            <div>
              <label htmlFor="offer-to" className={LABEL}>Valid to</label>
              <input id="offer-to" type="date" className={INPUT} required value={f.validTo}
                onChange={(e) => set('validTo', e.target.value)} />
            </div>
            <div>
              <label htmlFor="offer-sort" className={LABEL}>Sort order</label>
              <input id="offer-sort" type="number" step="1" min={OFFER_LIMITS.sortOrderMin}
                max={OFFER_LIMITS.sortOrderMax} className={INPUT} value={f.sortOrder}
                onChange={(e) => set('sortOrder', e.target.value)} />
            </div>
          </div>

          <div>
            <label htmlFor="offer-kpi" className={LABEL}>Show this outlet&apos;s progress on</label>
            <select id="offer-kpi" className={INPUT} value={f.kpiCode} onChange={(e) => set('kpiCode', e.target.value)}>
              <option value="">None</option>
              {kpis.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
              {f.kpiCode && !kpi && <option value={f.kpiCode}>{f.kpiCode}</option>}
            </select>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Audience</p>
            <MultiCheck label="Programs" testId="target-programs"
              options={segmentOptions.programNames.map((v) => ({ value: v, label: v }))}
              selected={f.programNames} onChange={(v) => set('programNames', v)} />
            <MultiCheck label="Outlet types" testId="target-outlet-types"
              options={outletTypes.map((t) => ({ value: t.code, label: t.label }))}
              selected={f.outletTypeCodes} onChange={(v) => set('outletTypeCodes', v)} />
            <MultiCheck label="Zones" testId="target-zones"
              options={segmentOptions.zones.map((v) => ({ value: v, label: v }))}
              selected={f.zones} onChange={(v) => set('zones', v)} />
            <MultiCheck label="States" testId="target-states"
              options={segmentOptions.states.map((v) => ({ value: v, label: v }))}
              selected={f.states} onChange={(v) => set('states', v)} />
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            Published (visible to partners while valid)
          </label>

          {error && (
            <p role="alert" data-testid="offer-form-error" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} data-testid="offer-save">
              {tile ? 'Save changes' : 'Create tile'}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Partner preview</p>
          <div className="w-[180px]" data-testid="offer-preview">
            <OfferTileCard tile={preview} />
          </div>
          {preview.progress && (
            <p className="text-xs text-gray-600">Progress shown is illustrative; partners see their own.</p>
          )}
        </div>
      </form>
    </Modal>
  );
}
