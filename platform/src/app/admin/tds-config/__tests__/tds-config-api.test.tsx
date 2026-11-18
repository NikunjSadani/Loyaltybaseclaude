/// <reference types="vitest/globals" />
/**
 * TDS Treatment config page — Wave 2 Stream D.
 *
 * Round-trips the per-tenant TDS policy against the backend contract:
 *   GET /api/admin/tds/config  → { success, data: { clientId, section, methodology } }
 *   PUT /api/admin/tds/config  { clientId, section, methodology }   (GIFSY_ADMIN only)
 *
 * Covered:
 *  - GIFSY_ADMIN: seeded value renders; toggling PUTs the RIGHT body (both fields).
 *  - CLIENT_ADMIN: toggles are read-only/disabled and NO PUT is fired.
 *  - the `loaded` gate keeps the toggles disabled (and un-PUT-able) until the seed resolves,
 *    so the on-screen default can never stomp the stored value.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// next/* mocks (defensive — the page itself doesn't use them, but keep the harness isolated).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/tds-config',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

// Flip the admin role per test.
let mockRole: 'GIFSY_ADMIN' | 'CLIENT_ADMIN' = 'GIFSY_ADMIN'
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({
    role: mockRole,
    clientId: mockRole === 'GIFSY_ADMIN' ? 'gifsy' : 'deoleo',
    name: 'Test Admin',
    userId: 'u1',
    canManageSchemes: mockRole === 'GIFSY_ADMIN',
  }),
}))

import TdsConfigPage from '../page'

type Section = 'SEC_194R' | 'SEC_194C'
type Methodology = 'DEDUCT' | 'GROSS_UP'

/** Records PUT calls; GET resolves with the given effective policy (envelope-wrapped). */
function stubFetch(
  policy: { clientId: string; section: Section; methodology: Methodology },
  opts: { putIgnored?: boolean } = {},
) {
  const puts: Array<{ url: string; body: unknown }> = []
  // The "server": a successful PUT changes what the next GET returns (the page re-fetches after a
  // save). `putIgnored` simulates the prod bug — the PUT "succeeds" but the tenant's value is unchanged.
  let current = { ...policy }
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/admin/tds/config' && (!init || (init.method ?? 'GET') === 'GET')) {
      const data = { ...current }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data }),
      })
    }
    if (url === '/api/admin/tds/config' && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string)
      puts.push({ url, body })
      if (!opts.putIgnored) current = { ...current, section: body.section, methodology: body.methodology }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: body }),
      })
    }
    return Promise.reject(new Error('unexpected fetch in test: ' + url))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { puts, fetchMock }
}

describe('TDS Treatment config page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRole = 'GIFSY_ADMIN'
  })

  it('seeds the stored policy and renders it as the checked toggles (GIFSY)', async () => {
    stubFetch({ clientId: 'gifsy', section: 'SEC_194R', methodology: 'DEDUCT' })
    render(<TdsConfigPage />)

    const section194r = await screen.findByTestId('tds-section-sec_194r')
    expect(section194r).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByTestId('tds-section-sec_194c')).toHaveAttribute('aria-checked', 'false')
    expect(await screen.findByTestId('tds-methodology-deduct')).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByTestId('tds-methodology-gross_up')).toHaveAttribute('aria-checked', 'false')
    // Editable for GIFSY once loaded.
    expect(section194r).not.toBeDisabled()
  })

  it('PUTs { clientId, section, methodology } with BOTH fields when a toggle is changed (GIFSY)', async () => {
    const { puts } = stubFetch({ clientId: 'gifsy', section: 'SEC_194C', methodology: 'GROSS_UP' })
    render(<TdsConfigPage />)

    // Seed resolved → toggles enabled.
    const deduct = await screen.findByTestId('tds-methodology-deduct')
    await waitFor(() => expect(deduct).not.toBeDisabled())

    // Change methodology → PUT carries the CURRENT section + the NEW methodology.
    fireEvent.click(deduct)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].body).toEqual({ clientId: 'gifsy', section: 'SEC_194C', methodology: 'DEDUCT' })
    // Optimistic UI reflects the change + the saved flash fires.
    expect(deduct).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByTestId('tds-saved-flash')).toBeInTheDocument()

    // Change section → PUT carries the NEW section + the (now-updated) methodology.
    fireEvent.click(screen.getByTestId('tds-section-sec_194r'))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1].body).toEqual({ clientId: 'gifsy', section: 'SEC_194R', methodology: 'DEDUCT' })
  })

  it('ASSUMED into bajaj (session clientId is the home "gifsy"): the PUT targets the GET tenant "bajaj"', async () => {
    // PROD BUG: the page used to send session.clientId ('gifsy') → the policy was saved for 'gifsy'.
    const { puts } = stubFetch({ clientId: 'bajaj', section: 'SEC_194C', methodology: 'GROSS_UP' })
    render(<TdsConfigPage />)
    expect(await screen.findByTestId('tds-config-tenant')).toHaveTextContent('bajaj')
    const s194r = await screen.findByTestId('tds-section-sec_194r')
    await waitFor(() => expect(s194r).not.toBeDisabled())
    fireEvent.click(s194r)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].body).toEqual({ clientId: 'bajaj', section: 'SEC_194R', methodology: 'GROSS_UP' })
    // Re-fetched after the save → shows the STORED value.
    expect(await screen.findByTestId('tds-saved-flash')).toBeInTheDocument()
    expect(await screen.findByTestId('tds-section-sec_194r')).toHaveAttribute('aria-checked', 'true')
  })

  it('after a save the page RE-FETCHES: if the stored value did not change it shows the stored value + an error (no false "Saved")', async () => {
    const { puts, fetchMock } = stubFetch({ clientId: 'bajaj', section: 'SEC_194C', methodology: 'GROSS_UP' }, { putIgnored: true })
    render(<TdsConfigPage />)
    const s194r = await screen.findByTestId('tds-section-sec_194r')
    await waitFor(() => expect(s194r).not.toBeDisabled())
    fireEvent.click(s194r)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(await screen.findByTestId('tds-save-error')).toHaveTextContent('did not take effect')
    expect(await screen.findByTestId('tds-section-sec_194c')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('tds-saved-flash')).not.toBeInTheDocument()
    const gets = fetchMock.mock.calls.filter(([u, i]) => u === '/api/admin/tds/config' && !(i as RequestInit | undefined)?.method)
    expect(gets.length).toBe(2) // seed + post-save re-fetch
  })

  it('renders read-only/disabled toggles for CLIENT_ADMIN and never PUTs', async () => {
    mockRole = 'CLIENT_ADMIN'
    const { puts } = stubFetch({ clientId: 'deoleo', section: 'SEC_194C', methodology: 'GROSS_UP' })
    render(<TdsConfigPage />)

    const section194c = await screen.findByTestId('tds-section-sec_194c')
    expect(section194c).toHaveAttribute('aria-checked', 'true') // still shows the applied value
    expect(section194c).toBeDisabled()
    expect(await screen.findByTestId('tds-methodology-gross_up')).toBeDisabled()
    expect(await screen.findByTestId('tds-readonly-hint')).toBeInTheDocument()

    // Clicking a disabled toggle must not fire a PUT.
    fireEvent.click(screen.getByTestId('tds-section-sec_194r'))
    await Promise.resolve()
    expect(puts).toHaveLength(0)
  })

  it('the loaded-gate keeps toggles disabled until the seed resolves (no default overwrite)', async () => {
    // A GET that never resolves → the page stays in the pre-seed state.
    let resolveGet: (v: unknown) => void = () => {}
    const puts: Array<unknown> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') { puts.push(JSON.parse(init.body as string)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) }) }
        return new Promise((res) => { resolveGet = res })
      }),
    )
    render(<TdsConfigPage />)

    // Before the seed resolves: the spinner is up and the config card (with toggles) is absent,
    // so there is nothing to click-save → the default can't stomp the stored value.
    expect(screen.getByTestId('tds-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-config-card')).not.toBeInTheDocument()

    // Resolve with the REAL stored value → toggles appear, enabled, showing the stored value.
    resolveGet({ ok: true, json: () => Promise.resolve({ success: true, data: { clientId: 'gifsy', section: 'SEC_194R', methodology: 'DEDUCT' } }) })
    const section194r = await screen.findByTestId('tds-section-sec_194r')
    await waitFor(() => expect(section194r).not.toBeDisabled())
    expect(section194r).toHaveAttribute('aria-checked', 'true')
    expect(puts).toHaveLength(0) // no PUT happened during seeding
  })

  it('describes the real scope: methodology on all credit-upload payouts, section visibility-only, set before first batch', async () => {
    stubFetch({ clientId: 'gifsy', section: 'SEC_194C', methodology: 'GROSS_UP' })
    render(<TdsConfigPage />)

    const scope = await screen.findByTestId('tds-config-scope')
    const text = scope.textContent ?? ''
    // Methodology is recorded on every credit-upload payout (visibility AND incentive)...
    expect(text).toMatch(/recorded on every credit-upload ₹ payout \(visibility\s+and incentive\)/)
    // ...but only changes the amount paid on visibility payouts; incentive never deducted.
    expect(text).toMatch(/only changes what is paid on visibility payouts/)
    expect(text).toMatch(/Incentive payouts are\s+never deducted/)
    expect(text).toMatch(/194R report shows their gross-up liability, and no TDS invoice is\s+raised for them/)
    // D7 (owner 2026-11-18): the TDS invoice + tenant recovery is 194C-only.
    expect(text).toMatch(/under\s+194C\s+TGSL raises a TDS invoice/)
    expect(text).toMatch(/194R\s+gross-up raises no TDS invoice/)
    // Section is visibility-only; incentive always 194R.
    expect(text).toMatch(/section applies only to visibility payouts/)
    expect(text).toMatch(/incentive payouts are always 194R/)
    // Points redemptions are report-only.
    expect(text).toMatch(/Points\s+redemptions are never deducted from the partner/)
    // The owner-requested timing line.
    expect(screen.getByTestId('tds-set-before-first-batch')).toHaveTextContent(
      'Each payout records the method when its batch is confirmed — set this before the first live payout batch.',
    )
    // No longer framed as Visibility-only.
    expect(screen.queryByText(/TDS treatment for Visibility payouts/)).not.toBeInTheDocument()
  })

  it('shows an explicit error card when the seed fetch fails (never fabricates a value)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    render(<TdsConfigPage />)
    expect(await screen.findByTestId('tds-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-config-card')).not.toBeInTheDocument()
  })
})
