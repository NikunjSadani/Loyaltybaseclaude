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
function stubFetch(policy: { clientId: string; section: Section; methodology: Methodology }) {
  const puts: Array<{ url: string; body: unknown }> = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/admin/tds/config' && (!init || (init.method ?? 'GET') === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: policy }),
      })
    }
    if (url === '/api/admin/tds/config' && init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(init.body as string) })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: JSON.parse(init.body as string) }),
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
    expect(screen.getByTestId('tds-section-sec_194c')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('tds-methodology-deduct')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('tds-methodology-gross_up')).toHaveAttribute('aria-checked', 'false')
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

  it('renders read-only/disabled toggles for CLIENT_ADMIN and never PUTs', async () => {
    mockRole = 'CLIENT_ADMIN'
    const { puts } = stubFetch({ clientId: 'deoleo', section: 'SEC_194C', methodology: 'GROSS_UP' })
    render(<TdsConfigPage />)

    const section194c = await screen.findByTestId('tds-section-sec_194c')
    expect(section194c).toHaveAttribute('aria-checked', 'true') // still shows the applied value
    expect(section194c).toBeDisabled()
    expect(screen.getByTestId('tds-methodology-gross_up')).toBeDisabled()
    expect(screen.getByTestId('tds-readonly-hint')).toBeInTheDocument()

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

  it('shows an explicit error card when the seed fetch fails (never fabricates a value)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    render(<TdsConfigPage />)
    expect(await screen.findByTestId('tds-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-config-card')).not.toBeInTheDocument()
  })
})
