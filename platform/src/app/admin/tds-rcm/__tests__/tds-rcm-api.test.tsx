/// <reference types="vitest/globals" />
/**
 * /admin/tds-rcm — unregistered-retailer / RCM source report (Wave 2 Stream E, D6).
 *
 * Backend contract:
 *   GET /api/admin/tds-reports/unregistered[?clientId=&period=]  (GIFSY_ADMIN only)
 *   GET /api/admin/tds-reports/unregistered/export               → xlsx
 *
 * Covered:
 *  - GIFSY_ADMIN: fetches the unregistered list + renders rows / money (formatINR).
 *  - CLIENT_ADMIN: sees the access hint and NEVER fetches (GIFSY-only surface).
 *  - Export triggers a blob download (URL.createObjectURL + export endpoint).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/tds-rcm',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>()
  return { ...actual, useAdminSession: vi.fn() }
})

import { useAdminSession } from '@/lib/admin-session'
import TdsRcmPage from '../page'

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

const REPORT = {
  scope: { clientId: null, period: null },
  note: 'RCM is computed off-portal by TGSL from this list (D6).',
  count: 1,
  totals: { subtotal: { paise: '1500000', inr: 15000 } },
  rows: [
    {
      clientId: 'deoleo',
      invoiceNumber: 'INV-U-1',
      invoiceKind: 'SERVICE',
      partnerId: 'p1',
      businessName: 'Kirana Store',
      ownerName: 'Ravi',
      panNumber: null,
      outletCode: 'OUT-9',
      period: '2026-07',
      invoiceDate: '2026-07-15T00:00:00.000Z',
      subtotal: { paise: '1500000', inr: 15000 },
      gst: { paise: '0', inr: 0 },
      total: { paise: '1500000', inr: 15000 },
    },
  ],
}

/** GET → the report (or a failure); export → an xlsx blob. */
function stubFetch(opts: { fail?: boolean } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/admin/tds-reports/unregistered/export')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'attachment; filename="unregistered-rcm-all.xlsx"' },
        blob: () => Promise.resolve(new Blob(['x'])),
      })
    }
    if (url.startsWith('/api/admin/tds-reports/unregistered')) {
      if (opts.fail) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: REPORT }) })
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

describe('/admin/tds-rcm — unregistered / RCM report', () => {
  it('GIFSY fetches the unregistered list and renders rows + money', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRcmPage />)

    expect(await screen.findByText('INV-U-1')).toBeInTheDocument()
    // Money via formatINR (paise → ₹) — subtotal cell + summary card.
    expect((await screen.findAllByText('₹15,000.00')).length).toBeGreaterThan(0)

    const listCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/unregistered') && !(c[0] as string).includes('/export'),
    )
    expect(listCall).toBeTruthy()
  })

  it('CLIENT_ADMIN sees the access hint and never fetches', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRcmPage />)

    expect(screen.getByTestId('tds-rcm-denied')).toBeInTheDocument()
    // Pass the 250ms debounce window; a non-GIFSY session must not fire the data fetch.
    await new Promise((r) => setTimeout(r, 300))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GIFSY export triggers a blob download from the export endpoint', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRcmPage />)

    await screen.findByText('INV-U-1')
    fireEvent.click(screen.getByText('Export Excel'))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(
      fetchMock.mock.calls.some(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/unregistered/export'),
      ),
    ).toBe(true)
  })

  it('shows an error card when the report fetch fails (never fabricates)', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ fail: true })
    render(<TdsRcmPage />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.queryByText('INV-U-1')).not.toBeInTheDocument()
  })
})
