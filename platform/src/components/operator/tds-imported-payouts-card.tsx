'use client'

/**
 * TDS Treatment → "Count imported (vendor) payouts in the 194R report" — per-tenant setting.
 *
 *   GET /api/admin/tds/config/imported-payouts  → { success, data: { clientId, countFrom } }
 *   PUT /api/admin/tds/config/imported-payouts  { clientId, countFrom: 'YYYY-MM-DD' | null }  (GIFSY_ADMIN)
 *
 * OFF (countFrom null) is the default for every tenant: imported vendor incentive-payout history stays
 * out of 194R. ON: imported payouts paid on/after the date count in the 194R report base —
 * REPORT / LIABILITY ONLY (no deduction, no TDS invoice, no recovery); the liability is payer-borne
 * for every client because nothing was withheld. Non-Gifsy viewers see it read-only. The editor
 * stays hidden until the stored value has loaded, so a stale on-screen default can never overwrite it.
 *
 * Guard rails (mirrors the API): date 2000-01-01 … today(IST)+1 year; a date before the CURRENT
 * FY's start also counts earlier financial years → explicit confirm; "Switch off" asks to confirm.
 */

import { useCallback, useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api-client'

const ENDPOINT = '/api/admin/tds/config/imported-payouts'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
export const IMPORTED_MIN_DATE = '2000-01-01'

/** 'YYYY-MM-DD' → '1 Apr 2026' (falls back to the raw string). */
export function formatCountFrom(iso: string): string {
  if (!ISO_DATE.test(iso)) return iso
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${months[m - 1] ?? ''} ${y}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Today (IST) + 1 year as 'YYYY-MM-DD' (29 Feb → 28 Feb) — the API's upper bound. */
export function importedMaxDate(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const y = ist.getUTCFullYear() + 1
  const mo = ist.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  return `${y}-${pad(mo + 1)}-${pad(Math.min(ist.getUTCDate(), lastDay))}`
}

/** 1 April of the CURRENT Indian financial year (IST) as 'YYYY-MM-DD'. */
export function currentFyStart(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
  return `${y}-04-01`
}

/** Compact, length-capped rendering of an invalid stored value for the repair banner. */
function safeJson(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

/** A real calendar date (rejects 2026-02-30). */
function isRealDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function TdsImportedPayoutsCard({ isGifsy }: { isGifsy: boolean }) {
  // The tenant the stored value was LOADED for (GET → data.clientId; the ASSUMED tenant for an
  // assumed operator) — the save always targets that same tenant. Never the session's clientId
  // (that is the operator's HOME 'gifsy' while assumed). Empty → the PUT omits clientId and the
  // API pins it to the assumed tenant.
  const [tenantId, setTenantId] = useState('')
  const [stored, setStored] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [touched, setTouched] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [earlierFyConfirmed, setEarlierFyConfirmed] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  // The stored value is unusable (GET returns it flagged, not thrown) — the 194R report fails
  // closed until a Gifsy Admin re-saves a date or switches it off here.
  const [malformed, setMalformed] = useState(false)
  const [malformedRaw, setMalformedRaw] = useState<unknown>(undefined)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api
      .get<{ clientId: string; countFrom: string | null; malformed?: boolean; raw?: unknown }>(ENDPOINT)
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) {
          setTenantId(res.data.clientId || '')
          setMalformed(!!res.data.malformed)
          setMalformedRaw(res.data.malformed ? res.data.raw : undefined)
          setStored(res.data.countFrom ?? null)
          setDraft(res.data.countFrom ?? '')
          setTouched(false)
          setLoaded(true)
        } else {
          setLoadError(
            (!res.success && res.error) || 'Could not load this setting. Please retry — nothing has been changed.',
          )
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this setting. Please retry — nothing has been changed.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => load(), [load])

  async function save(next: string | null) {
    if (!isGifsy || !loaded || saving) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    const res = await api.put<{ clientId: string; countFrom: string | null }>(ENDPOINT, {
      ...(tenantId ? { clientId: tenantId } : {}),
      countFrom: next,
    })
    setSaving(false)
    setConfirmingOff(false)
    if (!res.success) {
      setSaveError(res.error || 'Could not save — only a Gifsy Admin can change this setting.')
      return
    }
    const value = res.data?.countFrom ?? next
    setMalformed(false)
    setMalformedRaw(undefined)
    setStored(value)
    setDraft(value ?? '')
    setTouched(false)
    setEarlierFyConfirmed(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    // Re-read the stored value so the card always shows what is ACTUALLY stored for this tenant.
    load()
  }

  const maxDate = importedMaxDate()
  const fyStart = currentFyStart()
  const validationError = !draft
    ? 'Choose the date from which imported payouts count.'
    : !isRealDate(draft) || draft < IMPORTED_MIN_DATE || draft > maxDate
      ? `Enter a date between ${formatCountFrom(IMPORTED_MIN_DATE)} and ${formatCountFrom(maxDate)}.`
      : null
  const draftChanged = draft !== (stored ?? '')
  const beforeCurrentFy = !validationError && draft < fyStart
  const canSave = !saving && !validationError && draftChanged && (!beforeCurrentFy || earlierFyConfirmed)

  return (
    <Card data-testid="tds-imported-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--brand-primary)]" /> Imported (vendor) payouts in the 194R report
        </CardTitle>
        <CardDescription className="mt-1">
          Payout history imported from a previous vendor is left out of 194R by default. When switched on,
          imported payouts <strong>paid on or after the date below</strong> are counted in each retailer&apos;s 194R
          total (PAN or no-PAN at 20%, ₹20,000 threshold, deposits subtract) — <strong>liability only, no
          deduction</strong>: nothing is withheld for them, no TDS invoice is raised and nothing is
          recovered automatically. Because nothing was withheld from those payouts, this liability is{' '}
          <strong>payer-borne</strong> for every client. They do count towards the retailer’s ₹20,000 threshold, so a
          194R visibility payout on Deduct can start being withheld sooner. Earlier imported payouts stay excluded. Retailer TDS paid
          later must be uploaded as <strong>deposits</strong> only — never as off-platform benefits (that would
          count the imported payouts twice).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && (
          <div className="flex flex-wrap items-center gap-3">
            <p data-testid="tds-imported-load-error" role="alert" className="text-sm text-red-600">{loadError}</p>
            <button
              type="button"
              data-testid="tds-imported-retry"
              disabled={loading}
              onClick={() => load()}
              className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-50"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}

        {!loaded && !loadError && (
          <div data-testid="tds-imported-loading" role="status" className="flex items-center gap-2 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {loaded && (
          <>
            {malformed && (
              <div
                data-testid="tds-imported-malformed"
                role="alert"
                className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-2"
              >
                <p>
                  <strong>The stored value is invalid</strong>
                  {malformedRaw !== undefined && (
                    <> (<code className="text-xs break-all">{safeJson(malformedRaw)}</code>)</>
                  )}{' '}
                  — the 194R report can&apos;t be produced until it is fixed.{' '}
                  {isGifsy ? 'Re-save a date below or switch this off.' : 'Ask a Gifsy Admin to re-save it or switch it off.'}
                </p>
                {isGifsy && (
                  <button
                    type="button"
                    data-testid="tds-imported-malformed-off"
                    disabled={saving}
                    onClick={() => void save(null)}
                    className="px-3 py-1.5 rounded-md text-sm font-medium border border-red-300 text-red-800 bg-white disabled:opacity-50"
                  >
                    Switch off (clear the invalid value)
                  </button>
                )}
              </div>
            )}
            <p data-testid="tds-imported-status" role="status" className="text-sm text-gray-900">
              {malformed ? (
                <>
                  <span className="font-semibold text-red-700">Invalid</span> — no valid date is stored.
                </>
              ) : stored ? (
                <>
                  <span className="font-semibold text-emerald-700">On</span> — count imported (vendor) payouts paid on/after{' '}
                  <strong>{formatCountFrom(stored)}</strong> in the 194R report — liability only, no deduction.
                </>
              ) : (
                <>
                  <span className="font-semibold text-gray-600">Off</span> — imported (vendor) payouts are not counted in the 194R report.
                </>
              )}
            </p>

            {isGifsy ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-sm text-gray-700 flex flex-col gap-1">
                    Count from (date paid)
                    <input
                      type="date"
                      data-testid="tds-imported-date"
                      value={draft}
                      min={IMPORTED_MIN_DATE}
                      max={maxDate}
                      disabled={saving}
                      aria-invalid={touched && !!validationError}
                      aria-describedby="tds-imported-date-hint"
                      onChange={(e) => {
                        setDraft(e.target.value)
                        setTouched(true)
                        setEarlierFyConfirmed(false)
                      }}
                      className="border border-gray-300 rounded-md px-3 py-2 text-sm disabled:opacity-60"
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="tds-imported-save"
                    disabled={!canSave}
                    onClick={() => void save(draft)}
                    className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--brand-primary)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {stored || malformed ? 'Save date' : 'Switch on'}
                  </button>
                  {stored && !confirmingOff && (
                    <button
                      type="button"
                      data-testid="tds-imported-off"
                      disabled={saving}
                      onClick={() => setConfirmingOff(true)}
                      className="px-4 py-2 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-50"
                    >
                      Switch off
                    </button>
                  )}
                  {saved && (
                    <span data-testid="tds-imported-saved" role="status" className="text-xs font-semibold text-emerald-600">✓ Saved</span>
                  )}
                </div>

                <div id="tds-imported-date-hint">
                  {touched && validationError && (
                    <p data-testid="tds-imported-date-error" role="alert" className="text-xs text-red-600">{validationError}</p>
                  )}
                  {beforeCurrentFy && draftChanged && (
                    <div data-testid="tds-imported-earlier-fy-warning" role="alert" className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-2">
                      <p>
                        {formatCountFrom(draft)} is before the current financial year (starts {formatCountFrom(fyStart)}) —
                        this will also count imported payouts in earlier financial years.
                      </p>
                      <label className="flex items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          data-testid="tds-imported-earlier-fy-confirm"
                          checked={earlierFyConfirmed}
                          onChange={(e) => setEarlierFyConfirmed(e.target.checked)}
                        />
                        Yes, count imported payouts in earlier financial years too
                      </label>
                    </div>
                  )}
                </div>

                {confirmingOff && (
                  <div data-testid="tds-imported-off-confirm" role="alert" className="flex flex-wrap items-center gap-3 text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <span>Switch off? Imported payouts will no longer be counted in the 194R report.</span>
                    <button
                      type="button"
                      data-testid="tds-imported-off-yes"
                      disabled={saving}
                      onClick={() => void save(null)}
                      className="px-3 py-1.5 rounded-md text-sm font-medium bg-red-600 text-white disabled:opacity-50"
                    >
                      Yes, switch off
                    </button>
                    <button
                      type="button"
                      data-testid="tds-imported-off-cancel"
                      disabled={saving}
                      onClick={() => setConfirmingOff(false)}
                      className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p data-testid="tds-imported-readonly" className="text-xs text-gray-400">
                This is a Gifsy-operated setting — only a Gifsy Admin can change it.
              </p>
            )}
            {saveError && <p data-testid="tds-imported-save-error" role="alert" className="text-xs text-red-600">{saveError}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
