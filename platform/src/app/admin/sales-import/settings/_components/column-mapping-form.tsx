'use client';

/**
 * Column mapping form (SALES-IMPORT-PIPELINE-PLAN §6.1, §11 F-6): tells the portal which heading in the tenant's
 * file is the outlet code, invoice date, amount, quantity and the product columns. Heading inputs suggest the
 * headings detected in the latest file that needed mapping, but accept free text.
 */
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import {
  SALES_IMPORT_DIM_KEY_PATTERN, SALES_IMPORT_MAX_DIMENSIONS,
  type SalesColumnMapping, type SalesDimensionMapping,
} from '@/lib/sales-import/types';

export const EMPTY_MAPPING: SalesColumnMapping = {
  sheetName: null, headerRow: 'auto', outletCode: '', outletName: null, invoiceDate: '', amount: null, quantity: null,
  dimensions: [], dateOrder: 'DMY',
};

/** Same normalization the backend applies to headings before matching (§6.1). */
export function normalizeHeader(s: string): string {
  return s.replace(/^﻿/, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** "SKU group" → "skuGroup" (a valid dimension key), or '' when nothing usable. */
export function suggestDimKey(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  const trimmed = key.replace(/^[^a-z]+/, '').slice(0, 24);
  return SALES_IMPORT_DIM_KEY_PATTERN.test(trimmed) ? trimmed : '';
}

/** Blocking validation, mirroring the backend PUT profile rules. */
export function validateMapping(m: SalesColumnMapping): string[] {
  const errs: string[] = [];
  if (!m.outletCode.trim()) errs.push('Choose the outlet (customer) code column.');
  if (!m.invoiceDate.trim()) errs.push('Choose the invoice date column.');
  if (!(m.amount ?? '').trim() && !(m.quantity ?? '').trim()) errs.push('Choose an amount column, a quantity column, or both.');
  if (m.headerRow !== 'auto' && !(Number.isInteger(m.headerRow) && m.headerRow >= 1)) errs.push('The header row must be a whole number from 1.');
  if (m.dimensions.length > SALES_IMPORT_MAX_DIMENSIONS) errs.push(`At most ${SALES_IMPORT_MAX_DIMENSIONS} product columns.`);
  const keys = new Set<string>();
  m.dimensions.forEach((d, i) => {
    const n = i + 1;
    if (!SALES_IMPORT_DIM_KEY_PATTERN.test(d.key)) errs.push(`Product column ${n}: the key must start with a lowercase letter and use only letters/digits (max 24).`);
    else if (keys.has(d.key)) errs.push(`Product column ${n}: the key "${d.key}" is used twice.`);
    keys.add(d.key);
    if (!d.label.trim()) errs.push(`Product column ${n}: add a label.`);
    if (!d.header.trim()) errs.push(`Product column ${n}: choose the heading.`);
  });
  const headers = [m.outletCode, m.outletName, m.invoiceDate, m.amount, m.quantity, ...m.dimensions.map((d) => d.header)]
    .filter((h): h is string => Boolean(h && h.trim()))
    .map(normalizeHeader);
  const dup = headers.find((h, i) => headers.indexOf(h) !== i);
  if (dup) errs.push(`The heading "${dup}" is used for two different fields.`);
  return errs;
}

function HeaderInput({ id, label, value, onChange, required, suggestionsId }: {
  id: string; label: string; value: string; onChange(v: string): void; required?: boolean; suggestionsId: string;
}) {
  return (
    <label htmlFor={id} className="text-xs font-medium text-gray-700">
      {label}{required ? ' *' : ''}
      <input id={id} list={suggestionsId} value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5" placeholder="Heading as in the file" />
    </label>
  );
}

export function ColumnMappingForm({
  initial, detectedHeaders, onSaved, canEdit = true,
}: {
  initial: SalesColumnMapping | null; detectedHeaders: string[]; onSaved(m: SalesColumnMapping): void;
  /** False → read-only (the user lacks targets:manage_config); Save is hidden. */
  canEdit?: boolean;
}) {
  const [m, setM] = useState<SalesColumnMapping>(initial ?? EMPTY_MAPPING);
  // Per row: true = added in this session and not saved yet. Only such rows get a key auto-suggested from the label;
  // a saved key is what KPIs reference, so renaming the label must never change it.
  const [isNewRow, setIsNewRow] = useState<boolean[]>(() => (initial ?? EMPTY_MAPPING).dimensions.map(() => false));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const errors = validateMapping(m);
  const listId = 'sales-import-detected-headers';

  const set = <K extends keyof SalesColumnMapping>(k: K, v: SalesColumnMapping[K]) => { setTouched(true); setM((p) => ({ ...p, [k]: v })); };
  const setDim = (i: number, patch: Partial<SalesDimensionMapping>) => {
    setTouched(true);
    setM((p) => ({ ...p, dimensions: p.dimensions.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  };

  async function save() {
    setTouched(true);
    if (errors.length || saving) return;
    setSaving(true);
    setMsg(null);
    const clean: SalesColumnMapping = {
      ...m,
      sheetName: m.sheetName?.trim() ? m.sheetName.trim() : null,
      outletName: m.outletName?.trim() ? m.outletName.trim() : null,
      amount: m.amount?.trim() ? m.amount.trim() : null,
      quantity: m.quantity?.trim() ? m.quantity.trim() : null,
      outletCode: m.outletCode.trim(),
      invoiceDate: m.invoiceDate.trim(),
      dimensions: m.dimensions.map((d) => ({ key: d.key.trim(), label: d.label.trim(), header: d.header.trim() })),
    };
    const r = await salesImportApi.saveProfile(clean);
    setSaving(false);
    if (!r.success) { setMsg({ tone: 'err', text: `Not saved: ${r.error}` }); return; }
    setMsg({ tone: 'ok', text: 'Column mapping saved. Reprocess any file that was waiting for it.' });
    setIsNewRow(clean.dimensions.map(() => false));
    onSaved(r.data ?? clean);
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4" data-testid="column-mapping-form">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">How to read the sales file</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Type each heading exactly as it appears in the file (case and extra spaces do not matter).
          {detectedHeaders.length > 0 ? ' Suggestions come from the latest file the portal could not read.' : ''}
        </p>
      </div>
      <datalist id={listId}>{detectedHeaders.map((h) => <option key={h} value={h} />)}</datalist>
      {/* Read-only for users without targets:manage_config: a disabled fieldset disables every input / button inside. */}
      <fieldset disabled={!canEdit} className="space-y-4 min-w-0 border-0 p-0 m-0" data-testid="mapping-fields">

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <HeaderInput id="map-outlet" label="Outlet / customer code" required value={m.outletCode} onChange={(v) => set('outletCode', v)} suggestionsId={listId} />
        <HeaderInput id="map-outlet-name" label="Outlet name (optional)" value={m.outletName ?? ''} onChange={(v) => set('outletName', v)} suggestionsId={listId} />
        <HeaderInput id="map-date" label="Invoice date" required value={m.invoiceDate} onChange={(v) => set('invoiceDate', v)} suggestionsId={listId} />
        <HeaderInput id="map-amount" label="Amount (₹)" value={m.amount ?? ''} onChange={(v) => set('amount', v)} suggestionsId={listId} />
        <HeaderInput id="map-qty" label="Quantity (cases)" value={m.quantity ?? ''} onChange={(v) => set('quantity', v)} suggestionsId={listId} />
        <label htmlFor="map-sheet" className="text-xs font-medium text-gray-700">
          Sheet name (optional, .xlsx only)
          <input id="map-sheet" value={m.sheetName ?? ''} onChange={(e) => set('sheetName', e.target.value)} placeholder="First sheet"
            className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5" />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="text-xs font-medium text-gray-700">Header row</legend>
          <div className="mt-1 flex items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="headerRow" checked={m.headerRow === 'auto'} onChange={() => set('headerRow', 'auto')} />
              Find it automatically (rows 1–10)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="headerRow" checked={m.headerRow !== 'auto'} onChange={() => set('headerRow', 1)} />
              Row
              <input type="number" min={1} aria-label="Header row number" disabled={m.headerRow === 'auto'}
                value={m.headerRow === 'auto' ? '' : m.headerRow}
                onChange={(e) => set('headerRow', Number(e.target.value))}
                className="w-16 text-sm border border-gray-300 rounded-md px-2 py-1 disabled:bg-gray-50" />
            </label>
          </div>
        </fieldset>
        <label className="text-xs font-medium text-gray-700">
          Date order for dates typed as text
          <select value={m.dateOrder} onChange={(e) => set('dateOrder', e.target.value as SalesColumnMapping['dateOrder'])}
            className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5">
            <option value="DMY">Day-Month-Year (05-10-2026)</option>
            <option value="MDY">Month-Day-Year (10-05-2026)</option>
            <option value="YMD">Year-Month-Day (2026-10-05)</option>
          </select>
          <span className="block mt-1 font-normal text-gray-500">Real Excel date cells are read correctly whatever this says.</span>
        </label>
        <label className="text-xs font-medium text-gray-700">
          Decimal mark in amounts typed as text
          <select value={m.decimalSeparator ?? 'auto'} aria-label="Decimal mark"
            onChange={(e) => set('decimalSeparator', e.target.value as NonNullable<SalesColumnMapping['decimalSeparator']>)}
            className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5">
            <option value="auto">Automatic (comma for &ldquo;;&rdquo;-separated CSV files, else point)</option>
            <option value=".">Point: 1,234.56</option>
            <option value=",">Comma: 1.234,56</option>
          </select>
          <span className="block mt-1 font-normal text-gray-500">Real Excel number cells are read correctly whatever this says.</span>
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-gray-700">Product columns (used to pick brands, sizes, etc. for KPIs)</p>
        {m.dimensions.length === 0 && <p className="text-xs text-gray-500">None yet. Without product columns every KPI counts all products.</p>}
        {m.dimensions.map((d, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2" data-testid={`dimension-row-${i}`}>
            <label className="text-[11px] text-gray-500">Label
              <input value={d.label} aria-label={`Product column ${i + 1} label`}
                onChange={(e) => setDim(i, {
                  label: e.target.value,
                  // Auto-suggest only for a NEW row whose key the user has not typed themselves.
                  ...(isNewRow[i] && (d.key === '' || d.key === suggestDimKey(d.label)) ? { key: suggestDimKey(e.target.value) } : {}),
                })}
                className="block mt-0.5 w-40 text-sm border border-gray-300 rounded-md px-2 py-1" placeholder="Brand" />
            </label>
            <label className="text-[11px] text-gray-500">Heading in file
              <input value={d.header} list={listId} aria-label={`Product column ${i + 1} heading`}
                onChange={(e) => setDim(i, { header: e.target.value })}
                className="block mt-0.5 w-48 text-sm border border-gray-300 rounded-md px-2 py-1" />
            </label>
            <label className="text-[11px] text-gray-500">Key
              <input value={d.key} aria-label={`Product column ${i + 1} key`}
                onChange={(e) => setDim(i, { key: e.target.value })}
                className="block mt-0.5 w-32 font-mono text-xs border border-gray-300 rounded-md px-2 py-1.5" />
            </label>
            <Button size="sm" variant="ghost" type="button" aria-label={`Remove product column ${i + 1}`}
              onClick={() => {
                setTouched(true);
                setM((p) => ({ ...p, dimensions: p.dimensions.filter((_, j) => j !== i) }));
                setIsNewRow((p) => p.filter((_, j) => j !== i));
              }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        {m.dimensions.length < SALES_IMPORT_MAX_DIMENSIONS && (
          <Button size="sm" variant="outline" type="button"
            onClick={() => {
              setTouched(true);
              setM((p) => ({ ...p, dimensions: [...p.dimensions, { key: '', label: '', header: '' }] }));
              setIsNewRow((p) => [...p, true]);
            }}>
            <Plus className="w-3.5 h-3.5" /> Add product column
          </Button>
        )}
        <p className="text-[11px] text-gray-500">
          Changing a key breaks KPIs that use it. Edit the label instead if you only want a different name.
        </p>
      </div>

      </fieldset>

      {touched && errors.length > 0 && (
        <ul className="text-xs text-red-700 list-disc pl-4" data-testid="mapping-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={`text-sm ${msg.tone === 'err' ? 'text-red-600' : 'text-emerald-700'}`}>{msg.text}</p>}
      {canEdit ? (
        <Button variant="primary" type="button" onClick={save} loading={saving} disabled={touched && errors.length > 0}>Save column mapping</Button>
      ) : (
        <p className="text-xs text-gray-500" data-testid="mapping-read-only">You can view the column mapping, but you don&apos;t have permission to change it.</p>
      )}
    </section>
  );
}
