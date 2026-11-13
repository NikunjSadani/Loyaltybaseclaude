/// <reference types="vitest/globals" />
/**
 * TDS Treatment → "Imported (vendor) payouts in the 194R report" card.
 *   GET /api/admin/tds/config/imported-payouts → { success, data: { clientId, countFrom } }
 *   PUT /api/admin/tds/config/imported-payouts { clientId, countFrom }   (GIFSY_ADMIN only)
 * Covered: OFF/ON status copy; GIFSY switch-on / change date / confirmed switch-off PUT bodies (target =
 * the LOADED tenant); read-only for a tenant admin; load error + Retry; save error; inline date
 * validation (empty / < 2000-01-01 / > today+1y); earlier-FY warning requires an explicit confirm;
 * payer-borne + deposits-only copy. Dates are computed relative to "now" (never hardcoded future dates).
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import {
  TdsImportedPayoutsCard,
  formatCountFrom,
  currentFyStart,
  importedMaxDate,
} from '@/components/operator/tds-imported-payouts-card'

const URL = '/api/admin/tds/config/imported-payouts'

/** A date safely inside the current FY and not in the future: the current FY's 1 April. */
const FY_START = currentFyStart()
/** A date in an earlier FY. */
const EARLIER = `${parseInt(FY_START.slice(0, 4), 10) - 2}-06-15`

function stub(
  initial: { clientId: string; countFrom: string | null },
  opts: { putFails?: boolean; getFails?: boolean; getFailsOnce?: boolean } = {},
) {
  const puts: unknown[] = []
  let getCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === URL && (init?.method ?? 'GET') === 'GET') {
        getCalls++
        if (opts.getFails || (opts.getFailsOnce && getCalls === 1)) return Promise.reject(new Error('down'))
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
  return { puts, getCalls: () => getCalls }
}

describe('TdsImportedPayoutsCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('OFF: shows the Off status; GIFSY switches it on with a date → PUT { clientId: loaded tenant, countFrom }', async () => {
    const { puts } = stub({ clientId: 'bajaj', countFrom: null })
    render(<TdsImportedPayoutsCard clientId="gifsy" isGifsy />)
    expect(await screen.findByTestId('tds-imported-status')).toHaveTextContent(/Off/)
    const save = screen.getByTestId('tds-imported-save')
    expect(save).toBeDisabled() // no date yet
    fireEvent.change(screen.getByTestId('tds-imported-date'), { target: { value: FY_START } })
    expect(save).not.toBeDisabled()
    expect(screen.queryByTestId('tds-imported-earlier-fy-warning')).not.toBeInTheDocument()
    fireEvent.click(save)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ clientId: 'bajaj', countFrom: FY_START })
    await waitFor(() =>
      expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(
        `count imported (vendor) payouts paid on/after ${formatCountFrom(FY_START)} in the 194R report — liability only, no deduction`,
      ),
    )
    expect(screen.getByTestId('tds-imported-saved')).toHaveAttribute('role', 'status')
  })

  it('ON: "Switch off" asks to confirm; Cancel does nothing; "Yes, switch off" PUTs countFrom null', async () => {
    const { puts } = stub({ clientId: 'bajaj', countFrom: FY_START })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    fireEvent.click(await screen.findByTestId('tds-imported-off'))
    expect(screen.getByTestId('tds-imported-off-confirm')).toBeInTheDocument()
    expect(puts).toHaveLength(0)
    fireEvent.click(screen.getByTestId('tds-imported-off-cancel'))
    expect(screen.queryByTestId('tds-imported-off-confirm')).not.toBeInTheDocument()
    expect(puts).toHaveLength(0)

    fireEvent.click(screen.getByTestId('tds-imported-off'))
    fireEvent.click(screen.getByTestId('tds-imported-off-yes'))
    await waitFor(() => expect(puts).toEqual([{ clientId: 'bajaj', countFrom: null }]))
    await waitFor(() => expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(/Off/))
  })

  it('a date before the current FY shows the earlier-years warning and needs an explicit confirm', async () => {
    const { puts } = stub({ clientId: 'bajaj', countFrom: null })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    fireEvent.change(await screen.findByTestId('tds-imported-date'), { target: { value: EARLIER } })
    const warning = screen.getByTestId('tds-imported-earlier-fy-warning')
    expect(warning).toHaveTextContent('this will also count imported payouts in earlier financial years')
    expect(warning).toHaveAttribute('role', 'alert')
    const save = screen.getByTestId('tds-imported-save')
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(puts).toHaveLength(0)

    fireEvent.click(screen.getByTestId('tds-imported-earlier-fy-confirm'))
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    await waitFor(() => expect(puts).toEqual([{ clientId: 'bajaj', countFrom: EARLIER }]))
  })

  it('inline validation: empty, before 2000-01-01 and after today + 1 year are rejected (no PUT)', async () => {
    const { puts } = stub({ clientId: 'bajaj', countFrom: FY_START })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    const input = await screen.findByTestId('tds-imported-date')
    expect(input).toHaveAttribute('min', '2000-01-01')
    expect(input).toHaveAttribute('max', importedMaxDate())

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByTestId('tds-imported-date-error')).toHaveTextContent('Choose the date')
    expect(screen.getByTestId('tds-imported-save')).toBeDisabled()

    fireEvent.change(input, { target: { value: '1999-12-31' } })
    expect(screen.getByTestId('tds-imported-date-error')).toHaveTextContent('Enter a date between 1 Jan 2000 and')
    expect(screen.getByTestId('tds-imported-save')).toBeDisabled()

    const far = `${parseInt(importedMaxDate().slice(0, 4), 10) + 1}-01-01`
    fireEvent.change(input, { target: { value: far } })
    expect(screen.getByTestId('tds-imported-date-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('tds-imported-save')).toBeDisabled()
    expect(puts).toHaveLength(0)
  })

  it('tenant admin: read-only status, no editor, never PUTs', async () => {
    const { puts } = stub({ clientId: 'bajaj', countFrom: FY_START })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy={false} />)
    expect(await screen.findByTestId('tds-imported-status')).toHaveTextContent(/On/)
    expect(screen.getByTestId('tds-imported-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('tds-imported-date')).not.toBeInTheDocument()
    expect(puts).toHaveLength(0)
  })

  it('load failure → explicit error (role=alert), no editor; Retry re-fetches and recovers', async () => {
    const s = stub({ clientId: 'bajaj', countFrom: null }, { getFailsOnce: true })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    expect(await screen.findByTestId('tds-imported-load-error')).toHaveAttribute('role', 'alert')
    expect(screen.queryByTestId('tds-imported-status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tds-imported-retry'))
    expect(await screen.findByTestId('tds-imported-status')).toHaveTextContent(/Off/)
    expect(s.getCalls()).toBe(2)
    expect(screen.queryByTestId('tds-imported-load-error')).not.toBeInTheDocument()
  })

  it('save failure → error shown (role=alert), status unchanged', async () => {
    stub({ clientId: 'bajaj', countFrom: null }, { putFails: true })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    fireEvent.change(await screen.findByTestId('tds-imported-date'), { target: { value: FY_START } })
    fireEvent.click(screen.getByTestId('tds-imported-save'))
    expect(await screen.findByTestId('tds-imported-save-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('tds-imported-status')).toHaveTextContent(/Off/)
  })

  it('copy: liability is payer-borne for every client; later TDS goes in as deposits only', async () => {
    stub({ clientId: 'bajaj', countFrom: null })
    render(<TdsImportedPayoutsCard clientId="bajaj" isGifsy />)
    const card = await screen.findByTestId('tds-imported-card')
    expect(card).toHaveTextContent('this liability is payer-borne for every client')
    expect(card).not.toHaveTextContent(/gross-up client/i)
    expect(card).toHaveTextContent('must be uploaded as deposits only — never as off-platform benefits')
  })

  it('helpers: formatCountFrom, currentFyStart, importedMaxDate', () => {
    expect(formatCountFrom('2026-04-01')).toBe('1 Apr 2026')
    expect(formatCountFrom('bad')).toBe('bad')
    expect(currentFyStart(new Date('2026-11-13T06:00:00Z'))).toBe('2026-04-01')
    expect(currentFyStart(new Date('2027-03-31T06:00:00Z'))).toBe('2026-04-01')
    expect(currentFyStart(new Date('2027-03-31T19:00:00Z'))).toBe('2027-04-01') // 00:30 IST on 1 Apr
    expect(importedMaxDate(new Date('2026-11-13T06:00:00Z'))).toBe('2027-11-13')
    expect(importedMaxDate(new Date('2028-02-29T06:00:00Z'))).toBe('2029-02-28')
  })
})
