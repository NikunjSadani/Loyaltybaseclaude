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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    clientId: role === 'GIFSY_ADMIN' ? 'gifsy' : 'deoleo',
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

function report() {
  return {
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

  it('renders the error card when the report fetch fails', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ fail: true })
    render(<AdminTdsPayoutsPage />)
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
