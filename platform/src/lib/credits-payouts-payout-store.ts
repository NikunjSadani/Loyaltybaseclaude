/**
 * Credits & Payouts — Payout Entries & Payout Batch Store
 *
 * Two separate concerns:
 *   1. CreditPayoutEntry — one record per outlet × field × period (created on batch confirm)
 *   2. PayoutBatch       — Gifsy download batch (bank snapshot, batch ID)
 *
 * Demo: all in localStorage.
 */

import type { CreditPayoutEntry, CreditBatch, PayoutBatch, BankSnapshot } from '@/types';

const ENTRIES_KEY = 'gifsy_payout_entries_v1';
const BATCHES_KEY = 'gifsy_payout_batches_v1';

// ─── Demo bank details ────────────────────────────────────────────────────────

export interface DemoBankDetail {
  bankName:          string;
  accountHolderName: string;
  accountNumber:     string;
  ifscCode:          string;
  upiId:             string;
  phone:             string;
  kycStatus:         string;
  isActive:          boolean;
}

export const DEMO_BANK_DETAILS: Record<string, DemoBankDetail> = {
  'WS-001': { bankName: 'HDFC Bank',  accountHolderName: 'Anand Wholesalers',      accountNumber: '50100123456789',  ifscCode: 'HDFC0001234', upiId: 'anand.ws001@hdfc',  phone: '9820111001', kycStatus: 'APPROVED', isActive: true  },
  'WS-002': { bankName: 'ICICI Bank', accountHolderName: 'Bharat Distributors',    accountNumber: '000105016781234', ifscCode: 'ICIC0000001', upiId: 'bharat.ws002@icici',phone: '9820111002', kycStatus: 'APPROVED', isActive: true  },
  'WS-003': { bankName: 'SBI',        accountHolderName: 'South India Traders',    accountNumber: '31234567890',     ifscCode: 'SBIN0001234', upiId: 'south.ws003@sbi',  phone: '9820111003', kycStatus: 'APPROVED', isActive: true  },
  'WS-004': { bankName: 'Axis Bank',  accountHolderName: 'Gujarat Trading Co',     accountNumber: '9120001234567',   ifscCode: 'UTIB0000001', upiId: 'gujarat.ws004@axis',phone: '9820111004', kycStatus: 'APPROVED', isActive: true  },
  'RT-001': { bankName: 'Kotak Bank', accountHolderName: 'Rajesh Sharma',          accountNumber: '9876543210',      ifscCode: 'KKBK0000001', upiId: 'sharma.rt001@kotak',phone: '9820111005', kycStatus: 'APPROVED', isActive: true  },
  'RT-002': { bankName: 'PNB',        accountHolderName: 'Suresh Patel',           accountNumber: '0193000100345',   ifscCode: 'PUNB0001900', upiId: 'patel.rt002@pnb',  phone: '9820111006', kycStatus: 'APPROVED', isActive: true  },
  'RT-003': { bankName: 'BOB',        accountHolderName: 'Rajkumar Retail',        accountNumber: '1234567890123',   ifscCode: 'BARB0RT0003', upiId: 'raj.rt003@bob',    phone: '9820111007', kycStatus: 'APPROVED', isActive: true  },
  'RT-004': { bankName: 'SBI',        accountHolderName: 'Ravi Kumar',             accountNumber: '99876543210',     ifscCode: 'SBIN0005678', upiId: 'kumar.rt004@sbi',  phone: '9820111008', kycStatus: 'APPROVED', isActive: true  },
  'RT-005': { bankName: 'HDFC Bank',  accountHolderName: 'Venkatesh Provision',    accountNumber: '50200567891234',  ifscCode: 'HDFC0005678', upiId: 'venkatesh@hdfc',   phone: '9820111009', kycStatus: 'APPROVED', isActive: true  },
  'RT-006': { bankName: 'ICICI Bank', accountHolderName: 'Mehta Stores',           accountNumber: '000205016789012', ifscCode: 'ICIC0000045', upiId: 'mehta.rt006@icici',phone: '9820111010', kycStatus: 'APPROVED', isActive: false }, // deactivated
  'RT-007': { bankName: 'Axis Bank',  accountHolderName: 'Singh Supermart',        accountNumber: '9220001234567',   ifscCode: 'UTIB0000123', upiId: 'singh.rt007@axis', phone: '9820111011', kycStatus: 'APPROVED', isActive: true  },
  'SS-001': { bankName: 'Union Bank', accountHolderName: 'Mumbai SS Distributors', accountNumber: '556700001234567', ifscCode: 'UBIN0555670', upiId: 'mum.ss001@ubank',  phone: '9820111012', kycStatus: 'APPROVED', isActive: true  },
  'SS-002': { bankName: 'Canara Bank',accountHolderName: 'Deccan Sub-Stockist',    accountNumber: '3234500100234',   ifscCode: 'CNRB0003234', upiId: 'deccan.ss002@cnrb',phone: '9820111013', kycStatus: 'APPROVED', isActive: true  },
  'SS-003': { bankName: 'BOI',        accountHolderName: 'Karnataka Traders',      accountNumber: '8765432109876',   ifscCode: 'BKID0000876', upiId: 'karnataka@boi',    phone: '9820111014', kycStatus: 'APPROVED', isActive: true  },
  'SSS-001':{ bankName: 'HDFC Bank',  accountHolderName: 'D-Mart Retail Pvt Ltd',  accountNumber: '50100987654321',  ifscCode: 'HDFC0009876', upiId: 'dmart@hdfc',       phone: '9820111015', kycStatus: 'APPROVED', isActive: true  },
  'SSS-002':{ bankName: 'SBI',        accountHolderName: 'Big Bazaar Future Grp',  accountNumber: '12345678901',     ifscCode: 'SBIN0012345', upiId: 'bigbazaar@sbi',    phone: '9820111016', kycStatus: 'APPROVED', isActive: true  },
  'SSS-003':{ bankName: 'ICICI Bank', accountHolderName: 'Reliance Retail Ltd',    accountNumber: '000305016789123', ifscCode: 'ICIC0000067', upiId: 'reliance@icici',   phone: '9820111017', kycStatus: 'APPROVED', isActive: true  },
  'SSS-004':{ bankName: 'Kotak Bank', accountHolderName: "Spencer's Retail Ltd",   accountNumber: '9876001234',      ifscCode: 'KKBK0000234', upiId: 'spencers@kotak',   phone: '9820111018', kycStatus: 'APPROVED', isActive: true  },
};

export function getBankDetail(outletId: string): DemoBankDetail | undefined {
  return DEMO_BANK_DETAILS[outletId];
}

// ─── Payout Entry helpers ─────────────────────────────────────────────────────

function loadEntries(): CreditPayoutEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    if (raw) return JSON.parse(raw) as CreditPayoutEntry[];
  } catch { /* ignore */ }
  return [];
}

function persistEntries(entries: CreditPayoutEntry[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
}

/** Creates payout entries from the PAYOUT-type rows in a confirmed credit batch. */
export function createPayoutEntriesFromBatch(batch: CreditBatch): CreditPayoutEntry[] {
  const existing = loadEntries();
  const existingKeys = new Set(existing.map((e) => `${e.batchId}|${e.outletId}|${e.fieldId}|${e.period}`));

  const newEntries: CreditPayoutEntry[] = [];
  const now = new Date().toISOString();

  for (const row of batch.rows) {
    if (row.status !== 'OK' || row.awardType !== 'PAYOUT') continue;
    const key = `${batch.id}|${row.outletId}|${row.fieldId}|${batch.period}`;
    if (existingKeys.has(key)) continue;

    const entry: CreditPayoutEntry = {
      id:        `pe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      batchId:   batch.id,
      outletId:  row.outletId,
      outletName: row.outletName,
      fieldId:   row.fieldId,
      fieldName: row.fieldName,
      period:    batch.period,
      amount:    row.amount,
      narration: row.narration,
      status:    'PENDING',
      createdAt: now,
    };
    newEntries.push(entry);
    existingKeys.add(key);
  }

  persistEntries([...existing, ...newEntries]);
  return newEntries;
}

export function getPayoutEntries(opts?: { period?: string; status?: string }): CreditPayoutEntry[] {
  const all = loadEntries();
  return all.filter((e) => {
    if (opts?.period && e.period !== opts.period) return false;
    if (opts?.status && e.status !== opts.status) return false;
    return true;
  });
}

export function updatePayoutEntryStatus(
  id: string,
  status: CreditPayoutEntry['status'],
  utr?: string,
): void {
  const all = loadEntries();
  persistEntries(
    all.map((e) =>
      e.id === id
        ? { ...e, status, ...(utr ? { utr } : {}), ...(status === 'PAID' ? { paidAt: new Date().toISOString() } : {}) }
        : e,
    ),
  );
}

export function resetPayoutEntries(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ENTRIES_KEY);
}

// ─── Payout Batch helpers ─────────────────────────────────────────────────────

function loadPayoutBatches(): PayoutBatch[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(BATCHES_KEY);
    if (raw) return JSON.parse(raw) as PayoutBatch[];
  } catch { /* ignore */ }
  return [];
}

function persistPayoutBatches(batches: PayoutBatch[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
}

export function savePayoutBatch(batch: PayoutBatch): void {
  const all = loadPayoutBatches();
  const idx = all.findIndex((b) => b.id === batch.id);
  if (idx >= 0) all[idx] = batch; else all.push(batch);
  persistPayoutBatches(all);
}

export function getPayoutBatch(id: string): PayoutBatch | undefined {
  return loadPayoutBatches().find((b) => b.id === id);
}

export function getAllPayoutBatches(): PayoutBatch[] {
  return loadPayoutBatches().sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
}

export function getOpenPayoutBatchesForPeriod(period: string): PayoutBatch[] {
  return loadPayoutBatches().filter((b) => b.period === period && b.status === 'OPEN');
}

export function newPayoutBatchId(period: string): string {
  const existing = loadPayoutBatches().filter((b) => b.period === period);
  const seq = String(existing.length + 1).padStart(3, '0');
  return `PB-${period}-${seq}`;
}

/** Takes a bank snapshot for a list of outlet IDs at download time. */
export function snapshotBankDetails(outletIds: string[]): BankSnapshot[] {
  const now = new Date().toISOString();
  return outletIds.map((id) => {
    const detail = DEMO_BANK_DETAILS[id];
    return {
      outletId:          id,
      bankName:          detail?.bankName          ?? '',
      accountHolderName: detail?.accountHolderName ?? '',
      accountNumber:     detail?.accountNumber     ?? '',
      ifscCode:          detail?.ifscCode          ?? '',
      upiId:             detail?.upiId             ?? '',
      snapshotAt:        now,
    };
  });
}

export function resetPayoutBatches(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(BATCHES_KEY);
}
