'use client'

import { useState, useEffect } from 'react'
import { Save, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Settings {
  holdingPeriodDays: number
  pointsConversionRate: number
  otpValidityHours: number
  kycSlaHours: number
  visibilityGeoRadiusMeters: number
  visibilityLookbackDays: number
  visibilityHashSimilarityThreshold: number
  visibilityExifWindowHours: number
  lowBalanceAlertThreshold: number
  tds194rRate: number
  tds194rThreshold: number
  tds194cRateIndividual: number
  tds194cRateCompany: number
  tdsPanNotFurnishedRate: number
}

interface TierConfig {
  id: string
  partnerClass: string
  tierLevel: number
  tierName: string
  description: string
  upgradeThreshold: number
}

function SettingRow({ label, description, value, onChange, type = 'number', min, max, step }: {
  label: string, description: string, value: number | string, onChange: (v: string) => void,
  type?: string, min?: number, max?: number, step?: number
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-gray-100 last:border-0">
      <div className="flex-1">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        min={min} max={max} step={step}
        className="w-28 text-sm border border-gray-200 rounded px-2 py-1.5 text-right focus:outline-none focus:ring-2 focus:ring-[#C8102E]" />
    </div>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    holdingPeriodDays: 30, pointsConversionRate: 1, otpValidityHours: 6, kycSlaHours: 48,
    visibilityGeoRadiusMeters: 50, visibilityLookbackDays: 30, visibilityHashSimilarityThreshold: 90,
    visibilityExifWindowHours: 24, lowBalanceAlertThreshold: 100000,
    tds194rRate: 10, tds194rThreshold: 20000, tds194cRateIndividual: 1,
    tds194cRateCompany: 2, tdsPanNotFurnishedRate: 20,
  })
  const [tiers, setTiers] = useState<TierConfig[]>([
    { id: '1', partnerClass: 'CP_01', tierLevel: 1, tierName: 'Silver', description: 'Base tier', upgradeThreshold: 0 },
    { id: '2', partnerClass: 'CP_01', tierLevel: 2, tierName: 'Gold', description: 'Mid tier', upgradeThreshold: 500000 },
    { id: '3', partnerClass: 'CP_01', tierLevel: 3, tierName: 'Platinum', description: 'Top tier', upgradeThreshold: 1500000 },
    { id: '4', partnerClass: 'CP_02', tierLevel: 1, tierName: 'Bronze', description: 'Base wholesaler', upgradeThreshold: 0 },
    { id: '5', partnerClass: 'CP_02', tierLevel: 2, tierName: 'Gold', description: 'Top wholesaler', upgradeThreshold: 2000000 },
    { id: '6', partnerClass: 'CP_03', tierLevel: 1, tierName: 'Tier 1', description: 'Base sub-stockist', upgradeThreshold: 0 },
  ])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const set = (key: keyof Settings) => (val: string) =>
    setSettings(prev => ({ ...prev, [key]: parseFloat(val) || 0 }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const token = localStorage.getItem('token')
      await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const classLabels: Record<string, string> = { CP_01: 'Retailer', CP_02: 'Wholesaler', CP_03: 'Sub-stockist' }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Platform Settings</h1>
          <p className="text-sm text-gray-500 mt-1">All configuration changes take effect immediately</p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="bg-[#C8102E] hover:bg-[#a00d24] text-white">
          {saving ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Saving...</> : saved ? '✓ Saved' : <><Save className="h-4 w-4 mr-2" />Save Changes</>}
        </Button>
      </div>

      {/* Program Settings */}
      <Card>
        <CardHeader><CardTitle className="text-base">Program Settings</CardTitle><CardDescription>Core loyalty program configuration</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="Points Holding Period (days)" description="Days before locked points become redeemable. Applies as default; can be overridden per scheme." value={settings.holdingPeriodDays} onChange={set('holdingPeriodDays')} min={0} max={365} />
          <SettingRow label="Points Conversion Rate (₹ per point)" description="Monetary value of 1 loyalty point. Applies per class unless overridden at tier level." value={settings.pointsConversionRate} onChange={set('pointsConversionRate')} step={0.01} min={0.01} />
          <SettingRow label="OTP Validity (hours)" description="How long an OTP remains valid after being sent." value={settings.otpValidityHours} onChange={set('otpValidityHours')} min={1} max={24} />
        </CardContent>
      </Card>

      {/* KYC SLA */}
      <Card>
        <CardHeader><CardTitle className="text-base">KYC SLA Configuration</CardTitle><CardDescription>Turnaround time targets for KYC approvals (Gifsy KPI)</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="KYC SLA Target (working hours)" description="Maximum working hours from KYC submission to approval/rejection. Breaches are flagged in the KPI dashboard." value={settings.kycSlaHours} onChange={set('kycSlaHours')} min={1} max={168} />
        </CardContent>
      </Card>

      {/* Visibility Duplicate Detection */}
      <Card>
        <CardHeader><CardTitle className="text-base">Visibility Duplicate Detection</CardTitle><CardDescription>Thresholds for automated fraud detection on visibility uploads</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="Geo-proximity Radius (metres)" description="Uploads within this radius of an existing approved submission for the same outlet are flagged." value={settings.visibilityGeoRadiusMeters} onChange={set('visibilityGeoRadiusMeters')} min={10} max={500} />
          <SettingRow label="Geo Lookback Window (days)" description="How far back to check for existing submissions in the geo-proximity check." value={settings.visibilityLookbackDays} onChange={set('visibilityLookbackDays')} min={1} max={365} />
          <SettingRow label="Hash Similarity Threshold (%)" description="Perceptual hash similarity above this threshold flags the image as a suspected duplicate." value={settings.visibilityHashSimilarityThreshold} onChange={set('visibilityHashSimilarityThreshold')} min={50} max={100} />
          <SettingRow label="EXIF Timestamp Window (hours)" description="Maximum acceptable difference between EXIF capture time and upload time." value={settings.visibilityExifWindowHours} onChange={set('visibilityExifWindowHours')} min={1} max={72} />
        </CardContent>
      </Card>

      {/* TDS Configuration */}
      <Card>
        <CardHeader><CardTitle className="text-base">TDS Configuration</CardTitle><CardDescription>Rates and thresholds as per TDS Policy document. Changes apply to new payouts only.</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="Section 194R Rate (%)" description="TDS rate on incentives and rewards above the annual threshold." value={settings.tds194rRate} onChange={set('tds194rRate')} min={0} max={30} step={0.1} />
          <SettingRow label="Section 194R Threshold (₹)" description="Annual aggregate above which 194R TDS applies per recipient PAN." value={settings.tds194rThreshold} onChange={set('tds194rThreshold')} min={0} />
          <SettingRow label="Section 194C Rate — Individual (%)" description="TDS on visibility service payments to individuals." value={settings.tds194cRateIndividual} onChange={set('tds194cRateIndividual')} min={0} max={30} step={0.1} />
          <SettingRow label="Section 194C Rate — Company (%)" description="TDS on visibility service payments to companies." value={settings.tds194cRateCompany} onChange={set('tds194cRateCompany')} min={0} max={30} step={0.1} />
          <SettingRow label="PAN Not Furnished Rate (%)" description="Higher TDS rate applied when recipient PAN is unavailable." value={settings.tdsPanNotFurnishedRate} onChange={set('tdsPanNotFurnishedRate')} min={0} max={30} />
        </CardContent>
      </Card>

      {/* Fund Alert */}
      <Card>
        <CardHeader><CardTitle className="text-base">Fund Management</CardTitle><CardDescription>Low balance alert threshold for program fund</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="Low Balance Alert Threshold (₹)" description="Alert is triggered when Available Balance (Closing − Pending Liability) falls below this value." value={settings.lowBalanceAlertThreshold} onChange={set('lowBalanceAlertThreshold')} min={0} />
        </CardContent>
      </Card>

      {/* Tier Management */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tier Management</CardTitle>
          <CardDescription>Configure tiers per channel partner class. Names, counts, and upgrade thresholds are fully configurable.</CardDescription>
        </CardHeader>
        <CardContent>
          {(['CP_01', 'CP_02', 'CP_03'] as const).map(cls => (
            <div key={cls} className="mb-6 last:mb-0">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">{classLabels[cls]}</h3>
              <div className="space-y-2">
                {tiers.filter(t => t.partnerClass === cls).map((tier, idx) => (
                  <div key={tier.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <span className="text-xs font-medium text-gray-500 w-12">Tier {tier.tierLevel}</span>
                    <input value={tier.tierName} onChange={e => setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, tierName: e.target.value } : t))}
                      className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#C8102E]" placeholder="Tier name" />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Upgrade at ₹</span>
                      <input type="number" value={tier.upgradeThreshold} onChange={e => setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, upgradeThreshold: parseInt(e.target.value) || 0 } : t))}
                        className="w-24 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#C8102E]" disabled={tier.tierLevel === 1} />
                    </div>
                    <button onClick={() => setTiers(prev => prev.filter(t => t.id !== tier.id))} className="text-xs text-red-500 hover:text-red-700" disabled={tier.tierLevel === 1}>Remove</button>
                  </div>
                ))}
                <button onClick={() => {
                  const classTiers = tiers.filter(t => t.partnerClass === cls)
                  const nextLevel = classTiers.length + 1
                  setTiers(prev => [...prev, { id: `new-${Date.now()}`, partnerClass: cls, tierLevel: nextLevel, tierName: '', description: '', upgradeThreshold: 0 }])
                }} className="text-xs text-[#C8102E] hover:underline">+ Add Tier</button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
