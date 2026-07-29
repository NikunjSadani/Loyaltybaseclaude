'use client'

/**
 * TDS Treatment — per-tenant TDS-policy config for VISIBILITY-led payouts.
 * Wave 2 Stream D (design §5 portal placement — Gifsy config UI).
 *
 * Round-trips the per-tenant `tdsPolicy` via the backend contract:
 *   GET /api/admin/tds/config[?clientId=]  → { section, methodology } (effective policy)
 *   PUT /api/admin/tds/config  { clientId, section, methodology }  (GIFSY_ADMIN only)
 *
 * (The proxy + NestJS TransformInterceptor wrap every backend response as
 *  `{ success: true, data }`, so the GET body here is `{ success, data: { clientId, section, methodology } }`.)
 *
 * RBAC: the SET is GIFSY_ADMIN-only (Gifsy governs how TGSL deducts/deposits/recovers per
 * tenant — §5). CLIENT_ADMIN / MIS_USER may VIEW the applied policy read-only (the GET is
 * tenant-readable), so the toggles render disabled with the "Gifsy-operated setting" hint.
 *
 * `loaded` gates the toggles so a GIFSY admin can never click-save the on-screen DEFAULT over
 * the real stored value before the seed fetch resolves (money-path stomp guard).
 */

import { useEffect, useState } from 'react'
import { Loader2, Percent } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAdminSession } from '@/lib/admin-session'
import { api } from '@/lib/api-client'

// ── Local mirror of the Prisma enums (no shared-lib edits; kept in-sync with the DTO). ──
type TdsSection = 'SEC_194R' | 'SEC_194C'
type TdsMethodology = 'DEDUCT' | 'GROSS_UP'

/** Shape of the effective policy returned by GET (inside the `{ success, data }` envelope). */
interface TdsConfigDto {
  clientId: string
  section: TdsSection
  methodology: TdsMethodology
}

// Backend default-on default is {SEC_194C, GROSS_UP} — mirror it as the pre-seed placeholder so
// the screen is coherent before the fetch resolves (the toggles stay DISABLED until `loaded`).
const DEFAULT_SECTION: TdsSection = 'SEC_194C'
const DEFAULT_METHODOLOGY: TdsMethodology = 'GROSS_UP'

const SECTION_OPTIONS: ReadonlyArray<readonly [string, TdsSection]> = [
  ['194C — Visibility service', 'SEC_194C'],
  ['194R — Incentive / benefit', 'SEC_194R'],
]
const METHODOLOGY_OPTIONS: ReadonlyArray<readonly [string, TdsMethodology]> = [
  ['Deduct-then-pay', 'DEDUCT'],
  ['Gross-up', 'GROSS_UP'],
]

/** Shared segmented toggle group — mirrors the settings-page radiogroup button-group. */
function Segmented<T extends string>({
  ariaLabel, options, value, disabled, onSelect, testIdPrefix,
}: {
  ariaLabel: string
  options: ReadonlyArray<readonly [string, T]>
  value: T
  disabled: boolean
  onSelect: (next: T) => void
  testIdPrefix: string
}) {
  return (
    <div className="flex bg-gray-100 rounded-lg p-1 gap-1 flex-wrap" role="radiogroup" aria-label={ariaLabel}>
      {options.map(([label, val]) => (
        <button
          key={val}
          role="radio"
          aria-checked={value === val}
          data-testid={`${testIdPrefix}-${val.toLowerCase()}`}
          disabled={disabled}
          onClick={() => value !== val && onSelect(val)}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
            value === val
              ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function TdsConfigPage() {
  const session = useAdminSession()
  const isGifsy = session.role === 'GIFSY_ADMIN'

  const [section, setSection] = useState<TdsSection>(DEFAULT_SECTION)
  const [methodology, setMethodology] = useState<TdsMethodology>(DEFAULT_METHODOLOGY)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // ── Seed the effective policy. `loaded` unlocks the toggles ONLY after the real stored
  // value has been applied, so a GIFSY admin can't stomp it with the on-screen default. ──
  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/tds/config')
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: TdsConfigDto }) => {
        if (cancelled) return
        if (json?.success && json.data) {
          setSection(json.data.section)
          setMethodology(json.data.methodology)
          setLoaded(true)
        } else {
          setLoadError('Could not load the TDS configuration. Please retry — no value has been changed.')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Could not load the TDS configuration. Please retry — no value has been changed.')
        }
      })
    return () => { cancelled = true }
  }, [])

  function flashSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // A single PUT always carries BOTH fields (the contract requires section + methodology
  // together). Optimistic local update; revert on a non-success response.
  async function persist(nextSection: TdsSection, nextMethodology: TdsMethodology, revert: () => void) {
    setSaveError(null)
    const res = await api.put('/api/admin/tds/config', {
      clientId: session.clientId,
      section: nextSection,
      methodology: nextMethodology,
    })
    if (!res.success) {
      revert()
      setSaveError('Could not save — TDS treatment can only be changed by a Gifsy Admin.')
      return
    }
    flashSaved()
  }

  function handleSectionChange(next: TdsSection) {
    if (!isGifsy || !loaded) return
    const prev = section
    setSection(next) // optimistic
    void persist(next, methodology, () => setSection(prev))
  }

  function handleMethodologyChange(next: TdsMethodology) {
    if (!isGifsy || !loaded) return
    const prev = methodology
    setMethodology(next) // optimistic
    void persist(section, next, () => setMethodology(prev))
  }

  const toggleDisabled = !isGifsy || !loaded

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">TDS Treatment</h1>
          <p className="text-sm text-gray-500 mt-1">
            How TGSL treats this tenant&apos;s <strong>Visibility payouts</strong> for tax withholding.
          </p>
        </div>
        {saved && (
          <span
            data-testid="tds-saved-flash"
            className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0"
          >
            ✓ Saved
          </span>
        )}
      </div>

      {loadError && (
        <Card data-testid="tds-load-error">
          <CardContent className="py-6">
            <p className="text-sm text-red-600">{loadError}</p>
          </CardContent>
        </Card>
      )}

      {/* Seeding spinner (before the GET resolves, and only when there was no hard error). */}
      {!loaded && !loadError && (
        <Card data-testid="tds-loading">
          <CardContent className="py-8 flex items-center justify-center gap-2 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />
            <span className="text-sm">Loading TDS configuration…</span>
          </CardContent>
        </Card>
      )}

      {loaded && (
        <Card data-testid="tds-config-card">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Percent className="h-4 w-4 text-[var(--brand-primary)]" /> TDS treatment for Visibility payouts
            </CardTitle>
            <CardDescription className="mt-1">
              This governs how TGSL withholds tax on this tenant&apos;s Visibility-stream payouts.
              Under <strong>194C</strong> the payout is treated as a visibility service — TGSL raises
              a self-billed invoice and applies TDS; <strong>194R</strong> treats it as an
              incentive/benefit. <strong>Deduct-then-pay</strong> withholds the TDS from the
              retailer&apos;s payout; <strong>Gross-up</strong> pays the retailer in full while TGSL
              deposits the TDS and recovers it from the tenant.
              {isGifsy ? (
                <> Changes apply to new payouts — orders already confirmed keep their treatment.</>
              ) : (
                <> This is a Gifsy-operated setting — only a Gifsy Admin can change it.</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <p className="text-sm font-medium text-gray-900 mb-2">TDS section</p>
              <Segmented
                ariaLabel="TDS section"
                options={SECTION_OPTIONS}
                value={section}
                disabled={toggleDisabled}
                onSelect={handleSectionChange}
                testIdPrefix="tds-section"
              />
            </div>

            <div>
              <p className="text-sm font-medium text-gray-900 mb-2">Methodology</p>
              <Segmented
                ariaLabel="TDS methodology"
                options={METHODOLOGY_OPTIONS}
                value={methodology}
                disabled={toggleDisabled}
                onSelect={handleMethodologyChange}
                testIdPrefix="tds-methodology"
              />
            </div>

            {!isGifsy && (
              <p data-testid="tds-readonly-hint" className="text-xs text-gray-400">
                TDS treatment is a Gifsy-operated setting — only a Gifsy Admin can change it.
              </p>
            )}
            {saveError && (
              <p data-testid="tds-save-error" className="text-xs text-red-600">{saveError}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
