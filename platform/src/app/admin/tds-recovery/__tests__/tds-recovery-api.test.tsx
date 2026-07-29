/// <reference types="vitest/globals" />
/**
 * /admin/tds-recovery — TDS liability + tenant-wise recovery / attribution report.
 *
 * Backend contract:
 *   GET /api/admin/tds-reports/recovery[?clientId=&fy=]  (CLIENT_ADMIN own · GIFSY any)
 *   GET /api/admin/tds-reports/recovery/export           → xlsx
 *
 * Covered:
 *  - CLIENT_ADMIN: the fetch URL is tenant-scoped — NO clientId param is ever sent.
 *  - GIFSY_ADMIN: typing a clientId scopes the fetch (?clientId=).
 *  - Export triggers a blob download (URL.createObjectURL).
 *  - isNoPan rows are labelled "No PAN".
 *  - error card on a failed fetch (no fabricated values).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/tds-recovery',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>()
  return { ...actual, useAdminSession: vi.fn() }
})

import { useAdminSession } from '@/lib/admin-session'
import TdsRecoveryPage from '../page'

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

function makeReport(rows: unknown[]) {
  return {
    label: 'in lieu of TDS deduction',
    scope: { clientId: null, fy: null },
    count: rows.length,
    totals: {
      tenantShare: { paise: '500000', inr: 5000 },
      noPanTenantShare: { paise: '100000', inr: 1000 },
    },
    rows,
  }
}

const ROW_WITH_PAN = {
  clientId: 'deoleo',
  panNumber: 'ABCDE1234F',
  isNoPan: false,
  section: 'SEC_194C',
  fyLabel: '2026-27',
  tdsInvoiceId: 'ti1',
  panTdsTotal: { paise: '500000', inr: 5000 },
  tenantBase: { paise: '4000000', inr: 40000 },
  panBase: { paise: '8000000', inr: 80000 },
  tenantShare: { paise: '400000', inr: 4000 },
  createdAt: '2026-07-15T00:00:00.000Z',
}
const ROW_NO_PAN = {
  ...ROW_WITH_PAN,
  panNumber: '__NO_PAN__:OUT-9',
  isNoPan: true,
  tenantShare: { paise: '100000', inr: 1000 },
}

function stubFetch(opts: { rows?: unknown[]; fail?: boolean } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/admin/tds-reports/recovery/export')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'attachment; filename="tds-recovery-all.xlsx"' },
        blob: () => Promise.resolve(new Blob(['x'])),
      })
    }
    if (url.startsWith('/api/admin/tds-reports/recovery')) {
      if (opts.fail) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: makeReport(opts.rows ?? [ROW_WITH_PAN]) }) })
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

describe('/admin/tds-recovery — recovery / attribution report', () => {
  it('CLIENT_ADMIN fetches tenant-scoped — no clientId param is sent', async () => {
    asRole('CLIENT_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRecoveryPage />)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/recovery')),
      ).toBe(true),
    )
    // Every recovery fetch a tenant admin makes must be free of a clientId query.
    const recoveryCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/recovery'),
    )
    for (const c of recoveryCalls) expect(c[0] as string).not.toContain('clientId')
    // The tenant-scoped page also never renders the clientId filter input.
    expect(screen.queryByPlaceholderText('Client ID (optional)')).not.toBeInTheDocument()
  })

  it('GIFSY scopes the fetch with a clientId filter when one is typed', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRecoveryPage />)

    fireEvent.change(screen.getByPlaceholderText('Client ID (optional)'), { target: { value: 'deoleo' } })

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes('clientId=deoleo')),
      ).toBe(true),
    )
  })

  it('export triggers a blob download', async () => {
    asRole('GIFSY_ADMIN')
    const fetchMock = stubFetch()
    render(<TdsRecoveryPage />)

    await screen.findByText('ABCDE1234F')
    fireEvent.click(screen.getByText('Export Excel'))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(
      fetchMock.mock.calls.some(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/tds-reports/recovery/export'),
      ),
    ).toBe(true)
  })

  it('labels No-PAN rows', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ rows: [ROW_NO_PAN] })
    render(<TdsRecoveryPage />)
    expect(await screen.findByText('No PAN')).toBeInTheDocument()
  })

  it('shows an error card on a failed fetch (never fabricates)', async () => {
    asRole('GIFSY_ADMIN')
    stubFetch({ fail: true })
    render(<TdsRecoveryPage />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
