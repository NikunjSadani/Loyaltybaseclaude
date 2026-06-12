'use client';

import { useState } from 'react';
import {
  ChevronRight,
  CreditCard,
  CheckCircle,
  Clock,
  ArrowRight,
  Download,
  RefreshCw,
  Search,
  Wallet,
  AlertCircle,
} from 'lucide-react';
import Link from 'next/link';

type PayoutBatchStatus =
  | 'CALCULATED'
  | 'VALIDATED'
  | 'INVOICED'
  | 'TDS_DEDUCTED'
  | 'DISBURSED'
  | 'RECONCILED';

interface PayoutBatch {
  id: string;
  month: string;
  status: PayoutBatchStatus;
  partnerCount: number;
  grossAmount: string;
  tdsAmount: string;
  netAmount: string;
  processedAt?: string;
}

interface PayoutTransaction {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerClass: string;
  territory: string;
  grossAmount: string;
  tdsAmount: string;
  netAmount: string;
  payoutMode: string;
  utrNumber?: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED' | 'HOLD';
}

const BATCHES: PayoutBatch[] = [
  { id: 'BAT-2025-04', month: 'April 2025', status: 'DISBURSED', partnerCount: 1243, grossAmount: '₹28.4L', tdsAmount: '₹2.84L', netAmount: '₹25.56L', processedAt: '2025-05-02' },
  { id: 'BAT-2025-03', month: 'March 2025', status: 'RECONCILED', partnerCount: 1198, grossAmount: '₹24.7L', tdsAmount: '₹2.47L', netAmount: '₹22.23L', processedAt: '2025-04-04' },
  { id: 'BAT-2025-02', month: 'February 2025', status: 'RECONCILED', partnerCount: 1054, grossAmount: '₹19.8L', tdsAmount: '₹1.98L', netAmount: '₹17.82L', processedAt: '2025-03-06' },
  { id: 'BAT-2025-01', month: 'January 2025', status: 'RECONCILED', partnerCount: 987, grossAmount: '₹17.3L', tdsAmount: '₹1.73L', netAmount: '₹15.57L', processedAt: '2025-02-05' },
  { id: 'BAT-2025-05', month: 'May 2025', status: 'CALCULATED', partnerCount: 1312, grossAmount: '₹31.8L', tdsAmount: '₹3.18L', netAmount: '₹28.62L' },
];

const TRANSACTIONS: PayoutTransaction[] = [
  { id: 'TXN001', partnerId: 'P005', partnerName: 'K. Krishnamurthy & Sons', partnerClass: 'PLATINUM', territory: 'Chennai', grossAmount: '₹48,500', tdsAmount: '₹4,850', netAmount: '₹43,650', payoutMode: 'BANK_TRANSFER', utrNumber: 'ICIC325001234', status: 'PROCESSED' },
  { id: 'TXN002', partnerId: 'P001', partnerName: 'Rakesh Sharma', partnerClass: 'GOLD', territory: 'Mumbai West', grossAmount: '₹22,000', tdsAmount: '₹2,200', netAmount: '₹19,800', payoutMode: 'UPI', utrNumber: 'UPI428001892', status: 'PROCESSED' },
  { id: 'TXN003', partnerId: 'P002', partnerName: 'Ramesh Gupta', partnerClass: 'SILVER', territory: 'Delhi NCR', grossAmount: '₹14,500', tdsAmount: '₹1,450', netAmount: '₹13,050', payoutMode: 'BANK_TRANSFER', utrNumber: 'HDFC921003412', status: 'PROCESSED' },
  { id: 'TXN004', partnerId: 'P003', partnerName: 'Vijay Patel', partnerClass: 'BRONZE', territory: 'Ahmedabad', grossAmount: '₹8,200', tdsAmount: '₹820', netAmount: '₹7,380', payoutMode: 'UPI', status: 'FAILED' },
  { id: 'TXN005', partnerId: 'P010', partnerName: 'Suresh Wholesalers', partnerClass: 'SILVER', territory: 'Hyderabad', grossAmount: '₹18,400', tdsAmount: '₹1,840', netAmount: '₹16,560', payoutMode: 'BANK_TRANSFER', status: 'PENDING' },
  { id: 'TXN006', partnerId: 'P012', partnerName: 'Banerjee Traders', partnerClass: 'STANDARD', territory: 'Kolkata', grossAmount: '₹5,600', tdsAmount: '₹560', netAmount: '₹5,040', payoutMode: 'UPI', status: 'HOLD' },
];

const BATCH_STATUS_ORDER: PayoutBatchStatus[] = [
  'CALCULATED', 'VALIDATED', 'INVOICED', 'TDS_DEDUCTED', 'DISBURSED', 'RECONCILED',
];

const BATCH_STATUS_LABELS: Record<PayoutBatchStatus, string> = {
  CALCULATED: 'Calculated',
  VALIDATED: 'Validated',
  INVOICED: 'Invoiced',
  TDS_DEDUCTED: 'TDS Deducted',
  DISBURSED: 'Disbursed',
  RECONCILED: 'Reconciled',
};

const TXN_STATUS_STYLES: Record<string, string> = {
  PROCESSED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
  HOLD: 'bg-gray-100 text-gray-600',
};

const CLASS_COLORS: Record<string, string> = {
  PLATINUM: 'text-purple-700 bg-purple-50',
  GOLD: 'text-amber-700 bg-amber-50',
  SILVER: 'text-gray-600 bg-gray-100',
  BRONZE: 'text-orange-700 bg-orange-50',
  STANDARD: 'text-blue-700 bg-blue-50',
};

const PAYOUT_MODE_LABELS: Record<string, string> = {
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank Transfer',
  VOUCHER: 'Voucher',
  GIFT: 'Gift',
  CATALOGUE: 'Catalogue',
};

export default function PayoutsPage() {
  const [selectedBatch, setSelectedBatch] = useState<PayoutBatch>(BATCHES[0]);
  const [search, setSearch] = useState('');
  const [processing, setProcessing] = useState(false);

  const filtered = TRANSACTIONS.filter(
    (t) =>
      !search ||
      t.partnerName.toLowerCase().includes(search.toLowerCase()) ||
      t.utrNumber?.includes(search)
  );

  const handleProcessBatch = async () => {
    setProcessing(true);
    await new Promise((r) => setTimeout(r, 1500));
    setProcessing(false);
    alert('Batch processing initiated. You will be notified when complete.');
  };

  const currentStatusIdx = BATCH_STATUS_ORDER.indexOf(selectedBatch.status);

  return (
    <div className="space-y-5 fade-in">
      {/* Fund summary card */}
      <div className="bg-gradient-to-r from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-white/10 rounded-xl">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">Fund Ledger Summary</p>
              <p className="text-xs text-slate-400">May 2025</p>
            </div>
          </div>
          <Link href="/payouts/fund" className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors">
            Manage Funds →
          </Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Opening Balance', value: '₹1.24 Cr' },
            { label: 'Received (May)', value: '₹50.0L' },
            { label: 'Utilised (May)', value: '₹89.7L' },
            { label: 'Available Balance', value: '₹84.3L', alert: true },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-xs text-slate-400">{item.label}</p>
              <p className={`text-lg font-bold mt-0.5 ${item.alert ? 'text-amber-400' : 'text-white'}`}>
                {item.value}
              </p>
              {item.alert && (
                <p className="text-xs text-amber-400 flex items-center gap-1 mt-0.5">
                  <AlertCircle className="w-3 h-3" /> Below threshold
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Batch list */}
        <div className="lg:col-span-1 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">Payout Batches</h2>
          <div className="space-y-2">
            {BATCHES.map((batch) => (
              <button
                key={batch.id}
                onClick={() => setSelectedBatch(batch)}
                className={`w-full text-left p-3 rounded-xl border transition-all ${
                  selectedBatch.id === batch.id
                    ? 'border-[var(--brand-primary)] bg-red-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-gray-900">{batch.month}</p>
                  <ChevronRight className={`w-4 h-4 ${selectedBatch.id === batch.id ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} />
                </div>
                <p className="text-xs text-gray-500 mb-1">{batch.partnerCount.toLocaleString()} partners</p>
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${
                    batch.status === 'RECONCILED' ? 'text-green-600' :
                    batch.status === 'DISBURSED' ? 'text-blue-600' :
                    batch.status === 'CALCULATED' ? 'text-amber-600' : 'text-gray-600'
                  }`}>
                    {BATCH_STATUS_LABELS[batch.status]}
                  </span>
                  <span className="text-xs font-bold text-gray-800">{batch.netAmount}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Batch detail */}
        <div className="lg:col-span-3 space-y-4">
          {/* Batch header */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  {selectedBatch.month} — Payout Batch
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Batch ID: {selectedBatch.id}
                  {selectedBatch.processedAt && ` · Processed: ${selectedBatch.processedAt}`}
                </p>
              </div>
              {selectedBatch.status === 'CALCULATED' && (
                <button
                  onClick={handleProcessBatch}
                  disabled={processing}
                  className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60"
                >
                  <RefreshCw className={`w-4 h-4 ${processing ? 'animate-spin' : ''}`} />
                  {processing ? 'Processing...' : 'Process Batch'}
                </button>
              )}
              {selectedBatch.status === 'RECONCILED' && (
                <button className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors">
                  <Download className="w-4 h-4" />
                  Download Report
                </button>
              )}
            </div>

            {/* Status pipeline */}
            <div className="flex items-center gap-1 overflow-x-auto py-2">
              {BATCH_STATUS_ORDER.map((status, idx) => {
                const done = idx < currentStatusIdx;
                const current = idx === currentStatusIdx;
                const pending = idx > currentStatusIdx;
                return (
                  <div key={status} className="flex items-center gap-1">
                    <div className="flex flex-col items-center gap-1">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                          done
                            ? 'bg-green-500 text-white'
                            : current
                            ? 'bg-[var(--brand-primary)] text-white'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {done ? <CheckCircle className="w-4 h-4" /> : idx + 1}
                      </div>
                      <span className={`text-xs font-medium whitespace-nowrap ${
                        done ? 'text-green-600' : current ? 'text-[var(--brand-primary)]' : 'text-gray-400'
                      }`}>
                        {BATCH_STATUS_LABELS[status]}
                      </span>
                    </div>
                    {idx < BATCH_STATUS_ORDER.length - 1 && (
                      <div className={`h-px w-6 mt-0 mb-4 ${done ? 'bg-green-400' : 'bg-gray-200'}`} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Batch totals */}
            <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-100">
              <div>
                <p className="text-xs text-gray-500">Gross Amount</p>
                <p className="text-lg font-bold text-gray-900 mt-0.5">{selectedBatch.grossAmount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">TDS Deducted</p>
                <p className="text-lg font-bold text-red-600 mt-0.5">{selectedBatch.tdsAmount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Net Disbursed</p>
                <p className="text-lg font-bold text-green-700 mt-0.5">{selectedBatch.netAmount}</p>
              </div>
            </div>
          </div>

          {/* Transaction table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">Transactions</h3>
              <div className="flex gap-3 items-center">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search partner or UTR..."
                    className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] w-48"
                  />
                </div>
                <button className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50 transition-colors">
                  <Download className="w-3.5 h-3.5" />
                  Export
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Partner</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Class</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Gross</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">TDS</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Net</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Mode</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">UTR</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((txn) => (
                    <tr key={txn.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5">
                        <div>
                          <p className="text-xs font-medium text-gray-900">{txn.partnerName}</p>
                          <p className="text-xs text-gray-400">{txn.territory}</p>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${CLASS_COLORS[txn.partnerClass] ?? 'bg-gray-100 text-gray-700'}`}>
                          {txn.partnerClass}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 text-right">{txn.grossAmount}</td>
                      <td className="px-4 py-2.5 text-xs text-red-600 text-right">{txn.tdsAmount}</td>
                      <td className="px-4 py-2.5 text-xs font-semibold text-gray-900 text-right">{txn.netAmount}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-600">{PAYOUT_MODE_LABELS[txn.payoutMode]}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-gray-500">{txn.utrNumber ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TXN_STATUS_STYLES[txn.status]}`}>
                          {txn.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                Showing {filtered.length} of {TRANSACTIONS.length} transactions
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
