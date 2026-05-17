'use client'

import { useState, useEffect } from 'react'
import { TrendingUp, TrendingDown, AlertTriangle, PlusCircle, Download, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface FundLedger {
  openingBalance: number
  fundsReceived: number
  utilisedGiftCard: number
  utilisedUpi: number
  utilisedBankTransfer: number
  utilisedPhysicalGift: number
  closingBalance: number
  pendingLiability: number
  availableBalance: number
  reconciliationVariance: number
}

interface FundReceipt {
  id: string
  amount: number
  referenceNumber: string
  paymentDate: string
  remarks: string
  recordedAt: string
}

const fmt = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

export default function FundPage() {
  const [ledger, setLedger] = useState<FundLedger | null>(null)
  const [receipts, setReceipts] = useState<FundReceipt[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ amount: '', referenceNumber: '', paymentDate: '', remarks: '' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    Promise.all([
      fetch('/api/payouts/fund', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([fundData]) => {
      if (fundData.success) setLedger(fundData.data.ledger)
      setLoading(false)
    })
  }, [])

  const handleRecordPayment = async () => {
    setSubmitting(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/payouts/fund/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...form, amount: Math.round(parseFloat(form.amount) * 100) }),
      })
      const data = await res.json()
      if (data.success) {
        setShowForm(false)
        setForm({ amount: '', referenceNumber: '', paymentDate: '', remarks: '' })
        setReceipts(prev => [data.data, ...prev])
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleExport = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/payouts/reconciliation?format=xlsx', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fund-reconciliation-${new Date().toISOString().split('T')[0]}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="p-6 flex items-center justify-center"><RefreshCw className="animate-spin h-6 w-6 text-[#C8102E]" /></div>

  const isLowBalance = ledger && ledger.availableBalance < 100000 * 100

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Fund Management</h1>
          <p className="text-sm text-gray-500 mt-1">Program fund ledger and reconciliation</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} className="text-sm border-[#C8102E] text-[#C8102E]">
            <Download className="h-4 w-4 mr-1" /> Export Reconciliation
          </Button>
          <Button onClick={() => setShowForm(true)} className="bg-[#C8102E] hover:bg-[#a00d24] text-white text-sm">
            <PlusCircle className="h-4 w-4 mr-1" /> Record Payment Received
          </Button>
        </div>
      </div>

      {isLowBalance && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">Low Fund Balance Alert</p>
            <p className="text-xs text-red-600">Available balance is below the configured threshold. Please arrange for fund top-up to avoid payout delays.</p>
          </div>
        </div>
      )}

      {/* Ledger Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Opening Balance', value: ledger?.openingBalance ?? 0, icon: null, color: 'text-gray-700' },
          { label: 'Funds Received', value: ledger?.fundsReceived ?? 0, icon: <TrendingUp className="h-4 w-4 text-green-600" />, color: 'text-green-700' },
          { label: 'Funds Utilised', value: (ledger?.utilisedGiftCard ?? 0) + (ledger?.utilisedUpi ?? 0) + (ledger?.utilisedBankTransfer ?? 0) + (ledger?.utilisedPhysicalGift ?? 0), icon: <TrendingDown className="h-4 w-4 text-red-600" />, color: 'text-red-700' },
          { label: 'Closing Balance', value: ledger?.closingBalance ?? 0, icon: null, color: 'text-gray-700' },
        ].map(item => (
          <Card key={item.label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-500">{item.label}</p>
                {item.icon}
              </div>
              <p className={`text-lg font-bold ${item.color}`}>{fmt(item.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="p-4">
            <p className="text-xs text-orange-700 font-medium">Pending Liability</p>
            <p className="text-xl font-bold text-orange-800 mt-1">{fmt(ledger?.pendingLiability ?? 0)}</p>
            <p className="text-xs text-orange-600 mt-1">Approved but not yet disbursed</p>
          </CardContent>
        </Card>
        <Card className={isLowBalance ? 'border-red-300 bg-red-50' : 'border-green-200 bg-green-50'}>
          <CardContent className="p-4">
            <p className={`text-xs font-medium ${isLowBalance ? 'text-red-700' : 'text-green-700'}`}>Available Balance</p>
            <p className={`text-xl font-bold mt-1 ${isLowBalance ? 'text-red-800' : 'text-green-800'}`}>{fmt(ledger?.availableBalance ?? 0)}</p>
            <p className={`text-xs mt-1 ${isLowBalance ? 'text-red-600' : 'text-green-600'}`}>Closing Balance − Pending Liability</p>
          </CardContent>
        </Card>
      </div>

      {/* Utilisation Breakdown */}
      <Card>
        <CardHeader><CardTitle className="text-base">Utilisation by Payout Mode</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-gray-100">
                <th className="pb-2 text-xs text-gray-500 font-medium">Mode</th>
                <th className="pb-2 text-xs text-gray-500 font-medium">Code</th>
                <th className="pb-2 text-xs text-gray-500 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[
                { mode: 'Amazon / Gift Card Redemptions', code: 'PM-01', value: ledger?.utilisedGiftCard ?? 0 },
                { mode: 'Direct Bank Transfer (UPI)', code: 'PM-02', value: ledger?.utilisedUpi ?? 0 },
                { mode: 'Direct Bank Transfer (NEFT/IMPS)', code: 'PM-03', value: ledger?.utilisedBankTransfer ?? 0 },
                { mode: 'Physical Gift Fulfillment', code: 'PM-04', value: ledger?.utilisedPhysicalGift ?? 0 },
              ].map(row => (
                <tr key={row.code}>
                  <td className="py-3 text-gray-700">{row.mode}</td>
                  <td className="py-3"><span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">{row.code}</span></td>
                  <td className="py-3 text-right font-medium">{fmt(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Record Payment Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-lg font-bold text-[#1A1A2E]">Record Payment Received from Deoleo</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">Amount (₹)</label>
                <input type="number" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]" placeholder="0.00" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">UTR / Reference Number</label>
                <input value={form.referenceNumber} onChange={e => setForm(p => ({ ...p, referenceNumber: e.target.value }))} className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]" placeholder="UTR123456789" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">Payment Date</label>
                <input type="date" value={form.paymentDate} onChange={e => setForm(p => ({ ...p, paymentDate: e.target.value }))} className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">Remarks</label>
                <textarea value={form.remarks} onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))} rows={2} className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]" placeholder="Optional notes" />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowForm(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleRecordPayment} disabled={submitting || !form.amount || !form.referenceNumber || !form.paymentDate} className="flex-1 bg-[#C8102E] hover:bg-[#a00d24] text-white">
                {submitting ? 'Saving...' : 'Record Payment'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
