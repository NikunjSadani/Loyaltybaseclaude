'use client'

/**
 * TDS Treatment → "Count imported (vendor) payouts in the 194R report" — per-tenant setting.
 *
 *   GET /api/admin/tds/config/imported-payouts  → { success, data: { clientId, countFrom } }
 *   PUT /api/admin/tds/config/imported-payouts  { clientId, countFrom: 'YYYY-MM-DD' | null }  (GIFSY_ADMIN)
 *
 * OFF (countFrom null) is the default for every tenant: imported VENDOR_IMPORT payout history stays
 * out of 194R. ON: imported payouts paid on/after the date count in the 194R report base —
 * REPORT / LIABILITY ONLY (no deduction, no TDS invoice, no recovery). Non-Gifsy viewers see it
 * read-only. The editor stays hidden until the stored value has loaded, so a stale on-screen
 * default can never overwrite it.
 */

import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api-client'

const ENDPOINT = '/api/admin/tds/config/imported-payouts'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' → '1 Apr 2026' (falls back to the raw string). */
export function formatCountFrom(iso: string): string {
  if (!ISO_DATE.test(iso)) return iso
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${months[m - 1] ?? ''} ${y}`
}

export function TdsImportedPayoutsCard({ clientId, isGifsy }: { clientId: string; isGifsy: boolean }) {
  // The tenant the stored value was LOADED for — the save always targets that same tenant.
  const [tenantId, setTenantId] = useState(clientId)
  const [stored, setStored] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get<{ clientId: string; countFrom: string | null }>(ENDPOINT).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setTenantId(res.data.clientId || clientId)
        setStored(res.data.countFrom ?? null)
        setDraft(res.data.countFrom ?? '')
        setLoaded(true)
      } else {
        setLoadError('Could not load this setting. Please retry — nothing has been changed.')
      }
    })
    return () => { cancelled = true }
  }, [])

  async function save(next: string | null) {
    if (!isGifsy || !loaded || saving) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    const res = await api.put<{ clientId: string; countFrom: string | null }>(ENDPOINT, { clientId: tenantId, countFrom: next })
    setSaving(false)
    if (!res.success) {
      setSaveError(res.error || 'Could not save — only a Gifsy Admin can change this setting.')
      return
    }
    const value = res.data?.countFrom ?? next
    setStored(value)
    setDraft(value ?? '')
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const draftValid = ISO_DATE.test(draft)
  const draftChanged = draft !== (stored ?? '')

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
          deduction</strong>: nothing is withheld from future payouts, no TDS invoice is raised and nothing is
          recovered automatically. For a gross-up client this liability is payer-borne. Earlier imported payouts
          stay excluded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && <p data-testid="tds-imported-load-error" className="text-sm text-red-600">{loadError}</p>}

        {!loaded && !loadError && (
          <div data-testid="tds-imported-loading" className="flex items-center gap-2 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {loaded && (
          <>
            <p data-testid="tds-imported-status" className="text-sm text-gray-900">
              {stored ? (
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
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm text-gray-700 flex flex-col gap-1">
                  Count from (date paid)
                  <input
                    type="date"
                    data-testid="tds-imported-date"
                    value={draft}
                    disabled={saving}
                    onChange={(e) => setDraft(e.target.value)}
                    className="border border-gray-300 rounded-md px-3 py-2 text-sm disabled:opacity-60"
                  />
                </label>
                <button
                  type="button"
                  data-testid="tds-imported-save"
                  disabled={saving || !draftValid || !draftChanged}
                  onClick={() => void save(draft)}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--brand-primary)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {stored ? 'Save date' : 'Switch on'}
                </button>
                {stored && (
                  <button
                    type="button"
                    data-testid="tds-imported-off"
                    disabled={saving}
                    onClick={() => void save(null)}
                    className="px-4 py-2 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-50"
                  >
                    Switch off
                  </button>
                )}
                {saved && (
                  <span data-testid="tds-imported-saved" className="text-xs font-semibold text-emerald-600">✓ Saved</span>
                )}
              </div>
            ) : (
              <p data-testid="tds-imported-readonly" className="text-xs text-gray-400">
                This is a Gifsy-operated setting — only a Gifsy Admin can change it.
              </p>
            )}
            {saveError && <p data-testid="tds-imported-save-error" className="text-xs text-red-600">{saveError}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
