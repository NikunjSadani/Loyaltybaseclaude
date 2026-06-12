/**
 * lib/outlet-data.ts
 *
 * Manages per-outlet Excel-upload data used to pre-fill and display
 * values in enrollment forms.
 *
 * In production this would be fetched from the DB / a server action.
 * For demo purposes all data lives in localStorage, keyed by outletId.
 *
 * Storage format:
 *   Key:   loyaltybase_outlet_data_v1
 *   Value: Record<outletId, Record<dataKey, string>>
 */

const STORAGE_KEY = 'loyaltybase_outlet_data_v1';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A flat map of data-key → string value for a single outlet. */
export type OutletPrefillMap = Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// Seed data (mirrors the demo outlets in sales/outlets/page.tsx)
// ─────────────────────────────────────────────────────────────────────────────

const SEED_DATA: Record<string, OutletPrefillMap> = {
  o1: {
    'Last Month Sales':  '₹1,24,500',
    'Target Qty':        '850',
    'GSTIN':             '27AAPFU0939F1ZV',
    'Shop Area (sqft)':  '320',
    'Outlet Score':      '8.4',
    'Assigned Beat':     'Andheri Beat',
  },
  o2: {
    'Last Month Sales':  '₹82,000',
    'Target Qty':        '620',
    'GSTIN':             '27BBBPD1234B1ZA',
    'Shop Area (sqft)':  '180',
    'Outlet Score':      '6.1',
    'Assigned Beat':     'Andheri Beat',
  },
  o3: {
    'Last Month Sales':  '₹54,200',
    'Target Qty':        '410',
    'GSTIN':             '',
    'Shop Area (sqft)':  '140',
    'Outlet Score':      '5.0',
    'Assigned Beat':     'Juhu Beat',
  },
  o4: {
    'Last Month Sales':  '₹2,18,000',
    'Target Qty':        '1500',
    'GSTIN':             '27CCCPF5678G1ZB',
    'Shop Area (sqft)':  '640',
    'Outlet Score':      '9.1',
    'Assigned Beat':     'Juhu Beat',
  },
  o5: {
    'Last Month Sales':  '₹38,500',
    'Target Qty':        '290',
    'GSTIN':             '',
    'Shop Area (sqft)':  '95',
    'Outlet Score':      '4.7',
    'Assigned Beat':     'Versova Beat',
  },
  o6: {
    'Last Month Sales':  '₹96,700',
    'Target Qty':        '720',
    'GSTIN':             '27DDDPH9012H1ZC',
    'Shop Area (sqft)':  '260',
    'Outlet Score':      '7.8',
    'Assigned Beat':     'Versova Beat',
  },
  o7: {
    'Last Month Sales':  '₹71,300',
    'Target Qty':        '540',
    'GSTIN':             '27EEEPJ3456I1ZD',
    'Shop Area (sqft)':  '210',
    'Outlet Score':      '6.9',
    'Assigned Beat':     'DN Nagar Beat',
  },
  o8: {
    'Last Month Sales':  '₹42,800',
    'Target Qty':        '320',
    'GSTIN':             '',
    'Shop Area (sqft)':  '110',
    'Outlet Score':      '5.5',
    'Assigned Beat':     'DN Nagar Beat',
  },
  o9: {
    'Last Month Sales':  '₹3,04,000',
    'Target Qty':        '2100',
    'GSTIN':             '27FFFPK7890J1ZE',
    'Shop Area (sqft)':  '920',
    'Outlet Score':      '9.6',
    'Assigned Beat':     'Andheri Beat',
  },
  o10: {
    'Last Month Sales':  '₹61,500',
    'Target Qty':        '460',
    'GSTIN':             '',
    'Shop Area (sqft)':  '155',
    'Outlet Score':      '6.3',
    'Assigned Beat':     'Juhu Beat',
  },
  o11: {
    'Last Month Sales':  '₹1,87,000',
    'Target Qty':        '1280',
    'GSTIN':             '27GGGPL2345K1ZF',
    'Shop Area (sqft)':  '540',
    'Outlet Score':      '8.8',
    'Assigned Beat':     'Versova Beat',
  },
  o12: {
    'Last Month Sales':  '₹29,400',
    'Target Qty':        '220',
    'GSTIN':             '',
    'Shop Area (sqft)':  '80',
    'Outlet Score':      '4.2',
    'Assigned Beat':     'DN Nagar Beat',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadAll(): Record<string, OutletPrefillMap> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, OutletPrefillMap>;
  } catch { return {}; }
}

function saveAll(data: Record<string, OutletPrefillMap>): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeds demo data into localStorage if the key is absent.
 * Idempotent — will not overwrite existing data.
 */
export function seedOutletData(): void {
  const existing = loadAll();
  if (Object.keys(existing).length > 0) return;
  saveAll(SEED_DATA);
}

/**
 * Returns the prefill data map for a single outlet.
 * Returns an empty object if the outlet has no data.
 */
export function getOutletPrefillData(outletId: string): OutletPrefillMap {
  return loadAll()[outletId] ?? {};
}

/**
 * Upserts (replaces) the prefill data for a single outlet.
 * Used when admin uploads a new Excel with outlet data columns.
 */
export function saveOutletPrefillData(outletId: string, data: OutletPrefillMap): void {
  const all = loadAll();
  all[outletId] = data;
  saveAll(all);
}

/**
 * Bulk-saves outlet data from an Excel upload parse result.
 * outletDataRows: array of { outletId, ...dataColumns }
 */
export function bulkSaveOutletData(rows: Array<{ outletId: string } & Record<string, string>>): void {
  const all = loadAll();
  for (const row of rows) {
    const { outletId, ...rest } = row;
    all[outletId] = rest as OutletPrefillMap;
  }
  saveAll(all);
}
