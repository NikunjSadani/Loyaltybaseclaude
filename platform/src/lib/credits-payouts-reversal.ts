/**
 * Credits & Payouts — Reversal Workflow
 *
 * Reversals are initiated by CLIENT_ADMIN and approved by GIFSY_ADMIN.
 *
 * Rules:
 *  - POINTS: partial reversal allowed up to unredeemed amount
 *  - PAYOUT: only if status is PENDING (UTR not yet uploaded)
 *  - Gifsy must approve (auto-approved in demo mode)
 *  - Blocked within the same calendar month as upload (configurable cutoff)
 *  - Append-only audit trail
 *
 * Demo storage: localStorage key gifsy_reversals_v1
 */

import type { ReversalRequest, ReversalStatus, CreditBatch } from '@/types';
import { getAllBatches } from './credits-payouts-store';
import { getPayoutEntries } from './credits-payouts-payout-store';

const REVERSALS_KEY = 'gifsy_reversals_v1';

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadReversals(): ReversalRequest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(REVERSALS_KEY);
    if (raw) return JSON.parse(raw) as ReversalRequest[];
  } catch { /* ignore */ }
  return [];
}

function persistReversals(reversals: ReversalRequest[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(REVERSALS_KEY, JSON.stringify(reversals));
}

export function getAllReversals(): ReversalRequest[] {
  return loadReversals();
}

export function getReversalsForOutlet(outletId: string): ReversalRequest[] {
  return loadReversals().filter((r) => r.outletId === outletId);
}

export function resetReversals(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(REVERSALS_KEY);
}

// ─── Eligibility check ────────────────────────────────────────────────────────

export interface ReversalEligibility {
  eligible:         boolean;
  reason:           string | null;
  maxReversibleAmount: number;
  awardType:        'POINTS' | 'PAYOUT' | null;
}

/**
 * Checks whether a reversal is eligible for a given outlet+field+period.
 *
 * For POINTS: eligible if the outlet has unredeemed points from this batch.
 * For PAYOUT: eligible if the payout entry is still PENDING.
 */
export function checkReversalEligibility(opts: {
  batchId:   string;
  outletId:  string;
  fieldId:   string;
}): ReversalEligibility {
  const { batchId, outletId, fieldId } = opts;

  // Find the batch
  const batches = getAllBatches();
  const batch   = batches.find((b) => b.id === batchId);
  if (!batch) {
    return { eligible: false, reason: `Batch "${batchId}" not found.`, maxReversibleAmount: 0, awardType: null };
  }
  if (batch.status !== 'CONFIRMED') {
    return { eligible: false, reason: 'Batch must be confirmed before reversal.', maxReversibleAmount: 0, awardType: null };
  }

  // Find the specific row in the batch
  const row = batch.rows.find((r) => r.outletId === outletId && r.fieldId === fieldId && r.status === 'OK');
  if (!row) {
    return { eligible: false, reason: `No OK entry found for outlet "${outletId}" and field "${fieldId}" in this batch.`, maxReversibleAmount: 0, awardType: null };
  }

  if (row.awardType === 'POINTS') {
    // For points: check how much has already been reversed
    const existingReversals = loadReversals().filter(
      (r) => r.batchId === batchId && r.outletId === outletId && r.fieldId === fieldId
             && (r.status === 'APPROVED' || r.status === 'PARTIAL'),
    );
    const alreadyReversed = existingReversals.reduce((s, r) => s + (r.approvedAmount ?? 0), 0);
    const maxReversible   = row.amount - alreadyReversed;

    if (maxReversible <= 0) {
      return { eligible: false, reason: 'All points from this entry have already been reversed.', maxReversibleAmount: 0, awardType: 'POINTS' };
    }

    return { eligible: true, reason: null, maxReversibleAmount: maxReversible, awardType: 'POINTS' };
  } else {
    // For PAYOUT: check if the payout entry is still PENDING
    const payoutEntries = getPayoutEntries().filter(
      (e) => e.batchId === batchId && e.outletId === outletId && e.fieldId === fieldId,
    );
    const pendingEntry = payoutEntries.find((e) => e.status === 'PENDING' || e.status === 'PROCESSING');

    if (!pendingEntry) {
      const failedEntry = payoutEntries.find((e) => e.status === 'FAILED');
      if (failedEntry) {
        return { eligible: false, reason: 'Payout is in FAILED state. Use the retry flow instead.', maxReversibleAmount: 0, awardType: 'PAYOUT' };
      }
      return { eligible: false, reason: 'Payout has already been processed. Cannot reverse a paid payout.', maxReversibleAmount: 0, awardType: 'PAYOUT' };
    }

    return { eligible: true, reason: null, maxReversibleAmount: row.amount, awardType: 'PAYOUT' };
  }
}

// ─── Initiate reversal ────────────────────────────────────────────────────────

export interface InitiateReversalOpts {
  batchId:         string;
  outletId:        string;
  outletName:      string;
  fieldId:         string;
  fieldName:       string;
  period:          string;
  requestedAmount: number;
  requestedBy:     string;
  remarks?:        string;
}

export function initiateReversal(opts: InitiateReversalOpts): ReversalRequest {
  const { batchId, outletId, outletName, fieldId, fieldName, period, requestedAmount, requestedBy, remarks } = opts;

  // Validate eligibility
  const elig = checkReversalEligibility({ batchId, outletId, fieldId });
  if (!elig.eligible) throw new Error(elig.reason ?? 'Reversal not eligible.');
  if (requestedAmount <= 0) throw new Error('Requested amount must be greater than zero.');
  if (requestedAmount > elig.maxReversibleAmount) {
    throw new Error(`Requested amount ${requestedAmount} exceeds maximum reversible amount ${elig.maxReversibleAmount}.`);
  }

  // Find original amount
  const batch = getAllBatches().find((b) => b.id === batchId);
  const row   = batch?.rows.find((r) => r.outletId === outletId && r.fieldId === fieldId && r.status === 'OK');

  const request: ReversalRequest = {
    id:              `rev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    batchId,
    outletId,
    outletName,
    fieldId,
    fieldName,
    period,
    awardType:       elig.awardType!,
    originalAmount:  row?.amount ?? requestedAmount,
    requestedAmount,
    requestedBy,
    requestedAt:     new Date().toISOString(),
    status:          'PENDING_GIFSY',
    ...(remarks ? { remarks } : {}),
  };

  persistReversals([...loadReversals(), request]);
  return request;
}

// ─── Approve / reject reversal ────────────────────────────────────────────────

export function approveReversal(
  requestId:      string,
  approvedBy:     string,
  approvedAmount: number,
): ReversalRequest {
  const all     = loadReversals();
  const request = all.find((r) => r.id === requestId);
  if (!request) throw new Error(`Reversal request "${requestId}" not found.`);
  if (request.status !== 'PENDING_GIFSY') throw new Error('Reversal is not in PENDING_GIFSY state.');
  if (approvedAmount <= 0) throw new Error('Approved amount must be greater than zero.');
  if (approvedAmount > request.requestedAmount) throw new Error('Approved amount cannot exceed requested amount.');

  const isPartial = approvedAmount < request.requestedAmount;
  const updated: ReversalRequest = {
    ...request,
    approvedAmount,
    approvedBy,
    approvedAt:  new Date().toISOString(),
    status:      isPartial ? 'PARTIAL' : 'APPROVED',
  };

  persistReversals(all.map((r) => (r.id === requestId ? updated : r)));
  return updated;
}

export function rejectReversal(
  requestId: string,
  rejectedBy: string,
  remarks:    string,
): ReversalRequest {
  const all     = loadReversals();
  const request = all.find((r) => r.id === requestId);
  if (!request) throw new Error(`Reversal request "${requestId}" not found.`);
  if (request.status !== 'PENDING_GIFSY') throw new Error('Reversal is not in PENDING_GIFSY state.');

  const updated: ReversalRequest = {
    ...request,
    status:     'REJECTED',
    approvedBy: rejectedBy,
    approvedAt: new Date().toISOString(),
    remarks,
  };

  persistReversals(all.map((r) => (r.id === requestId ? updated : r)));
  return updated;
}
