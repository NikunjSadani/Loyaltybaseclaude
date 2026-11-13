/// <reference types="vitest/globals" />
/**
 * TDS Treatment → "Imported (vendor) payouts in the 194R report" card.
 *   GET /api/admin/tds/config/imported-payouts → { success, data: { clientId, countFrom } }
 *   PUT /api/admin/tds/config/imported-payouts { clientId, countFrom }   (GIFSY_ADMIN only)
 * Covered: OFF/ON status copy; GIFSY switch-on / change date / switch-off PUT bodies (target = the
 * LOADED tenant); read-only for a tenant admin (no editor, no PUT); load error; save error.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { TdsImportedPayoutsCard, formatCountFrom } from '@/components/operator/tds-imported-payouts-card'

const URL = '/api/admin/tds/config/imported-payouts'

function stub(initial: { clientId: string; countFrom: string | null }, opts: { putFails?: boolean; getFails?: boolean } = {}) {
  const puts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === URL && (init?.method ?? 'GET') === 'GET') {
        if (opts.getFails) return Promise.reject(new Error('down'))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: initial }) })
      }
      if (url === URL && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        puts.push(body)
        if (opts.putFails) {
          return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ success: false, error: 'Forbidden' }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: body }) })
      }
      return Promise.reject(new Error('unexpected ' + url))
    }),
  )
  return puts
}

describe('TdsImportedPayoutsCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('OFF: shows the Off status; GIFSY switches it on with a date → PUT { clientId: loaded tenant, countFrom }', async () => {
    const puts = stub({ clientId: 'bajaj', countFrom: null })
    render(<TdsImportedPayoutsCard clientId="gifsy" isGifsy />)
    expect(await screen.findByTestId('tds-imported-status')).toHaveTextContent(/Off/)
    const save = screen.getByTestId('tds-imported-save')
    expect(save).toBeDisabled() // no date yet
    fireEvent.change(screen.getByTestId('tds-imported-date'), { target: { value: '2026-04-01' } })
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ clientId: 'bajaj', countFrom: '2026-04-01' })
    await waitFor(() =>
      expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(
        'count imported (vendor) payouts paid on/after 1 Apr 2026 in the 194R report — liability only, no deduction',
      ),
    )
    expect(screen.getByTestId('tds-imported-saved')).toBeInTheDocument()
  })

  it('ON: "Switch off" PUTs countFrom null and returns to Off', async () => {
    const puts = stub({ clientId: 'bajaj', countFrom: '2026-04-01' })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    fireEvent.click(await screen.findByTestId('tds-imported-off'))
    await waitFor(() => expect(puts).toEqual([{ clientId: 'bajaj', countFrom: null }]))
    await waitFor(() => expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(/Off/))
  })

  it('tenant admin: read-only status, no editor, never PUTs', async () => {
    const puts = stub({ clientId: 'bajaj', countFrom: '2026-04-01' })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy={false} />)
    expect(await screen.findByTestId('tds-imported-status')).toHaveTextContent(/On/)
    expect(screen.getByTestId('tds-imported-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-imported-date')).not.toBeInTheDocument()
    expect(puts).toHaveLength(0)
  })

  it('load failure → explicit error, no editor (never shows a fabricated value)', async () => {
    stub({ clientId: 'bajaj', countFrom: null }, { getFails: true })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    expect(await screen.findByTestId('tds-imported-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-imported-status')).not.toBeInTheDocument()
  })

  it('save failure → error shown, status unchanged', async () => {
    stub({ clientId: 'bajaj', countFrom: null }, { putFails: true })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    fireEvent.change(await screen.findByTestId('tds-imported-date'), { target: { value: '2026-04-01' } })
    fireEvent.click(screen.getByTestId('tds-imported-save'))
    expect(await screen.findByTestId('tds-imported-save-error')).toBeInTheDocument()
    expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(/Off/)
  })

  it('formatCountFrom', () => {
    expect(formatCountFrom('2026-04-01')).toBe('1 Apr 2026')
    expect(formatCountFrom('bad')).toBe('bad')
  })
})
