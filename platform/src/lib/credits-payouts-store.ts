/**
 * Credits & Payouts — Batch Persistence
 *
 * Stores uploaded/confirmed batches in localStorage for the demo.
 * In production these would be persisted via API routes to the database.
 *
 * Key: gifsy_credit_batches_v1
 */

import type { CreditBatch } from '@/types';

const BATCHES_KEY = 'gifsy_credit_batches_v1';

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadBatches(): CreditBatch[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(BATCHES_KEY);
    if (raw) return JSON.parse(raw) as CreditBatch[];
  } catch { /* ignore */ }
  return [];
}

function persistBatches(batches: CreditBatch[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns all batches, newest first. */
export function getAllBatches(): CreditBatch[] {
  return loadBatches().sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Returns batches for a specific period. */
export function getBatchesForPeriod(period: string): CreditBatch[] {
  return loadBatches().filter((b) => b.period === period);
}

/** Saves a new batch (PENDING_CONFIRM status). */
export function saveBatch(batch: CreditBatch): void {
  const all = loadBatches();
  const existing = all.findIndex((b) => b.id === batch.id);
  if (existing >= 0) all[existing] = batch;
  else all.push(batch);
  persistBatches(all);
}

/** Confirms a batch — sets status to CONFIRMED and records confirmedAt/By. */
export function confirmBatch(batchId: string, confirmedBy: string): void {
  const all = loadBatches();
  persistBatches(
    all.map((b) =>
      b.id === batchId
        ? { ...b, status: 'CONFIRMED', confirmedAt: new Date().toISOString(), confirmedBy }
        : b,
    ),
  );
}

/**
 * Generates a human-readable credit batch ID for the given period.
 * Format: CB-YYYY-MM-NNN  (e.g. CB-2026-05-001)
 * Sequence NNN is derived from the count of existing batches for that period.
 */
export function newBatchId(period: string): string {
  const existing = getBatchesForPeriod(period);
  const seq = String(existing.length + 1).padStart(3, '0');
  return `CB-${period}-${seq}`;
}

/**
 * Returns true if the upload window is still open for the current period.
 * The window closes after `cutoffDay` of the current month.
 *
 * @param cutoffDay  Day-of-month after which uploads are blocked (inclusive boundary: day = cutoff is still open)
 * @param today      Inject today's date (for testing); defaults to new Date()
 */
export function isUploadWindowOpen(cutoffDay: number, today?: Date): boolean {
  const now = today ?? new Date();
  return now.getDate() <= cutoffDay;
}

/** Clears all batches (for test resets). */
export function resetBatches(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(BATCHES_KEY);
}
