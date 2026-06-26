/**
 * Credits & Payouts — Gifsy Payout File Generator (pure)
 *
 * generatePayoutFileBuffer produces the Excel payout file from a PayoutBatch.
 * All persistence (creating the download record, snapshotting bank details)
 * is handled by /api/admin/credits/payout-downloads.
 *
 * File columns:
 *   Batch ID | Outlet ID | Outlet Name | Phone | Bank Name | Account Number |
 *   IFSC | UPI ID | KYC Status | Deactivated | Payout Amount |
 *   UTR | Success/Failure | Remarks
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import type { PayoutBatch } from '@/types';

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
  'UTR',
  'Success/Failure',
  'Remarks',
];

export function generatePayoutFileBuffer(batch: PayoutBatch): ArrayBuffer {
  const label = new Date(batch.period + '-01').toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric',
  });

  const wsData: (string | number | boolean)[][] = [
    [`Payout File — ${label}${batch.groupType === 'SEPARATE' ? ` (${batch.fieldName ?? batch.fieldId})` : ''} — ${batch.id}`],
    PAYOUT_FILE_HEADERS,
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
      '',
      '',
      '',
    ]),
  ];

  const ws = aoaToSheetSafe(wsData);
  ws['!cols'] = [
    { wch: 18 },
    { wch: 12 },
    { wch: 28 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 14 },
    { wch: 22 },
    { wch: 14 },
    { wch: 12 },
    { wch: 16 },
    { wch: 22 },
    { wch: 16 },
    { wch: 30 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
