'use client'

import { useState, useEffect } from 'react'
import { Save, RefreshCw, Plus, Trash2, ListTodo, Layers, TrendingUp, Eye, Tags, X, Smartphone, Clock, Coins, Lock } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { fetchTaskConfig, updateTaskConfig, DEFAULT_TASK_CONFIG, type TaskConfig, type CustomTaskItem } from '@/lib/task-config'
import { getGifsySettings, saveGifsySettings } from '@/lib/gifsy-settings'
import { fetchPointsExpiry, savePointsExpiry } from '@/lib/points-expiry'
import {
  fetchVisibilityCaptureMode,
  saveVisibilityCaptureMode,
  type VisibilityCaptureMode,
} from '@/lib/visibility-capture-mode'
import { useAdminSession } from '@/lib/admin-session'

interface Settings {
  holdingPeriodDays: number
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

/**
 * Read-only platform-global security config (#101). These come from GET
 * /api/admin/settings, sourced backend-side from the enforced auth constants + env —
 * they are DISPLAY-ONLY here (managed via deployment/env, never edited in this panel).
 */
interface SecurityConfig {
  jwtAccessTtl?: string
  refreshTtlDays?: number
  assumedSessionTtlHours?: number
  otpExpiryMinutes?: number
  maxOtpAttempts?: number
  otpResendWindowHours?: number
  otpMaxResendsPerWindow?: number
}

function SettingRow({ label, description, value, onChange, type = 'number', min, max, step, disabled = false, testId }: {
  label: string, description: string, value: number | string, onChange: (v: string) => void,
  type?: string, min?: number, max?: number, step?: number, disabled?: boolean, testId?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-gray-100 last:border-0">
      <div className="flex-1">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <input data-testid={testId} type={type} value={value} onChange={e => onChange(e.target.value)}
        min={min} max={max} step={step} disabled={disabled}
        className="w-28 text-sm border border-gray-200 rounded px-2 py-1.5 text-right focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed" />
    </div>
  )
}

export default function SettingsPage() {
  // ── Role gate — visibility capture mode toggle is GIFSY_ADMIN-only ──
  const adminSession = useAdminSession()
  const isGifsyAdmin = adminSession.role === 'GIFSY_ADMIN'

  // ── Read-only Security & Platform Config (#101; GIFSY_ADMIN only) ──
  // Sourced from GET /api/admin/settings (backend reads the enforced auth constants +
  // env). Display-only — no editing here. Only fetched for a Gifsy Admin.
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig | null>(null)
  useEffect(() => {
    if (!isGifsyAdmin) return
    fetch('/api/admin/settings')
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { settings?: SecurityConfig } }) => {
        if (json?.success && json.data?.settings) setSecurityConfig(json.data.settings)
      })
      .catch(() => { /* non-fatal — the card simply won't render */ })
  }, [isGifsyAdmin])

  const [settings, setSettings] = useState<Settings>({
    holdingPeriodDays: 30, otpValidityHours: 6, kycSlaHours: 48,
    visibilityGeoRadiusMeters: 50, visibilityLookbackDays: 30, visibilityHashSimilarityThreshold: 90,
    visibilityExifWindowHours: 24, lowBalanceAlertThreshold: 100000,
    tds194rRate: 10, tds194rThreshold: 20000, tds194cRateIndividual: 1,
    tds194cRateCompany: 2, tdsPanNotFurnishedRate: 20,
  })
  const [tiers, setTiers] = useState<TierConfig[]>([
    { id: '1', partnerClass: 'CP_01', tierLevel: 1, tierName: 'Silver',  description: 'Base tier',        upgradeThreshold: 0       },
    { id: '2', partnerClass: 'CP_01', tierLevel: 2, tierName: 'Gold',    description: 'Mid tier',         upgradeThreshold: 500000  },
    { id: '3', partnerClass: 'CP_01', tierLevel: 3, tierName: 'Platinum',description: 'Top tier',         upgradeThreshold: 1500000 },
    { id: '4', partnerClass: 'CP_02', tierLevel: 1, tierName: 'Bronze',  description: 'Base wholesaler',  upgradeThreshold: 0       },
    { id: '5', partnerClass: 'CP_02', tierLevel: 2, tierName: 'Gold',    description: 'Top wholesaler',   upgradeThreshold: 2000000 },
    { id: '6', partnerClass: 'CP_03', tierLevel: 1, tierName: 'Tier 1',  description: 'Base sub-stockist',upgradeThreshold: 0       },
  ])
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  // ── Pace threshold (per-client, saved via GifsySettings) ──
  // saveGifsySettings PUTs to /v1/admin/settings, which is GIFSY_ADMIN-only — so the field is
  // editable/savable only for GIFSY_ADMIN. For CLIENT_ADMIN/MIS_USER it is read-only (the save
  // would 403); we surface the current value but disable the input + save.
  const [paceThreshold,      setPaceThreshold]      = useState<number>(() => getGifsySettings().paceAmberThreshold ?? 10)
  const [paceThresholdSaved, setPaceThresholdSaved] = useState(false)
  const [paceThresholdError, setPaceThresholdError] = useState<string | null>(null)

  // Keep the displayed value in sync once server settings hydrate (/me → cache).
  useEffect(() => {
    setPaceThreshold(getGifsySettings().paceAmberThreshold ?? 10)
  }, [])

  async function savePaceThreshold() {
    setPaceThresholdError(null)
    const ok = await saveGifsySettings({ paceAmberThreshold: paceThreshold })
    if (!ok) {
      setPaceThresholdError('Could not save — pace threshold can only be changed by a Gifsy Admin.')
      return
    }
    setPaceThresholdSaved(true)
    setTimeout(() => setPaceThresholdSaved(false), 3000)
  }

  // ── Points expiry (per-tenant default; PointExpiryConfig single source of truth) ──
  // The WRITE (PUT /api/admin/settings/points-expiry) is GIFSY_ADMIN-only, so the input +
  // save are editable only for GIFSY_ADMIN. CLIENT_ADMIN/MIS_USER may VIEW the current value
  // (the GET is tenancy:read) but the control is disabled and the save is hidden for them.
  // Blank input = null = never expire. The field holds a STRING so blank ≠ 0.
  const [pointsExpiry,        setPointsExpiry]        = useState<string>('')
  const [pointsExpiryLoaded,  setPointsExpiryLoaded]  = useState(false)
  const [pointsExpirySaved,   setPointsExpirySaved]   = useState(false)
  const [pointsExpiryError,   setPointsExpiryError]   = useState<string | null>(null)

  useEffect(() => {
    fetchPointsExpiry()
      .then(({ pointsExpiryDays }) => setPointsExpiry(pointsExpiryDays == null ? '' : String(pointsExpiryDays)))
      .finally(() => setPointsExpiryLoaded(true))
  }, [])

  async function handlePointsExpirySave() {
    setPointsExpiryError(null)
    const trimmed = pointsExpiry.trim()
    // Blank → never expire (null). Otherwise require a positive integer.
    let value: number | null
    if (trimmed === '') {
      value = null
    } else {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 1) {
        setPointsExpiryError('Enter a whole number of days ≥ 1, or leave blank for never.')
        return
      }
      value = n
    }
    const ok = await savePointsExpiry(value)
    if (!ok) {
      setPointsExpiryError('Could not save — points expiry can only be changed by a Gifsy Admin.')
      return
    }
    setPointsExpirySaved(true)
    setTimeout(() => setPointsExpirySaved(false), 3000)
  }

  // ── Conversion rate (per-tenant; Points→₹). saveGifsySettings PUTs /v1/admin/settings
  // (GIFSY_ADMIN-only), so editable only for GIFSY_ADMIN. Held as a STRING so decimal typing
  // works; parsed + validated on save. The backend read-layer floor is MIN_RATE = 0.005 — a
  // value below that is silently ignored server-side, so the UI blocks it. ──
  const [conversionRate,      setConversionRate]      = useState<string>(() => String(getGifsySettings().pointsConversionRate ?? 1))
  const [conversionRateSaved, setConversionRateSaved] = useState(false)
  const [conversionRateError, setConversionRateError] = useState<string | null>(null)

  // Keep the displayed value in sync once server settings hydrate (/me → cache).
  useEffect(() => {
    setConversionRate(String(getGifsySettings().pointsConversionRate ?? 1))
  }, [])

  async function handleConversionRateSave() {
    setConversionRateError(null)
    const raw = Number(conversionRate.trim())
    // Floor: reject anything below MIN_RATE (0.005) — the backend read-layer silently ignores
    // a smaller rate and keeps the default, which would make a "save" look successful yet do
    // nothing. Ceiling: reject absurd values (fat-finger / pasted phone number).
    if (!Number.isFinite(raw) || raw < 0.005 || raw > 100000) {
      setConversionRateError('Enter a conversion rate between 0.005 and 100000 (e.g. 1 means 1 point = ₹1).')
      return
    }
    // Snap to the centi grid the money path actually enforces (it snapshots the rate as
    // Math.round(rate*100) centi-units). Persisting + displaying the snapped value keeps the
    // shown rate identical to the rate redemptions will use — no silent display/enforce drift.
    const n = Math.round(raw * 100) / 100
    setConversionRate(String(n))
    const ok = await saveGifsySettings({ pointsConversionRate: n })
    if (!ok) {
      setConversionRateError('Could not save — the conversion rate can only be changed by a Gifsy Admin.')
      return
    }
    setConversionRateSaved(true)
    setTimeout(() => setConversionRateSaved(false), 3000)
  }

  // ── Visibility module master switch (per-tenant; saved via GifsySettings) ──
  // Like the pace threshold, saveGifsySettings PUTs to /v1/admin/settings (GIFSY_ADMIN-only),
  // so the control is editable only for GIFSY_ADMIN. Default OFF — treat missing as OFF.
  const [visibilityEnabled,      setVisibilityEnabled]      = useState<boolean>(() => getGifsySettings().visibilityEnabled === true)
  const [visibilityEnabledSaved, setVisibilityEnabledSaved] = useState(false)
  const [visibilityEnabledError, setVisibilityEnabledError] = useState<string | null>(null)

  // Keep the displayed value in sync once server settings hydrate (/me → cache).
  useEffect(() => {
    setVisibilityEnabled(getGifsySettings().visibilityEnabled === true)
  }, [])

  async function handleVisibilityEnabledChange(next: boolean) {
    setVisibilityEnabledError(null)
    const previous = visibilityEnabled
    setVisibilityEnabled(next) // optimistic
    const ok = await saveGifsySettings({ visibilityEnabled: next })
    if (!ok) {
      setVisibilityEnabled(previous) // revert
      setVisibilityEnabledError('Could not save — the Visibility module can only be changed by a Gifsy Admin.')
      return
    }
    setVisibilityEnabledSaved(true)
    setTimeout(() => setVisibilityEnabledSaved(false), 3000)
  }

  // ── UPI collection toggle (per-tenant; saved via GifsySettings) ──
  // Like the visibility switch, saveGifsySettings PUTs to /v1/admin/settings (GIFSY_ADMIN-only),
  // so the control is editable only for GIFSY_ADMIN. Default OFF — treat missing as OFF.
  // salesApp is a REPLACE-WHOLE nested key, so we MUST send the COMPLETE salesApp object.
  const [upiEnabled,      setUpiEnabled]      = useState<boolean>(() => getGifsySettings().salesApp?.upiEnabled === true)
  const [upiEnabledSaved, setUpiEnabledSaved] = useState(false)
  const [upiEnabledError, setUpiEnabledError] = useState<string | null>(null)

  // Keep the displayed value in sync once server settings hydrate (/me → cache).
  useEffect(() => {
    setUpiEnabled(getGifsySettings().salesApp?.upiEnabled === true)
  }, [])

  async function handleUpiEnabledChange(next: boolean) {
    setUpiEnabledError(null)
    const previous = upiEnabled
    setUpiEnabled(next) // optimistic
    const ok = await saveGifsySettings({
      salesApp: { ...getGifsySettings().salesApp, upiEnabled: next },
    })
    if (!ok) {
      setUpiEnabled(previous) // revert
      setUpiEnabledError('Could not save — UPI collection can only be changed by a Gifsy Admin.')
      return
    }
    setUpiEnabledSaved(true)
    setTimeout(() => setUpiEnabledSaved(false), 3000)
  }

  // ── Outlet Programs & Categories allow-lists (per-tenant; saved via GifsySettings) ──
  // Like the pace threshold / visibility switch, saveGifsySettings PUTs to /v1/admin/settings
  // (GIFSY_ADMIN-only), so editing is enabled only for GIFSY_ADMIN. Saved as whole arrays
  // (REPLACE-WHOLE). The backend default-guards an empty list, but we also block an empty save
  // in the UI so a tenant never accidentally clears the allowed values.
  const DEFAULT_OUTLET_PROGRAMS   = ['Trade Loyalty', 'Gold Programme']
  const DEFAULT_OUTLET_CATEGORIES = ['Premium', 'Standard', 'Economy']

  const [outletPrograms,   setOutletPrograms]   = useState<string[]>(
    () => getGifsySettings().outletPrograms   ?? DEFAULT_OUTLET_PROGRAMS,
  )
  const [outletCategories, setOutletCategories] = useState<string[]>(
    () => getGifsySettings().outletCategories ?? DEFAULT_OUTLET_CATEGORIES,
  )
  const [newProgram,         setNewProgram]         = useState('')
  const [newCategory,        setNewCategory]        = useState('')
  const [outletListsSaved,   setOutletListsSaved]   = useState(false)
  const [outletListsError,   setOutletListsError]   = useState<string | null>(null)

  // Keep the displayed lists in sync once server settings hydrate (/me → cache).
  useEffect(() => {
    const s = getGifsySettings()
    setOutletPrograms(s.outletPrograms     ?? DEFAULT_OUTLET_PROGRAMS)
    setOutletCategories(s.outletCategories ?? DEFAULT_OUTLET_CATEGORIES)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function flashOutletListsSaved() {
    setOutletListsSaved(true)
    setTimeout(() => setOutletListsSaved(false), 3000)
  }

  // Persist a whole list to the server with optimistic update + revert-on-failure.
  async function persistOutletList(
    which: 'programs' | 'categories',
    next: string[],
    prev: string[],
  ) {
    setOutletListsError(null)
    if (which === 'programs') setOutletPrograms(next); else setOutletCategories(next) // optimistic
    const ok = which === 'programs'
      ? await saveGifsySettings({ outletPrograms: next })
      : await saveGifsySettings({ outletCategories: next })
    if (!ok) {
      if (which === 'programs') setOutletPrograms(prev); else setOutletCategories(prev) // revert
      setOutletListsError('Could not save — these lists can only be changed by a Gifsy Admin.')
      return
    }
    flashOutletListsSaved()
  }

  function addProgram() {
    const t = newProgram.trim()
    if (!t || outletPrograms.includes(t)) return
    setNewProgram('')
    void persistOutletList('programs', [...outletPrograms, t], outletPrograms)
  }
  function removeProgram(value: string) {
    if (outletPrograms.length <= 1) {
      setOutletListsError('At least one program must remain.')
      return
    }
    void persistOutletList('programs', outletPrograms.filter((p) => p !== value), outletPrograms)
  }
  function addCategory() {
    const t = newCategory.trim()
    if (!t || outletCategories.includes(t)) return
    setNewCategory('')
    void persistOutletList('categories', [...outletCategories, t], outletCategories)
  }
  function removeCategory(value: string) {
    if (outletCategories.length <= 1) {
      setOutletListsError('At least one category must remain.')
      return
    }
    void persistOutletList('categories', outletCategories.filter((c) => c !== value), outletCategories)
  }

  // ── Visibility capture mode (GIFSY_ADMIN-only) ──
  const [captureMode,      setCaptureMode]      = useState<VisibilityCaptureMode>('PHOTO_APPROVAL')
  const [captureModeLoading, setCaptureModeLoading] = useState(false)
  const [captureModeError,   setCaptureModeError]   = useState<string | null>(null)
  const [captureModeSaved,   setCaptureModeSaved]   = useState(false)

  useEffect(() => {
    if (!isGifsyAdmin) return
    fetchVisibilityCaptureMode().then(setCaptureMode)
  }, [isGifsyAdmin])

  async function handleCaptureModeChange(newMode: VisibilityCaptureMode) {
    // Optimistic update
    setCaptureMode(newMode)
    setCaptureModeError(null)
    setCaptureModeLoading(true)
    try {
      await saveVisibilityCaptureMode(newMode)
      setCaptureModeSaved(true)
      setTimeout(() => setCaptureModeSaved(false), 3000)
    } catch (err) {
      setCaptureModeError(err instanceof Error ? err.message : 'Failed to save')
      // Revert optimistic update on failure
      const previous = newMode === 'PHOTO_APPROVAL' ? 'AMOUNT_UPLOAD' : 'PHOTO_APPROVAL'
      setCaptureMode(previous)
    } finally {
      setCaptureModeLoading(false)
    }
  }

  // ── Task configuration ──
  const [taskConfig,    setTaskConfig]    = useState<TaskConfig | null>(null)
  const [taskSaved,     setTaskSaved]     = useState(false)
  const [newCustomTask, setNewCustomTask] = useState<{
    title: string; subtitle: string; priority: 'high' | 'medium' | 'low'; startsAt: string; endsAt: string
  }>({ title: '', subtitle: '', priority: 'medium', startsAt: '', endsAt: '' })

  useEffect(() => { fetchTaskConfig().then(setTaskConfig) }, [])

  function flashSaved() {
    setTaskSaved(true)
    setTimeout(() => setTaskSaved(false), 2000)
  }

  async function addCustomTask() {
    if (!newCustomTask.title.trim() || !taskConfig) return
    const item: CustomTaskItem = {
      id: `c-${Date.now()}`,
      title:    newCustomTask.title,
      subtitle: newCustomTask.subtitle,
      priority: newCustomTask.priority,
      ...(newCustomTask.startsAt ? { startsAt: newCustomTask.startsAt } : {}),
      ...(newCustomTask.endsAt   ? { endsAt:   newCustomTask.endsAt   } : {}),
    }
    const updated = { ...taskConfig, customTaskItems: [...taskConfig.customTaskItems, item] }
    setTaskConfig(updated)
    setNewCustomTask({ title: '', subtitle: '', priority: 'medium', startsAt: '', endsAt: '' })
    await updateTaskConfig(updated)
    flashSaved()
  }

  async function removeCustomTask(id: string) {
    if (!taskConfig) return
    const updated = { ...taskConfig, customTaskItems: taskConfig.customTaskItems.filter((t) => t.id !== id) }
    setTaskConfig(updated)
    await updateTaskConfig(updated)
    flashSaved()
  }

  const set = (key: keyof Settings) => (val: string) =>
    setSettings(prev => ({ ...prev, [key]: parseFloat(val) || 0 }))

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const classLabels: Record<string, string> = { CP_01: 'SSS', CP_02: 'Wholesaler', CP_03: 'Sub-stockist' }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Platform Settings</h1>
          <p className="text-sm text-gray-500 mt-1">All configuration changes take effect immediately</p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white">
          {saving ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Saving...</> : saved ? '✓ Saved' : <><Save className="h-4 w-4 mr-2" />Save Changes</>}
        </Button>
      </div>

      {/* Program Settings */}
      <Card>
        <CardHeader><CardTitle className="text-base">Program Settings</CardTitle><CardDescription>Core loyalty program configuration</CardDescription></CardHeader>
        <CardContent>
          <SettingRow label="Points Holding Period (days)" description="Days before locked points become redeemable. Applies as default; can be overridden per scheme." value={settings.holdingPeriodDays} onChange={set('holdingPeriodDays')} min={0} max={365} />
          <SettingRow label="OTP Validity (hours)" description="How long an OTP remains valid after being sent." value={settings.otpValidityHours} onChange={set('otpValidityHours')} min={1} max={24} />
        </CardContent>
      </Card>

      {/* ── Security & Platform Config (read-only; GIFSY_ADMIN only) ── */}
      {isGifsyAdmin && securityConfig && (
        <Card data-testid="security-config-card">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4 text-[var(--brand-primary)]" /> Security &amp; Platform Config
            </CardTitle>
            <CardDescription className="mt-1">
              Platform-global security parameters enforced by the backend. These are
              managed via deployment/env and are <strong>not editable here</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-gray-100">
              {[
                { label: 'Access token lifetime',        value: securityConfig.jwtAccessTtl,                            testId: 'sec-jwt-ttl' },
                { label: 'Refresh token lifetime (days)', value: securityConfig.refreshTtlDays,                          testId: 'sec-refresh-ttl' },
                { label: 'Assumed session lifetime (hours)', value: securityConfig.assumedSessionTtlHours,               testId: 'sec-assumed-ttl' },
                { label: 'OTP validity (minutes)',       value: securityConfig.otpExpiryMinutes,                        testId: 'sec-otp-expiry' },
                { label: 'Max OTP attempts',             value: securityConfig.maxOtpAttempts,                          testId: 'sec-otp-attempts' },
                { label: 'OTP resend window (hours)',    value: securityConfig.otpResendWindowHours,                    testId: 'sec-otp-window' },
                { label: 'Max OTP resends per window',   value: securityConfig.otpMaxResendsPerWindow,                  testId: 'sec-otp-max-resends' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 py-3">
                  <span className="text-sm text-gray-600">{row.label}</span>
                  <span
                    data-testid={row.testId}
                    className="text-sm font-mono font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1"
                  >
                    {row.value ?? '—'}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-3">
              Platform-global — managed via deployment/env, not editable here.
            </p>
          </CardContent>
        </Card>
      )}

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

      {/* ── Visibility Module master switch (per-tenant) ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="h-4 w-4 text-[var(--brand-primary)]" /> Visibility Module
              </CardTitle>
              <CardDescription className="mt-1">
                Master on/off switch for the Visibility module for this tenant. When OFF, all
                visibility capture/approval/upload surfaces are hidden and the API rejects
                visibility actions for this tenant. This is a Gifsy-operated setting — only a
                Gifsy Admin can change it.
              </CardDescription>
            </div>
            {visibilityEnabledSaved && (
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0">
                ✓ Saved
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            {/* Segmented ON/OFF control */}
            <div className="flex bg-gray-100 rounded-lg p-1 gap-1" role="radiogroup" aria-label="Visibility module">
              {([['OFF', false], ['ON', true]] as const).map(([label, val]) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={visibilityEnabled === val}
                  disabled={!isGifsyAdmin}
                  onClick={() => visibilityEnabled !== val && handleVisibilityEnabledChange(val)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    visibilityEnabled === val
                      ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-2">
              The Visibility module is a Gifsy-operated setting — only a Gifsy Admin can change it.
            </p>
          )}
          {visibilityEnabledError && (
            <p className="text-xs text-red-600 mt-2">{visibilityEnabledError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Visibility Capture Mode (GIFSY_ADMIN only) ── */}
      {isGifsyAdmin && (
        <Card className={visibilityEnabled ? undefined : 'opacity-50 pointer-events-none'}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye className="h-4 w-4 text-[var(--brand-primary)]" /> Visibility Capture Mode
                </CardTitle>
                <CardDescription className="mt-1">
                  Controls how visibility data is captured for this tenant.
                  <strong> Photo Approval</strong> — field agents submit photos via the mobile app;
                  Gifsy admin approves/rejects each submission.
                  <strong> Amount Upload</strong> — Gifsy/Client admin bulk-uploads visibility amounts
                  via Excel; no photo-capture workflow.
                  This is a Gifsy-operated setting — only Gifsy Admin can change it.
                </CardDescription>
              </div>
              {captureModeSaved && (
                <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0">
                  ✓ Saved
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              {/* Segmented control */}
              <div className="flex bg-gray-100 rounded-lg p-1 gap-1" role="radiogroup" aria-label="Visibility capture mode">
                {(['PHOTO_APPROVAL', 'AMOUNT_UPLOAD'] as const).map((mode) => (
                  <button
                    key={mode}
                    role="radio"
                    aria-checked={captureMode === mode}
                    disabled={captureModeLoading}
                    onClick={() => captureMode !== mode && handleCaptureModeChange(mode)}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-all disabled:opacity-60 ${
                      captureMode === mode
                        ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {mode === 'PHOTO_APPROVAL' ? 'Photo Approval' : 'Amount Upload'}
                  </button>
                ))}
              </div>
              {captureModeLoading && (
                <RefreshCw className="h-4 w-4 animate-spin text-gray-400" aria-label="Saving" />
              )}
            </div>
            {captureMode === 'PHOTO_APPROVAL' && (
              <p className="text-xs text-gray-500 mt-2">
                Active: field agents submit photos via the mobile app. Gifsy admin reviews and
                approves/rejects each submission in the Visibility Approval queue.
              </p>
            )}
            {captureMode === 'AMOUNT_UPLOAD' && (
              <p className="text-xs text-gray-500 mt-2">
                Active: no photo capture. Gifsy/Client admin uploads visibility amounts in bulk
                via the Excel upload on the Visibility page.
              </p>
            )}
            {captureModeError && (
              <p className="text-xs text-red-600 mt-2">{captureModeError}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── UPI Collection (KYC form) — per-tenant ── */}
      <Card data-testid="upi-collection-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-[var(--brand-primary)]" /> UPI Collection (KYC form)
              </CardTitle>
              <CardDescription className="mt-1">
                When ON, the sales KYC form offers UPI as a payout option. When OFF (default),
                only bank transfer is collected. This is a Gifsy-operated setting — only a
                Gifsy Admin can change it.
              </CardDescription>
            </div>
            {upiEnabledSaved && (
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0">
                ✓ Saved
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            {/* Segmented ON/OFF control */}
            <div className="flex bg-gray-100 rounded-lg p-1 gap-1" role="radiogroup" aria-label="UPI collection">
              {([['OFF', false], ['ON', true]] as const).map(([label, val]) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={upiEnabled === val}
                  disabled={!isGifsyAdmin}
                  onClick={() => upiEnabled !== val && handleUpiEnabledChange(val)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    upiEnabled === val
                      ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-2">
              UPI collection is a Gifsy-operated setting — only a Gifsy Admin can change it.
            </p>
          )}
          {upiEnabledError && (
            <p className="text-xs text-red-600 mt-2">{upiEnabledError}</p>
          )}
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

      {/* ── Pace Colour Threshold ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" /> Performance Pace Threshold
              </CardTitle>
              <CardDescription className="mt-1">
                Controls the amber ↔ red boundary on pace badges across the dashboard, outlet, team, and target views.
                Amber fires when the achievement gap is within this % of time elapsed (lower = more stringent).
                Example at 40% elapsed with threshold 10: amber only if achievement ≥ 36%.
                This setting is per-client — different clients can have different thresholds.
              </CardDescription>
            </div>
            {isGifsyAdmin && (
              <button
                onClick={savePaceThreshold}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  paceThresholdSaved
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]'
                }`}
              >
                {paceThresholdSaved ? '✓ Saved' : <><Save className="h-3.5 w-3.5" /> Save</>}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Amber Pace Threshold (%)"
            description="% of time elapsed within which the gap must fall to show amber. Set lower for a tighter standard (e.g. 5 = very strict, 15 = lenient). Default: 10."
            value={paceThreshold}
            onChange={(v) => setPaceThreshold(parseFloat(v) || 10)}
            min={1}
            max={30}
            step={1}
            disabled={!isGifsyAdmin}
          />
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-2">
              The pace threshold is a Gifsy-operated setting — only a Gifsy Admin can change it.
            </p>
          )}
          {paceThresholdError && (
            <p className="text-xs text-red-600 mt-2">{paceThresholdError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Points Expiry (per-tenant default) ── */}
      <Card data-testid="points-expiry-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-[var(--brand-primary)]" /> Points Expiry
              </CardTitle>
              <CardDescription className="mt-1">
                Number of days after which earned points expire for this tenant. Leave blank for
                <strong> never expire</strong>. Applies as the tenant-wide default (scheme-specific
                overrides are managed per scheme). This is a Gifsy-operated setting — only a Gifsy
                Admin can change it.
              </CardDescription>
            </div>
            {isGifsyAdmin && (
              <button
                data-testid="points-expiry-save"
                onClick={handlePointsExpirySave}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 ${
                  pointsExpirySaved
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]'
                }`}
              >
                {pointsExpirySaved ? '✓ Saved' : <><Save className="h-3.5 w-3.5" /> Save</>}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Points expiry (days, blank = never)"
            description="Whole number of days from when points are earned until they expire. Leave blank so points never expire."
            type="number"
            value={pointsExpiry}
            onChange={(v) => setPointsExpiry(v)}
            min={1}
            disabled={!isGifsyAdmin || !pointsExpiryLoaded}
            testId="points-expiry-input"
          />
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-2">
              Points expiry is a Gifsy-operated setting — only a Gifsy Admin can change it.
            </p>
          )}
          {pointsExpiryError && (
            <p className="text-xs text-red-600 mt-2">{pointsExpiryError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Points → ₹ Conversion Rate (per-tenant) ── */}
      <Card data-testid="conversion-rate-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Coins className="h-4 w-4 text-[var(--brand-primary)]" /> Points → ₹ Conversion Rate
              </CardTitle>
              <CardDescription className="mt-1">
                Value of one point in rupees for cash redemptions. <strong>1 = 1 point → ₹1.</strong>{' '}
                A higher rate means points are worth less (e.g. 2 → 500 points = ₹250). This is a
                Gifsy-operated setting — only a Gifsy Admin can change it. Changes apply to NEW
                redemptions; orders already placed keep the rate frozen at order time.
              </CardDescription>
            </div>
            {isGifsyAdmin && (
              <button
                data-testid="conversion-rate-save"
                onClick={handleConversionRateSave}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 ${
                  conversionRateSaved
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]'
                }`}
              >
                {conversionRateSaved ? '✓ Saved' : <><Save className="h-3.5 w-3.5" /> Save</>}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Conversion rate (points per ₹1)"
            description="Number of points that equal ₹1 on redemption. Minimum 0.005. Example: 1 = 1 point → ₹1; 2 = 2 points → ₹1 (points worth half as much)."
            type="number"
            value={conversionRate}
            onChange={(v) => setConversionRate(v)}
            min={0.005}
            max={100000}
            step={0.005}
            disabled={!isGifsyAdmin}
            testId="conversion-rate-input"
          />
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-2">
              The conversion rate is a Gifsy-operated setting — only a Gifsy Admin can change it.
            </p>
          )}
          {conversionRateError && (
            <p className="text-xs text-red-600 mt-2">{conversionRateError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Outlet Programs & Categories (per-tenant allow-lists) ── */}
      <Card data-testid="outlet-programs-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Tags className="h-4 w-4 text-[var(--brand-primary)]" /> Outlet Programs &amp; Categories
              </CardTitle>
              <CardDescription className="mt-1">
                These lists control the allowed Program Name / Program Category values in the
                Outlet Master upload for this tenant. This is a Gifsy-operated setting — only a
                Gifsy Admin can change it.
              </CardDescription>
            </div>
            {outletListsSaved && (
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0">
                ✓ Saved
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 md:grid-cols-2">
            {/* Programs */}
            <div data-testid="outlet-programs-section">
              <p className="text-sm font-semibold text-gray-800 mb-2">Program Names</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {outletPrograms.length === 0 ? (
                  <span className="text-xs text-gray-400 italic">No programs yet — add one below.</span>
                ) : outletPrograms.map((p) => (
                  <span key={p} data-testid="outlet-program-chip"
                    className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium text-gray-700">
                    {p}
                    {isGifsyAdmin && (
                      <button
                        type="button"
                        aria-label={`Remove ${p}`}
                        onClick={() => removeProgram(p)}
                        disabled={outletPrograms.length <= 1}
                        className="text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {isGifsyAdmin && (
                <div className="flex gap-2">
                  <input
                    data-testid="outlet-program-input"
                    value={newProgram}
                    onChange={(e) => setNewProgram(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addProgram() } }}
                    placeholder="Add a program name"
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                  />
                  <button
                    data-testid="outlet-program-add"
                    type="button"
                    onClick={addProgram}
                    disabled={!newProgram.trim() || outletPrograms.includes(newProgram.trim())}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
              )}
            </div>

            {/* Categories */}
            <div data-testid="outlet-categories-section">
              <p className="text-sm font-semibold text-gray-800 mb-2">Program Categories</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {outletCategories.length === 0 ? (
                  <span className="text-xs text-gray-400 italic">No categories yet — add one below.</span>
                ) : outletCategories.map((c) => (
                  <span key={c} data-testid="outlet-category-chip"
                    className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium text-gray-700">
                    {c}
                    {isGifsyAdmin && (
                      <button
                        type="button"
                        aria-label={`Remove ${c}`}
                        onClick={() => removeCategory(c)}
                        disabled={outletCategories.length <= 1}
                        className="text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {isGifsyAdmin && (
                <div className="flex gap-2">
                  <input
                    data-testid="outlet-category-input"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory() } }}
                    placeholder="Add a category"
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                  />
                  <button
                    data-testid="outlet-category-add"
                    type="button"
                    onClick={addCategory}
                    disabled={!newCategory.trim() || outletCategories.includes(newCategory.trim())}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
              )}
            </div>
          </div>
          {!isGifsyAdmin && (
            <p className="text-xs text-gray-400 mt-4">
              The program and category lists are a Gifsy-operated setting — only a Gifsy Admin can change them.
            </p>
          )}
          {outletListsError && (
            <p className="text-xs text-red-600 mt-3">{outletListsError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Sales Task Configuration ── */}
      {taskConfig && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <ListTodo className="h-4 w-4 text-[var(--brand-primary)]" /> Sales Task Configuration
                </CardTitle>
                <CardDescription className="mt-1">
                  Add reminders and announcements for the sales team. Changes save automatically.
                </CardDescription>
              </div>
              {taskSaved && (
                <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg">
                  ✓ Saved
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Layers className="h-4 w-4 text-gray-500" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-800">HO Notifications / Reminders</p>
                  <p className="text-xs text-gray-500">Hidden on the sales dashboard until at least one item is added. Tasks with an end date disappear automatically.</p>
                </div>
              </div>

              {/* Category label */}
              <div className="mb-4 flex items-center gap-3">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide shrink-0">Category Label</label>
                <input
                  value={taskConfig.customTaskLabel}
                  onChange={(e) => setTaskConfig({ ...taskConfig, customTaskLabel: e.target.value })}
                  onBlur={async (e) => { await updateTaskConfig({ ...taskConfig, customTaskLabel: e.target.value }); flashSaved() }}
                  className="w-full max-w-sm text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                  placeholder="e.g. HO Notifications / Reminders"
                />
              </div>

              {/* Existing tasks */}
              {taskConfig.customTaskItems.length > 0 ? (
                <div className="space-y-2 mb-4">
                  {taskConfig.customTaskItems.map((item) => {
                    const now = new Date();
                    const expired  = item.endsAt   && new Date(item.endsAt)   < now;
                    const upcoming = item.startsAt  && new Date(item.startsAt) > now;
                    return (
                      <div key={item.id} className={`flex items-center gap-3 border rounded-lg px-3 py-2.5 ${expired ? 'bg-gray-50 opacity-50' : upcoming ? 'bg-blue-50 border-blue-100' : 'bg-gray-50 border-gray-100'}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{item.title}</p>
                          {item.subtitle && <p className="text-xs text-gray-500 truncate">{item.subtitle}</p>}
                          {(item.startsAt || item.endsAt) && (
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              {item.startsAt && <>From {item.startsAt}</>}
                              {item.startsAt && item.endsAt && ' · '}
                              {item.endsAt && <>Until {item.endsAt}</>}
                              {expired && <span className="ml-1 text-red-400 font-semibold">Expired</span>}
                              {upcoming && <span className="ml-1 text-blue-500 font-semibold">Upcoming</span>}
                            </p>
                          )}
                        </div>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                          item.priority === 'high' ? 'bg-red-100 text-red-600' : item.priority === 'medium' ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-500'
                        }`}>{item.priority}</span>
                        <button onClick={() => removeCustomTask(item.id)} className="text-gray-400 hover:text-red-500 transition-colors shrink-0">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic mb-4">No notifications yet — add one below.</p>
              )}

              {/* Add new task */}
              <div className="border border-dashed border-gray-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Add Notification</p>
                <div className="flex gap-2">
                  <input
                    value={newCustomTask.title}
                    onChange={(e) => setNewCustomTask({ ...newCustomTask, title: e.target.value })}
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    placeholder="Title"
                  />
                  <input
                    value={newCustomTask.subtitle}
                    onChange={(e) => setNewCustomTask({ ...newCustomTask, subtitle: e.target.value })}
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    placeholder="Details / description"
                  />
                  <select
                    value={newCustomTask.priority}
                    onChange={(e) => setNewCustomTask({ ...newCustomTask, priority: e.target.value as 'high' | 'medium' | 'low' })}
                    className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white"
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div className="flex gap-2 items-center">
                  <label className="text-xs text-gray-500 shrink-0">Start date</label>
                  <input
                    type="date"
                    value={newCustomTask.startsAt}
                    onChange={(e) => setNewCustomTask({ ...newCustomTask, startsAt: e.target.value })}
                    className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white"
                  />
                  <label className="text-xs text-gray-500 shrink-0">End date</label>
                  <input
                    type="date"
                    value={newCustomTask.endsAt}
                    onChange={(e) => setNewCustomTask({ ...newCustomTask, endsAt: e.target.value })}
                    className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white"
                  />
                  <span className="text-xs text-gray-400 flex-1">Leave blank for no expiry</span>
                  <button
                    onClick={addCustomTask}
                    disabled={!newCustomTask.title.trim()}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                {tiers.filter(t => t.partnerClass === cls).map((tier) => (
                  <div key={tier.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <span className="text-xs font-medium text-gray-500 w-12">Tier {tier.tierLevel}</span>
                    <input value={tier.tierName} onChange={e => setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, tierName: e.target.value } : t))}
                      className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]" placeholder="Tier name" />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Upgrade at ₹</span>
                      <input type="number" value={tier.upgradeThreshold} onChange={e => setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, upgradeThreshold: parseInt(e.target.value) || 0 } : t))}
                        className="w-24 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]" disabled={tier.tierLevel === 1} />
                    </div>
                    <button onClick={() => setTiers(prev => prev.filter(t => t.id !== tier.id))} className="text-xs text-red-500 hover:text-red-700" disabled={tier.tierLevel === 1}>Remove</button>
                  </div>
                ))}
                <button onClick={() => {
                  const classTiers = tiers.filter(t => t.partnerClass === cls)
                  const nextLevel = classTiers.length + 1
                  setTiers(prev => [...prev, { id: `new-${Date.now()}`, partnerClass: cls, tierLevel: nextLevel, tierName: '', description: '', upgradeThreshold: 0 }])
                }} className="text-xs text-[var(--brand-primary)] hover:underline">+ Add Tier</button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
