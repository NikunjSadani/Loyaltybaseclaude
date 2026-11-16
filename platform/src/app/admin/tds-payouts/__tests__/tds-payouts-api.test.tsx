/// <reference types="vitest/globals" />
/**
 * /admin/tds-payouts — visibility-payout TDS report (Wave 2 Stream F, §6).
 *
 * Backend contract:
 *   GET /api/admin/tds-reports/payouts[?clientId=&period=]  (CLIENT_ADMIN own · GIFSY any)
 *   GET /api/admin/tds-reports/payouts/export              → xlsx
 *
 * The page fetches the scoped report ONCE (server pins CLIENT_ADMIN to their tenant from the JWT —
 * no clientId is sent) and filters client-side; only the GIFSY client filter contributes a
 * clientId to the EXPORT url.
 *
 * Covered:
 *  - CLIENT_ADMIN: the report GET is tenant-scoped — no clientId param.
 *  - GIFSY: the report GET is also clientId-free; selecting a tenant scopes the EXPORT url.
 *  - section / methodology / GST-reg-type columns render.
 *  - export triggers a blob download.
 *  - error path renders the error card.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/tds-payouts',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>()
  return { ...actual, useAdminSession: vi.fn() }
})

import { useAdminSession } from '@/lib/admin-session'
import AdminTdsPayoutsPage from '../page'

type Role = 'GIFSY_ADMIN' | 'CLIENT_ADMIN'

function asRole(role: Role) {
  vi.mocked(useAdminSession).mockReturnValue({
    role,
    name: 'Test Admin',
    userId: '',
    canManageSchemes: role === 'GIFSY_ADMIN',
  })
}

const ROW = {
  clientId: 'deoleo',
  outletCode: 'OUT-9',
  outletName: 'Shop A',
  businessName: 'Biz Pvt Ltd',
  panNumber: 'ABCDE1234F',
  gstRegistrationType: 'REGULAR',
  entityType: 'PROPRIETOR',
  fieldName: 'visibility',
  period: '2026-07',
  amount: { paise: '1000000', inr: 10000 },
  tdsSection: 'SEC_194C',
  tdsMethodology: 'GROSS_UP',
  tdsDeducted: { paise: '20000', inr: 200 },
  invoiceNumber: 'INV-1',
}

let withCredits = false
const M = (paise: number) => ({ paise: String(paise), inr: paise / 100 })

function report() {
  return {
    ...(withCredits
      ? {
          tdsCredits: {
            count: 1,
            totals: { created: M(40000), applied: M(31000), outstanding: M(9000) },
            rows: [{
              creditId: 'c1', clientId: 'bajaj', panNumber: 'ABCDE1234F', section: 'SEC_194C', fyLabel: '2026-27',
              createdAt: '2026-11-10T00:00:00.000Z', sourceOutletCode: 'O1', sourceOutletName: 'Shop Reversed', sourcePeriod: '2026-10',
              credit: M(40000), applied: M(31000), outstanding: M(9000),
              applications: [
                { applicationId: 'a1', appliedAt: '2026-11-12T00:00:00.000Z', amount: M(31000), outletName: 'Shop Next', period: '2026-11', released: false, releaseReason: null },
                { applicationId: 'a0', appliedAt: '2026-11-11T00:00:00.000Z', amount: M(9000), outletName: 'Shop Failed', period: '2026-11', released: true, releaseReason: 'PAYOUT_FAILED' },
              ],
            }],
          },
        }
      : {}),
    scope: { clientId: null, period: null },
    count: 1,
    totals: { amount: { paise: '1000000', inr: 10000 }, tdsDeducted: { paise: '20000', inr: 200 } },
    rows: [ROW],
  }
}

function stubFetch(opts: { fail?: boolean } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/admin/tds-reports/payouts/export')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'attachment; filename="tds-payouts-all.xlsx"' },
        blob: () => Promise.resolve(new Blob(['x'])),
      })
    }
    if (url.startsWith('/api/admin/tds-reports/payouts')) {
      if (opts.fail) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'nope' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: report() }) })
    }
    return Promise.reject(new Error('unexpected fetch in test: ' + url))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.clearAllMocks()
  withCredits = false
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
})

describe('/admin/tds-payouts — visibility payout TDS report', () => {
  it('CLIENT_ADMIN report fetch is tenant-scoped — no clientId param', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = stubFetch()
    render(<AdminTdsPayoutsPage />)

    await screen.findByText('Shop A')
    const reportCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/payouts') && !(c[0] as string).includes('/export'),
    )
    expect(reportCall![0] as string).toBe('/api/admin/tds-reports/payouts')
  })

  it('renders section, methodology and GST-reg-type columns', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch()
    render(<AdminTdsPayoutsPage />)

    await screen.findByText('Shop A')
    expect(screen.getByText('SEC_194C')).toBeInTheDocument()   // frozen section
    expect(screen.getByText('Gross-up')).toBeInTheDocument()   // methodology label
    expect(screen.getByText('REGULAR')).toBeInTheDocument()    // GST reg type badge
  })

  it('GIFSY: report GET is clientId-free; selecting a tenant scopes the EXPORT url', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<AdminTdsPayoutsPage />)

    await screen.findByText('Shop A')
    // The report GET itself never carries a clientId (server-scoped from the JWT).
    const reportCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/payouts') && !(c[0] as string).includes('/export'),
    )
    expect(reportCall![0] as string).toBe('/api/admin/tds-reports/payouts')

    // Pick the tenant in the GIFSY-only client dropdown (first combobox), then export.
    const [clientSelect] = screen.getAllByRole('combobox')
    fireEvent.change(clientSelect, { target: { value: 'deoleo' } })
    fireEvent.click(screen.getByText('Export Excel'))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(
      fetchMock.mock.calls.some(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/payouts/export') && (c[0] as string).includes('clientId=deoleo'),
      ),
    ).toBe(true)
  })

  it('CLIENT_ADMIN export url carries no clientId', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = stubFetch()
    render(<AdminTdsPayoutsPage />)

    await screen.findByText('Shop A')
    fireEvent.click(screen.getByText('Export Excel'))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    const exportCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/payouts/export'),
    )
    expect(exportCall![0] as string).not.toContain('clientId')
  })

  it('policy round B: TDS credits from reversed payouts — created / adjusted / still to adjust, every use listed (PAN masked)', async () => {
    asRole('CLIENT_ADMIN')
    withCredits = true
    stubFetch()
    render(<AdminTdsPayoutsPage />)
    const panel = await screen.findByTestId('tds-credits-panel')
    expect(panel.textContent).toContain('TDS credits from reversed payouts')
    expect(panel.textContent).toContain('PAN XXXXX1234F · SEC_194C · FY 2026-27')
    expect(panel.textContent).not.toContain('ABCDE1234F')
    expect(panel.textContent).toContain('Shop Reversed (2026-10)')
    expect(panel.textContent).toMatch(/Still to adjust/)
    expect(panel.textContent).toContain('adjusted from this credit against the TDS of Shop Next (2026-11)')
    expect(panel.textContent).toContain('had been adjusted on Shop Failed (2026-11) — returned, that payout did not go through')
  })

  it('no TDS credits → no credits panel (unchanged page)', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch()
    render(<AdminTdsPayoutsPage />)
    await screen.findByText('Shop A')
    expect(screen.queryByTestId('tds-credits-panel')).toBeNull()
  })

  it('fix round B: rows show reversedNote / tdsNote / clientName', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/admin/tds-reports/payouts')) {
        const data = report()
        data.rows = [{
          ...ROW,
          clientName: 'Deoleo India',
          reversedNote: '₹5,000.00 reversed on 16 Nov 2026 — off the PAN\'s TDS base; ₹4,500.00 owed back',
          tdsCreditAppliedPaise: 20000,
          tdsNote: '₹200.00 less TDS — covered by a TDS credit',
        } as typeof ROW]
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) })
      }
      return Promise.reject(new Error('unexpected fetch in test: ' + url))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AdminTdsPayoutsPage />)
    await screen.findByText('Shop A')
    expect(screen.getAllByText('Deoleo India').length).toBeGreaterThan(0) // tenant cell + filter option
    expect(screen.getByTestId('tds-row-reversed-note').textContent).toContain('₹5,000.00 reversed on 16 Nov 2026')
    expect(screen.getByTestId('tds-row-tds-note').textContent).toBe('₹200.00 less TDS — covered by a TDS credit')
  })

  it('fix round B (#21): TDS credits panel — server pagination, filters passed, clientName, masked PAN, scope / unused / previous-PAN notes', async () => {
    asRole('GIFSY_ADMIN')
    const credit = (id: string, extra: Record<string, unknown> = {}) => ({
      creditId: id, clientId: 'bajaj', clientName: 'Bajaj Consumer Care', panNumber: 'ABCDE1234F', panMasked: 'XXXXX1234F',
      section: '194C', fyLabel: '2026-27', createdAt: '2026-11-10T00:00:00.000Z', sourceOutletCode: 'O1',
      sourceOutletName: `Shop ${id}`, sourcePeriod: '2026-10', credit: M(40000), applied: M(0), outstanding: M(40000),
      scopeNote: 'Scoped to FY 2026-27 · 194C · usable by any programme on this PAN', unusedNote: null, previousPanNote: null,
      applications: [], ...extra,
    })
    const creditsFor = (page: number) => ({
      count: 30,
      totals: { created: M(1200000), applied: M(31000), outstanding: M(1169000) },
      pagination: { page, limit: 25, total: 30, pages: 2 },
      notes: ['₹500.00 unused credit for FY 2025-26, not carried forward'],
      rows: page === 1
        ? [credit('c1', {
            unusedNote: '₹500.00 unused credit for FY 2025-26, not carried forward',
            previousPanNote: 'Credit on previous PAN XXXXX9999Z — not applied automatically',
            applications: [{ applicationId: 'a1', appliedAt: '2026-11-12T00:00:00.000Z', amount: M(31000), outletName: 'Other Shop', period: '2026-11', released: false, releaseReason: null, otherProgramme: true, note: 'Used against another programme on this PAN (194C)' }],
          })]
        : [credit('c26')],
    })
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/admin/tds-reports/payouts')) {
        const q = new URL(url, 'http://x').searchParams
        const data = { ...report(), tdsCredits: creditsFor(Number(q.get('creditPage') ?? 1)) }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) })
      }
      return Promise.reject(new Error('unexpected fetch in test: ' + url))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AdminTdsPayoutsPage />)
    const panel = await screen.findByTestId('tds-credits-panel')
    // initial report GET unchanged (no params); page 1 of credits comes with it
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/tds-reports/payouts')
    expect(panel.textContent).toContain('Bajaj Consumer Care · PAN XXXXX1234F · 194C · FY 2026-27')
    expect(panel.textContent).not.toContain('ABCDE1234F')
    expect(panel.textContent).not.toMatch(/\bbajaj ·/)
    expect(panel.textContent).toContain('Scoped to FY 2026-27 · 194C · usable by any programme on this PAN')
    expect(panel.textContent).toContain('Credit on previous PAN XXXXX9999Z — not applied automatically')
    expect(within(screen.getByTestId('tds-credit-c1')).getByText('₹500.00 unused credit for FY 2025-26, not carried forward')).toBeTruthy()
    expect(panel.textContent).toContain('another programme')
    expect(panel.textContent).toContain('Used against another programme on this PAN (194C)')
    expect(screen.getByTestId('tds-credits-range').textContent).toMatch(/Page 1 of 2 · 30 credits/)

    fireEvent.click(within(panel).getByRole('button', { name: 'Next' }))
    await screen.findByTestId('tds-credit-c26')
    const pageCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.includes('creditPage=2'))!
    expect(pageCall).toContain('creditLimit=25')
    expect(pageCall).not.toContain('clientId')

    // a tenant filter goes back to credit page 1 and is passed to the server
    const [clientSelect] = screen.getAllByRole('combobox')
    fireEvent.change(clientSelect, { target: { value: 'deoleo' } })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes('creditPage=1') && (c[0] as string).includes('clientId=deoleo'))).toBe(true),
    )
    await screen.findByTestId('tds-credit-c1')
  })

  it('fix round B: CLIENT_ADMIN credit paging never sends a clientId', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = vi.fn((url: string) => {
      const q = new URL(url, 'http://x').searchParams
      const page = Number(q.get('creditPage') ?? 1)
      const data = {
        ...report(),
        tdsCredits: {
          count: 2, totals: { created: M(2), applied: M(0), outstanding: M(2) },
          pagination: { page, limit: 1, total: 2, pages: 2 },
          rows: [{
            creditId: `c${page}`, clientId: 'bajaj', clientName: 'Bajaj', panNumber: 'ABCDE1234F', panMasked: 'XXXXX1234F', section: '194R',
            fyLabel: '2026-27', createdAt: '', sourceOutletCode: null, sourceOutletName: null, sourcePeriod: null,
            credit: M(1), applied: M(0), outstanding: M(1), applications: [],
          }],
        },
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AdminTdsPayoutsPage />)
    const panel = await screen.findByTestId('tds-credits-panel')
    fireEvent.click(within(panel).getByRole('button', { name: 'Next' }))
    await screen.findByTestId('tds-credit-c2')
    expect(fetchMock.mock.calls.every((c) => !(c[0] as string).includes('clientId'))).toBe(true)
  })

  it('renders the error card when the report fetch fails', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ fail: true })
    render(<AdminTdsPayoutsPage />)
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
