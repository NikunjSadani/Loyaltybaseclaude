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
 *  - SERVER PAGING: "Showing 1–50 of 48,086", Next/Previous fetch page=2/1, page-size select,
 *    a filter change resets to page 1, whole-range totals label, the export never carries
 *    page params, and there is no "first 10,000" truncation banner any more.
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
  failureReason: null,
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
    page: 1,
    pageSize: 50,
    totalRows: 1,
    totalPages: 1,
    count: 1,
    totals: { count: 1, amount: { paise: '1000000', inr: 10000 }, tdsDeducted: { paise: '20000', inr: 200 } },
    rows: [ROW],
  }
}

/** A server page of the 48,086-payment Bajaj-sized range: `pageSize` rows for `page`, whole-range totals. */
function pagedReport(url: string, totalRows = 48_086) {
  const q = new URL(url, 'http://x').searchParams
  const requested = Number(q.get('page') ?? 1)
  const pageSize = Number(q.get('pageSize') ?? 50)
  const totalPages = Math.ceil(totalRows / pageSize)
  const page = Math.min(requested, Math.max(1, totalPages)) // the API clamps a page past the end
  const start = (page - 1) * pageSize
  const n = Math.max(0, Math.min(pageSize, totalRows - start))
  return {
    scope: { clientId: null },
    page,
    pageSize,
    totalRows,
    totalPages,
    count: totalRows,
    totals: {
      count: totalRows,
      amount: { paise: '28900000000', inr: 289000000 },
      tdsDeducted: { paise: '12345600', inr: 123456 },
    },
    rows: Array.from({ length: n }, (_, i) => ({ ...ROW, outletCode: `OUT-${start + i + 1}`, outletName: `Shop ${start + i + 1}` })),
  }
}

type Responder = (url: string) => { fail?: string; data?: unknown } | undefined

function stubPagedFetch(respond?: Responder) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/admin/payments-report/export')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'attachment; filename="payments-report.xlsx"' },
        blob: () => Promise.resolve(new Blob(['x'])),
      })
    }
    if (url.startsWith('/api/admin/payments-report')) {
      const custom = respond?.(url)
      if (custom?.fail) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: custom.fail }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: custom?.data ?? pagedReport(url) }) })
    }
    return Promise.reject(new Error('unexpected fetch in test: ' + url))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const reportCalls = (m: ReturnType<typeof vi.fn>) =>
  m.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/api/admin/payments-report') && !u.includes('/export'))
const lastReportUrl = (m: ReturnType<typeof vi.fn>) => new URL(reportCalls(m).at(-1)!, 'http://x').searchParams

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
    expect(await screen.findByText('Biz Pvt Ltd')).toBeInTheDocument()
    expect(await screen.findByText('TSE > ASM > RSM')).toBeInTheDocument()   // reporting chain
    expect(await screen.findByText('UTR12345')).toBeInTheDocument()          // UTR
    // 'PAID' appears both as a status <option> and the row badge — assert at least one.
    expect((await screen.findAllByText('PAID')).length).toBeGreaterThan(0)     // status badge
    expect(await screen.findByText('SEC_194C')).toBeInTheDocument()          // TDS section
    expect(await screen.findByText('ABCDE1234F')).toBeInTheDocument()        // PAN
  })

  it('renders the Failure Reason column for a FAILED row (empty on PAID)', async () => {
    asRole('GIFSY_ADMIN')
    const failedRow = {
      ...ROW,
      status: 'FAILED',
      paymentDate: '2026-07-20T00:00:00.000Z', // from attemptedAt (service maps paidAt ?? attemptedAt)
      utr: 'UTR-FAIL',
      failureReason: 'Account Closed',
    }
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/admin/payments-report')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { ...report(), totals: { count: 1, amount: { paise: '0', inr: 0 }, tdsDeducted: { paise: '0', inr: 0 } }, rows: [failedRow] } }),
        })
      }
      return Promise.reject(new Error('unexpected fetch in test: ' + url))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AdminPaymentsReportPage />)
    await screen.findByText('Shop A')
    // The captured bank reason renders in the new Failure Reason column.
    expect(await screen.findByText('Account Closed')).toBeInTheDocument()
    expect(await screen.findByText('UTR-FAIL')).toBeInTheDocument() // UTR kept on FAILED
  })

  it('B-L6: a payout settled by TDS withholding is labelled in the UTR column (no UTR)', async () => {
    asRole('GIFSY_ADMIN')
    const withheldRow = { ...ROW, utr: null, settledByTds: true, tdsSection: 'SEC_194R' }
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url.startsWith('/api/admin/payments-report')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { ...report(), rows: [withheldRow] } }) })
        : Promise.reject(new Error('unexpected fetch in test: ' + url)),
    ))
    render(<AdminPaymentsReportPage />)
    await screen.findByText('Shop A')
    expect(await screen.findByTestId('payment-settled-by-tds')).toHaveTextContent('Settled by TDS withholding (no bank payment)')
    expect(screen.queryByText('UTR12345')).not.toBeInTheDocument()
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

  describe('server-side paging', () => {
    it('shows "Showing 1–50 of 48,086", requests page=1&pageSize=50, and labels the totals as the whole range', async () => {
      asRole('CLIENT_ADMIN')
      const fetchMock = stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 1–50 of 48,086')
      expect(lastReportUrl(fetchMock).get('page')).toBe('1')
      expect(lastReportUrl(fetchMock).get('pageSize')).toBe('50')
      // Only the page's rows are rendered — never the whole range.
      expect(await screen.findByText('Shop 50')).toBeInTheDocument()
      expect(screen.queryByText('Shop 51')).not.toBeInTheDocument()
      // Totals are the whole range, and say so.
      expect(await screen.findByText('Totals for the selected filters — all pages')).toBeInTheDocument()
      expect(await screen.findByText('48,086')).toBeInTheDocument()
      expect(await screen.findByText('₹28,90,00,000.00')).toBeInTheDocument()
      expect(await screen.findByText('₹1,23,456.00')).toBeInTheDocument()
      expect(await screen.findByText(/Page 1 of 962/)).toBeInTheDocument()
      // Previous is disabled on page 1.
      expect(await screen.findByRole('button', { name: /Previous/ })).toBeDisabled()
    })

    it('Next fetches page 2 ("Showing 51–100"), Previous goes back to page 1', async () => {
      asRole('CLIENT_ADMIN')
      const fetchMock = stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      expect(lastReportUrl(fetchMock).get('page')).toBe('2')
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 51–100 of 48,086')
      await waitFor(() => expect(screen.getByRole('button', { name: /Previous/ })).not.toBeDisabled())
      fireEvent.click(screen.getByRole('button', { name: /Previous/ }))
      await screen.findByText('Shop 1')
      expect(lastReportUrl(fetchMock).get('page')).toBe('1')
    })

    it('the page-size select asks for 200 rows and returns to page 1', async () => {
      asRole('CLIENT_ADMIN')
      const fetchMock = stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '200' } })
      await screen.findByText('Shop 200')
      expect(lastReportUrl(fetchMock).get('pageSize')).toBe('200')
      expect(lastReportUrl(fetchMock).get('page')).toBe('1')
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 1–200 of 48,086')
    })

    it('a filter change resets to page 1', async () => {
      asRole('CLIENT_ADMIN')
      const fetchMock = stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      expect(lastReportUrl(fetchMock).get('page')).toBe('2')
      fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'FAILED' } })
      await waitFor(() => expect(lastReportUrl(fetchMock).get('status')).toBe('FAILED'))
      expect(lastReportUrl(fetchMock).get('page')).toBe('1')
      // No request ever asked for page 2 of the NEW filter.
      expect(reportCalls(fetchMock).some((u) => u.includes('status=FAILED') && u.includes('page=2'))).toBe(false)
      await screen.findByText('Shop 1')
    })

    it('the export carries the filters but never page/pageSize (the file is the whole range)', async () => {
      asRole('CLIENT_ADMIN')
      const fetchMock = stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      fireEvent.click(screen.getByText('Export Excel'))
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
      const exportUrl = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.startsWith('/api/admin/payments-report/export'))!
      expect(exportUrl).toContain('from=')
      expect(exportUrl).not.toContain('page=')
      expect(exportUrl).not.toContain('pageSize=')
    })

    it('no "first 10,000" / narrow-the-range banner, even for a 48k-row range', async () => {
      asRole('GIFSY_ADMIN')
      stubPagedFetch()
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      expect(screen.queryByText(/narrow the date range/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/first 10,?000/i)).not.toBeInTheDocument()
    })

    it('Next is disabled on the last page', async () => {
      asRole('CLIENT_ADMIN')
      stubPagedFetch((url) => ({ data: pagedReport(url, 120) }))
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      await waitFor(() => expect(screen.getByRole('button', { name: /Next/ })).not.toBeDisabled())
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 120')
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 101–120 of 120')
      expect(await screen.findByText(/Page 3 of 3/)).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: /Next/ })).toBeDisabled()
      expect(await screen.findByRole('button', { name: /Previous/ })).not.toBeDisabled()
    })

    it('a page past the end is clamped by the server: the pager follows the EFFECTIVE page (no "Page 9 of 5")', async () => {
      asRole('CLIENT_ADMIN')
      // The range shrank to 40 rows between loads: the page-2 request comes back clamped to page 1 of 1.
      stubPagedFetch((url) => (url.includes('page=2') ? { data: pagedReport(url, 40) } : undefined))
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await waitFor(() => expect(screen.getByTestId('payments-range')).toHaveTextContent('Showing 1–40 of 40'))
      expect(await screen.findByText(/Page 1 of 1/)).toBeInTheDocument()
      expect(screen.queryByText('No payments match your filters')).not.toBeInTheDocument()
      expect(await screen.findByRole('button', { name: /Next/ })).toBeDisabled()
      expect(await screen.findByRole('button', { name: /Previous/ })).toBeDisabled()
    })

    it('rows=[] with totalRows>0 shows a loading state, never "No payments match"', async () => {
      asRole('CLIENT_ADMIN')
      stubPagedFetch((url) => ({ data: { ...pagedReport(url), rows: [] } }))
      render(<AdminPaymentsReportPage />)
      expect(await screen.findByText('Loading payments…')).toBeInTheDocument()
      expect(screen.queryByText('No payments match your filters')).not.toBeInTheDocument()
    })

    it('a FAILED page load keeps the pager on the page on screen, and Retry loads it', async () => {
      asRole('CLIENT_ADMIN')
      let failPage2 = true
      const fetchMock = stubPagedFetch((url) => (url.includes('page=2') && failPage2 ? { fail: 'Server busy' } : undefined))
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      expect(await screen.findByText('Server busy')).toBeInTheDocument()
      // The table and pager still describe page 1 (what is on screen) — Previous stays off, Next targets page 2 again.
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 1–50 of 48,086')
      expect(await screen.findByText(/Page 1 of 962/)).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: /Previous/ })).toBeDisabled()
      expect(await screen.findByRole('button', { name: /Next/ })).not.toBeDisabled()
      // Same filters → the totals label is NOT the "previous filters" one.
      expect(await screen.findByTestId('payments-totals-label')).toHaveTextContent('Totals for the selected filters — all pages')
      failPage2 = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText('Shop 51')
      expect(lastReportUrl(fetchMock).get('page')).toBe('2')
      expect(screen.queryByText('Server busy')).not.toBeInTheDocument()
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 51–100 of 48,086')
    })

    it('Next after a failed page load still asks for the next page (not a skip to page 3)', async () => {
      asRole('CLIENT_ADMIN')
      let failPage2 = true
      const fetchMock = stubPagedFetch((url) => (url.includes('page=2') && failPage2 ? { fail: 'Server busy' } : undefined))
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Server busy')
      failPage2 = false
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      expect(reportCalls(fetchMock).some((u) => u.includes('page=3'))).toBe(false)
    })

    it('a FAILED filter change relabels the totals as the previous filters and turns paging off', async () => {
      asRole('CLIENT_ADMIN')
      stubPagedFetch((url) => (url.includes('status=FAILED') ? { fail: 'Timed out' } : undefined))
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      expect(await screen.findByTestId('payments-totals-label')).toHaveTextContent('Totals for the selected filters — all pages')
      fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'FAILED' } })
      expect(await screen.findByText('Timed out')).toBeInTheDocument()
      expect(await screen.findByTestId('payments-totals-label')).toHaveTextContent('Showing the previous filters — the new filters failed to load')
      expect(await screen.findByText('The figures below are still for the previous filters.')).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: /Next/ })).toBeDisabled()
      expect(await screen.findByRole('button', { name: /Previous/ })).toBeDisabled()
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('while a filter change is in flight the totals + table are marked busy and labelled as updating', async () => {
      asRole('CLIENT_ADMIN')
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => (release = r))
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('status=PAID')) await gate
        return { ok: true, json: () => Promise.resolve({ success: true, data: pagedReport(url) }) }
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'PAID' } })
      await waitFor(() => expect(screen.getByTestId('payments-totals-label')).toHaveTextContent('Updating for the new filters…'))
      expect(await screen.findByRole('region', { name: 'Payment totals' })).toHaveAttribute('aria-busy', 'true')
      expect((await screen.findAllByRole('status')).length).toBeGreaterThan(0)
      release()
      await waitFor(() => expect(screen.getByTestId('payments-totals-label')).toHaveTextContent('Totals for the selected filters — all pages'))
    })

    it('GIFSY_ADMIN: paging works with the Tenant column on every page', async () => {
      asRole('GIFSY_ADMIN')
      stubPagedFetch((url) => {
        const d = pagedReport(url)
        return { data: { ...d, rows: d.rows.map((r) => ({ ...r, clientId: 'bajaj' })) } }
      })
      render(<AdminPaymentsReportPage />)
      await screen.findByText('Shop 1')
      expect(await screen.findByRole('columnheader', { name: 'Tenant' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      await screen.findByText('Shop 51')
      expect(await screen.findByRole('columnheader', { name: 'Tenant' })).toBeInTheDocument()
      expect(await screen.findAllByText('bajaj')).toHaveLength(50)
      expect(await screen.findByTestId('payments-range')).toHaveTextContent('Showing 51–100 of 48,086')
    })
  })
})
