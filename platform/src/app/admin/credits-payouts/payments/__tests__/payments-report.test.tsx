/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payments — Payments Report (all payout streams).
 *
 * Backend contract:
 *   GET /api/admin/payments-report?from=&to=&status=&clientId=  (CLIENT_ADMIN own · GIFSY any)
 *   GET /api/admin/payments-report/export?from=&to=&status=&clientId=  → xlsx
 *
 * Unlike the fetch-once tds-payouts sibling, filters (date range / status / clientId)
 * are pushed to the API, so any filter change REFETCHES.
 *
 * Covered:
 *  - renders rows from a mocked client response (full sales chain + extras).
 *  - the Export button fetches the export URL carrying the current filters.
 *  - a date-range change refetches the report with the new `to` param.
 *  - CLIENT_ADMIN never sends a clientId (server pins scope).
 *  - the error path renders the error card.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/payments',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>()
  return { ...actual, useAdminSession: vi.fn() }
})

import { useAdminSession } from '@/lib/admin-session'
import AdminPaymentsReportPage from '../page'

type Role = 'GIFSY_ADMIN' | 'CLIENT_ADMIN'

function asRole(role: Role) {
  vi.mocked(useAdminSession).mockReturnValue({
    role,
    clientId: role === 'GIFSY_ADMIN' ? 'gifsy' : 'deoleo',
    name: 'Test Admin',
    userId: '',
    canManageSchemes: role === 'GIFSY_ADMIN',
  })
}

const ROW = {
  clientId: 'deoleo',
  paymentDate: '2026-07-15T10:30:00.000Z',
  outletCode: 'OUT-9',
  outletName: 'Shop A',
  businessName: 'Biz Pvt Ltd',
  ownerName: 'Ravi Kumar',
  zone: 'West',
  state: 'Maharashtra',
  city: 'Pune',
  salesRepCode: 'SR-1',
  salesRepName: 'Anil Rep',
  salesRepRole: 'TSE',
  reportingChain: 'TSE > ASM > RSM',
  amount: { paise: '1000000', inr: 10000 },
  utr: 'UTR12345',
  status: 'PAID',
  payoutHeader: 'BATCH-07',
  groupType: 'INDIVIDUAL',
  payoutField: 'visibility',
  remarks: 'ok',
  period: '2026-07',
  tdsSection: 'SEC_194C',
  tdsMethodology: 'GROSS_UP',
  tdsDeducted: { paise: '20000', inr: 200 },
  invoiceNumber: 'INV-1',
  gstRegistrationType: 'REGULAR',
  panNumber: 'ABCDE1234F',
  phone: '9800011111',
}

function report() {
  return {
    scope: { clientId: null },
    count: 1,
    totals: { amount: { paise: '1000000', inr: 10000 } },
    rows: [ROW],
  }
}

function stubFetch(opts: { fail?: boolean } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/admin/payments-report/export')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'attachment; filename="payments-report.xlsx"' },
        blob: () => Promise.resolve(new Blob(['x'])),
      })
    }
    if (url.startsWith('/api/admin/payments-report')) {
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
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
})

describe('/admin/credits-payouts/payments — Payments Report', () => {
  it('renders rows from the mocked client response (sales chain + extras)', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch()
    render(<AdminPaymentsReportPage />)

    await screen.findByText('Shop A')
    expect(screen.getByText('Biz Pvt Ltd')).toBeInTheDocument()
    expect(screen.getByText('TSE > ASM > RSM')).toBeInTheDocument()   // reporting chain
    expect(screen.getByText('UTR12345')).toBeInTheDocument()          // UTR
    // 'PAID' appears both as a status <option> and the row badge — assert at least one.
    expect(screen.getAllByText('PAID').length).toBeGreaterThan(0)     // status badge
    expect(screen.getByText('SEC_194C')).toBeInTheDocument()          // TDS section
    expect(screen.getByText('ABCDE1234F')).toBeInTheDocument()        // PAN
  })

  it('Export button fetches the export URL carrying the current filters', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<AdminPaymentsReportPage />)

    await screen.findByText('Shop A')

    // Set a status filter, then export — the export URL must carry it.
    fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'PAID' } })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('status=PAID') && !(c[0] as string).includes('/export'),
        ),
      ).toBe(true),
    )

    fireEvent.click(screen.getByText('Export Excel'))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          (c[0] as string).startsWith('/api/admin/payments-report/export') &&
          (c[0] as string).includes('status=PAID'),
      ),
    ).toBe(true)
  })

  it('a date-range change refetches the report with the new `to` param', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    const { container } = render(<AdminPaymentsReportPage />)

    await screen.findByText('Shop A')
    const before = fetchMock.mock.calls.length

    // Two date inputs (From, To) — pick the second (To).
    const dateInputs = container.querySelectorAll('input[type="date"]')
    fireEvent.change(dateInputs[1], { target: { value: '2026-08-31' } })

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('to=2026-08-31') && !(c[0] as string).includes('/export'),
        ),
      ).toBe(true),
    )
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('CLIENT_ADMIN never sends a clientId (server pins scope)', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = stubFetch()
    render(<AdminPaymentsReportPage />)

    await screen.findByText('Shop A')
    // No Client ID input is rendered for CLIENT_ADMIN, and no report/export call carries clientId.
    expect(
      fetchMock.mock.calls.every(
        (c) => typeof c[0] !== 'string' || !(c[0] as string).includes('clientId='),
      ),
    ).toBe(true)
  })

  it('renders the error card when the report fetch fails', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ fail: true })
    render(<AdminPaymentsReportPage />)
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
