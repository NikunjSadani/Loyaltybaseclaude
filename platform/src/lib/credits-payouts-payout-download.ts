/**
 * Credits & Payouts — Gifsy Payout Download
 *
 * Gifsy downloads a payout Excel file for a given period + field group.
 * At download time:
 *  1. Bank details are snapshotted (locked for audit)
 *  2. A PayoutBatch record is created with a unique batch ID
 *  3. Only PENDING payout entries are included (already-PAID rows excluded)
 *  4. Deactivated outlets are included but flagged
 *
 * File columns (STANDARD or SEPARATE):
 *   Batch ID | Outlet ID | Outlet Name | Phone | Bank Name | Account Number |
 *   IFSC | UPI ID | KYC Status | Deactivated | Amount
 *
 * UTR upload uses the same file with extra columns:
 *   UTR | Success/Failure | Remarks
 */

import * as XLSX from 'xlsx';
import type { CreditField, PayoutBatch, PayoutBatchRow, PayoutGroupType } from '@/types';
import {
  getPayoutEntries,
  getBankDetail,
  snapshotBankDetails,
  newPayoutBatchId,
  savePayoutBatch,
  getOpenPayoutBatchesForPeriod,
} from './credits-payouts-payout-store';

export interface CreatePayoutBatchOpts {
  period:       string;
  groupType:    PayoutGroupType;
  fieldId?:     string;
  fieldName?:   string;
  downloadedBy: string;
  fields:       CreditField[];
}

export interface CreatePayoutBatchResult {
  batch:        PayoutBatch;
  buffer:       ArrayBuffer;
  openWarning:  string | null;   // if another open batch exists for same period
}

// ─── Build the batch from pending entries ────────────────────────────────────

export function createPayoutBatch(opts: CreatePayoutBatchOpts): CreatePayoutBatchResult {
  const { period, groupType, fieldId, fieldName, downloadedBy, fields } = opts;

  // Get PENDING entries for the period
  let pendingEntries = getPayoutEntries({ period, status: 'PENDING' });

  // Filter by group type
  if (groupType === 'SEPARATE' && fieldId) {
    pendingEntries = pendingEntries.filter((e) => e.fieldId === fieldId);
  } else if (groupType === 'STANDARD') {
    // Standard: all fields NOT marked as separate
    const separateFieldIds = new Set(
      fields.filter((f) => f.isSeparatePayout).map((f) => f.id),
    );
    pendingEntries = pendingEntries.filter((e) => !separateFieldIds.has(e.fieldId));
  }

  // Group by outlet — sum amounts across fields for standard, single field for separate
  const outletMap = new Map<string, { name: string; amount: number; entryIds: string[] }>();
  for (const entry of pendingEntries) {
    const existing = outletMap.get(entry.outletId);
    if (existing) {
      existing.amount += entry.amount;
      existing.entryIds.push(entry.id);
    } else {
      outletMap.set(entry.outletId, {
        name:     entry.outletName,
        amount:   entry.amount,
        entryIds: [entry.id],
      });
    }
  }

  // Build rows with bank details snapshot
  const outletIds    = [...outletMap.keys()];
  const snapshots    = snapshotBankDetails(outletIds);
  const snapshotMap  = new Map(snapshots.map((s) => [s.outletId, s]));

  const rows: PayoutBatchRow[] = outletIds.map((id) => {
    const info     = outletMap.get(id)!;
    const bank     = getBankDetail(id);
    const snapshot = snapshotMap.get(id)!;
    return {
      outletId:      id,
      outletName:    info.name,
      phone:         bank?.phone         ?? '',
      bankName:      snapshot.bankName,
      accountNumber: snapshot.accountNumber,
      ifscCode:      snapshot.ifscCode,
      upiId:         snapshot.upiId,
      kycStatus:     bank?.kycStatus     ?? 'UNKNOWN',
      amount:        info.amount,
      isDeactivated: bank ? !bank.isActive : false,
      utrStatus:     'PENDING',
      entryIds:      info.entryIds,
    };
  });

  // Check for existing open batches (warning)
  const openBatches = getOpenPayoutBatchesForPeriod(period);
  const openWarning = openBatches.length > 0
    ? `Warning: ${openBatches.length} open batch(es) already exist for ${period} (${openBatches.map((b) => b.id).join(', ')}). Reconcile those before downloading a new batch.`
    : null;

  // Create batch record
  const batchId = newPayoutBatchId(period);
  const batch: PayoutBatch = {
    id:            batchId,
    creditBatchId: pendingEntries[0]?.batchId ?? 'MULTI',
    period,
    groupType,
    ...(fieldId   ? { fieldId }   : {}),
    ...(fieldName ? { fieldName } : {}),
    status:        rows.length > 0 ? 'OPEN' : 'PAID',
    downloadedAt:  new Date().toISOString(),
    downloadedBy,
    totalAmount:   rows.reduce((s, r) => s + r.amount, 0),
    bankSnapshots: snapshots,
    rows,
  };

  savePayoutBatch(batch);

  // Generate Excel buffer
  const buffer = generatePayoutFileBuffer(batch);

  return { batch, buffer, openWarning };
}

// ─── Excel generation ─────────────────────────────────────────────────────────

export const PAYOUT_FILE_HEADERS = [
  'Batch ID',
  'Outlet ID',
  'Outlet Name',
  'Phone',
  'Bank Name',
  'Account Number',
  'IFSC',
  'UPI ID',
  'KYC Status',
  'Deactivated',
  'Payout Amount',
  // Columns for UTR upload (blank in download, filled by Gifsy):
  'UTR',
  'Success/Failure',
  'Remarks',
];

export function generatePayoutFileBuffer(batch: PayoutBatch): ArrayBuffer {
  const label = new Date(batch.period + '-01').toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric',
  });

  const wsData: (string | number | boolean)[][] = [
    // Title row
    [`Payout File — ${label}${batch.groupType === 'SEPARATE' ? ` (${batch.fieldName ?? batch.fieldId})` : ''} — ${batch.id}`],
    // Header row
    PAYOUT_FILE_HEADERS,
    // Data rows
    ...batch.rows.map((r) => [
      batch.id,
      r.outletId,
      r.outletName,
      r.phone,
      r.bankName,
      r.accountNumber,
      r.ifscCode,
      r.upiId,
      r.kycStatus,
      r.isDeactivated ? 'YES' : 'NO',
      r.amount,
      '',  // UTR — blank, Gifsy fills
      '',  // Success/Failure — blank
      '',  // Remarks — blank
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [
    { wch: 18 },  // Batch ID
    { wch: 12 },  // Outlet ID
    { wch: 28 },  // Outlet Name
    { wch: 14 },  // Phone
    { wch: 16 },  // Bank Name
    { wch: 20 },  // Account Number
    { wch: 14 },  // IFSC
    { wch: 22 },  // UPI ID
    { wch: 14 },  // KYC Status
    { wch: 12 },  // Deactivated
    { wch: 16 },  // Amount
    { wch: 22 },  // UTR
    { wch: 16 },  // Success/Failure
    { wch: 30 },  // Remarks
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
