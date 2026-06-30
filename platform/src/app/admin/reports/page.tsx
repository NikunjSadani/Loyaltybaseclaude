'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileSpreadsheet, Download, RefreshCw, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface ReportConfig {
  id: string
  name: string
  description: string
  category: 'operational' | 'business' | 'finance' | 'engagement'
  endpoint: string
  filters: string[]
  /** When set, ReportCard shows an "Open report" button that navigates to this path. */
  href?: string
}

const reports: ReportConfig[] = [
  // Operational
  { id: 'outlet-master', name: 'Outlet Master', description: 'Complete outlet dump with KYC status, banking details, account holder name, signature, sales hierarchy, and lifecycle timestamps', category: 'operational', endpoint: '/api/admin/reports/outlet-master', filters: [] },
  { id: 'kyc-status', name: 'KYC Status Report', description: 'All KYC submissions with current status, age, and assigned sales user', category: 'operational', endpoint: '/api/reports/kyc-status', filters: ['dateFrom', 'dateTo', 'status', 'state'] },
  { id: 'visibility-status', name: 'Visibility Status Report', description: 'Visibility submissions with approval status, outlet, and payout eligibility', category: 'operational', endpoint: '/api/reports/visibility-status', filters: ['dateFrom', 'dateTo', 'status', 'programId'] },
  { id: 'ticket-aging', name: 'Ticket Aging Report', description: 'Open tickets aged by priority bucket with SLA breach flags', category: 'operational', endpoint: '/api/admin/reports/ticket-aging', href: '/admin/reports/ticket-aging', filters: [] },
  { id: 'approval-pendency', name: 'Approval Pendency Report', description: 'Pending approvals across KYC and visibility with age in hours', category: 'operational', endpoint: '/api/reports/approval-pendency', filters: ['type', 'state'] },
  // Business
  { id: 'points-ledger', name: 'Outlet Points Ledger', description: 'Per-outlet points movement (opening, monthly earn/burn, expiry, closing) over a selected period — up to 24 months.', category: 'business', endpoint: '/api/admin/reports/points-ledger', href: '/admin/reports/points-ledger', filters: [] },
  { id: 'billing-trends', name: 'Billing Trends Report', description: 'Month-over-month billing by channel partner class, territory, and SKU', category: 'business', endpoint: '/api/reports/billing-trends', filters: ['dateFrom', 'dateTo', 'partnerClass', 'state', 'skuCode'] },
  { id: 'scheme-performance', name: 'Scheme Performance Report', description: 'Target vs achievement per scheme, with payout accrued and eligibility rate', category: 'business', endpoint: '/api/reports/scheme-performance', filters: ['schemeId', 'dateFrom', 'dateTo', 'partnerClass'] },
  { id: 'sku-performance', name: 'SKU Performance Report', description: 'Sales volume and value by SKU across channel partner types', category: 'business', endpoint: '/api/reports/sku-performance', filters: ['dateFrom', 'dateTo', 'category', 'state'] },
  { id: 'outlet-growth', name: 'Outlet Growth Report', description: 'New outlet activations, KYC conversions, and inactive outlet tracking', category: 'business', endpoint: '/api/reports/outlet-growth', filters: ['dateFrom', 'dateTo', 'partnerClass', 'state'] },
  // Finance
  { id: 'payout-liability', name: 'Payout Liability Report', description: 'Approved incentives pending disbursement by partner class and payout mode', category: 'finance', endpoint: '/api/reports/payout-liability', filters: ['period', 'partnerClass', 'payoutMode'] },
  { id: 'tds', name: 'TDS Computation Report', description: 'TDS deducted by PAN, section (194R/194C), and period — structured for quarterly filing', category: 'finance', endpoint: '/api/reports/tds', filters: ['financialYear', 'quarter', 'section'] },
  { id: 'invoices', name: 'Invoice Report', description: 'Auto-generated invoices with TDS details, digital signature status, and download links', category: 'finance', endpoint: '/api/reports/invoices', filters: ['dateFrom', 'dateTo', 'partnerId'] },
  { id: 'reconciliation', name: 'Fund Reconciliation Report', description: 'Opening balance, funds received, utilised by payout mode, closing balance, and variance', category: 'finance', endpoint: '/api/reports/reconciliation', filters: ['period', 'payoutMode'] },
  // Engagement
  { id: 'session-report', name: 'Session Report', description: 'Per-user portal usage: last login plus active-day counts for each of the last 12 months and the current month. "Active" = a day the user actually used the app (not a login).', category: 'engagement', endpoint: '/api/reports/session-report', href: '/admin/reports/session', filters: [] },
]

const categoryLabels = {
  operational: { label: 'Operational', color: 'bg-blue-100 text-blue-800' },
  business: { label: 'Business', color: 'bg-purple-100 text-purple-800' },
  finance: { label: 'Finance', color: 'bg-green-100 text-green-800' },
  engagement: { label: 'Engagement', color: 'bg-orange-100 text-orange-800' },
}

function ReportCard({ report }: { report: ReportConfig }) {
  const [loading, setLoading] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const handleExport = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ format: 'xlsx' })
      if (dateFrom) params.append('dateFrom', dateFrom)
      if (dateTo) params.append('dateTo', dateTo)
      const res = await fetch(`${report.endpoint}?${params}`)
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${report.id}-${new Date().toISOString().split('T')[0]}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Export failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const cat = categoryLabels[report.category]

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-red-50">
              <FileSpreadsheet className="h-4 w-4 text-[var(--brand-primary)]" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">{report.name}</CardTitle>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cat.color}`}>{cat.label}</span>
            </div>
          </div>
        </div>
        <CardDescription className="text-xs mt-2">{report.description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0 flex-1 flex flex-col justify-end gap-2">
        {report.filters.includes('dateFrom') && (
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-2 py-1.5" />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-2 py-1.5" />
            </div>
          </div>
        )}
        {report.href ? (
          <Link href={report.href}>
            <Button size="sm" className="w-full bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white text-xs">
              <ExternalLink className="h-3 w-3 mr-1" />Open report
            </Button>
          </Link>
        ) : (
          <Button onClick={handleExport} disabled={loading} size="sm" className="w-full bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white text-xs">
            {loading ? <><RefreshCw className="h-3 w-3 mr-1 animate-spin" />Generating...</> : <><Download className="h-3 w-3 mr-1" />Export Excel</>}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export default function ReportsPage() {
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const categories = ['all', 'operational', 'business', 'finance', 'engagement']
  const filtered = activeCategory === 'all' ? reports : reports.filter(r => r.category === activeCategory)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Reports</h1>
        <p className="text-sm text-gray-500 mt-1">All reports export in Microsoft Excel (.xlsx) format</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {categories.map(cat => (
          <button key={cat} onClick={() => setActiveCategory(cat)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium capitalize transition-colors ${activeCategory === cat ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {cat === 'all' ? `All (${reports.length})` : `${categoryLabels[cat as keyof typeof categoryLabels]?.label} (${reports.filter((r: ReportConfig) => r.category === cat).length})`}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map(report => <ReportCard key={report.id} report={report} />)}
      </div>
    </div>
  )
}
