/**
 * Credits & Payouts — Field Configuration
 *
 * Manages the configurable fields used in the bulk Credits & Payouts upload.
 * Each field represents a KPI column (e.g. "Scheme Volume", "Visibility").
 *
 * Rules:
 *  - Fields are per-tenant, creation-ordered (order never changes)
 *  - Deactivated fields are hidden from templates but kept for audit history
 *  - outletTypeAwards maps outlet type → POINTS | PAYOUT | NA
 *
 * Demo storage: localStorage key `gifsy_credit_fields_v1`
 * Production: comes from tenant settings in the database.
 */

import type { CreditField, FieldAwardType } from '@/types';

const STORAGE_KEY = 'gifsy_credit_fields_v1';

// ─── Demo seed (Deoleo default) ───────────────────────────────────────────────

export const DEMO_CREDIT_FIELDS: CreditField[] = [
  {
    id:               'cf_scheme_vol',
    name:             'Scheme Volume',
    isActive:         true,
    isSeparatePayout: false,
    outletTypeAwards: {
      WHOLESALER:   'POINTS',
      SSS:          'PAYOUT',
      SUB_STOCKIST: 'PAYOUT',
      SSS_TOT:      'PAYOUT',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    order:     1,
  },
  {
    id:               'cf_visibility',
    name:             'Visibility',
    isActive:         true,
    isSeparatePayout: false,
    outletTypeAwards: {
      WHOLESALER:   'POINTS',
      SSS:          'PAYOUT',
      SUB_STOCKIST: 'PAYOUT',
      SSS_TOT:      'PAYOUT',
    },
    createdAt: '2026-01-02T00:00:00.000Z',
    order:     2,
  },
  {
    id:               'cf_loyalty_bonus',
    name:             'Loyalty Bonus',
    isActive:         true,
    isSeparatePayout: true,   // downloaded as a separate payout file
    outletTypeAwards: {
      WHOLESALER:   'POINTS',
      SSS:          'PAYOUT',
      SUB_STOCKIST: 'PAYOUT',
      SSS_TOT:      'PAYOUT',
    },
    createdAt: '2026-01-03T00:00:00.000Z',
    order:     3,
  },
];

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadFields(): CreditField[] {
  if (typeof window === 'undefined') return DEMO_CREDIT_FIELDS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CreditField[];
  } catch { /* ignore */ }
  return DEMO_CREDIT_FIELDS;
}

function persistFields(fields: CreditField[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns all fields (active + inactive) in creation order. */
export function getAllFields(): CreditField[] {
  return loadFields();
}

/** Returns only active fields in creation order. */
export function getActiveFields(): CreditField[] {
  return loadFields().filter((f) => f.isActive);
}

/** Creates a new field and persists it. Throws if name is empty. */
export function createField(
  name: string,
  opts: {
    isSeparatePayout?:  boolean;
    outletTypeAwards?:  Record<string, FieldAwardType>;
  } = {},
): CreditField {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Field name cannot be empty');

  const all      = loadFields();
  const maxOrder = all.reduce((m, f) => Math.max(m, f.order), 0);

  const field: CreditField = {
    id:               `cf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name:             trimmed,
    isActive:         true,
    isSeparatePayout: opts.isSeparatePayout ?? false,
    outletTypeAwards: opts.outletTypeAwards ?? {
      WHOLESALER:   'POINTS',
      SSS:          'PAYOUT',
      SUB_STOCKIST: 'PAYOUT',
      SSS_TOT:      'PAYOUT',
    },
    createdAt: new Date().toISOString(),
    order:     maxOrder + 1,
  };

  persistFields([...all, field]);
  return field;
}

/** Deactivates a field (soft delete). Order is preserved. */
export function deactivateField(id: string): void {
  const all = loadFields();
  persistFields(all.map((f) => (f.id === id ? { ...f, isActive: false } : f)));
}

/** Reactivates a previously deactivated field. */
export function reactivateField(id: string): void {
  const all = loadFields();
  persistFields(all.map((f) => (f.id === id ? { ...f, isActive: true } : f)));
}

/**
 * Resets field storage to the provided seed (default: DEMO_CREDIT_FIELDS).
 * Used in tests and for demo reset.
 */
export function resetFields(seed: CreditField[] = DEMO_CREDIT_FIELDS): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
}
