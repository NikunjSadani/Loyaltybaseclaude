/// <reference types="vitest/globals" />
/**
 * /admin/gst-reimbursements — GIFSY-only GST-holdback release queue (Wave 2 Stream E, D5).
 *
 * Backend contract:
 *   GET  /api/admin/gst-reimbursements?status=HELD&clientId=&period=
 *   POST /api/admin/gst-reimbursements/:id/release  { proofUrl, releasePayoutRef, notes? }
 *        → 200 HELD→RELEASED · 409 already released (idempotent)
 *
 * Covered:
 *  - GIFSY_ADMIN: sees the HELD list (money via formatINR); the GET carries status=HELD.
 *  - CLIENT_ADMIN: gated card + NO data fetch.
 *  - Release POSTs { proofUrl, releasePayoutRef } to /:id/release.
 *  - a 409 "already released" is handled (queue refreshes, no crash).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/gst-reimbursements',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>()
  return { ...actual, useAdminSession: vi.fn() }
})

import { useAdminSession } from '@/lib/admin-session'
import GstReimbursementsPage from '../page'

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

const HELD_ITEM = {
  id: 'r1',
  clientId: 'deoleo',
  autoInvoiceId: 'ai1',
  invoiceNumber: 'INV-GST-1',
  period: '2026-07',
  gstType: 'CGST_SGST',
  partnerId: 'p1',
  outletCode: 'OUT-9',
  status: 'HELD',
  gst: { paise: '250000', inr: 2500 },
  proofUrl: null,
  releasePayoutRef: null,
  releasedAt: null,
  releasedById: null,
  notes: null,
  createdAt: '2026-07-15T00:00:00.000Z',
}

function listResponse() {
  return {
    status: 'HELD',
    clientId: null,
    period: null,
    count: 1,
    totalGst: { paise: '250000', inr: 2500 },
    items: [HELD_ITEM],
  }
}

/** Records POSTs; GET returns the HELD list. `releaseStatus` sets the POST HTTP result. */
function stubFetch(opts: { releaseOk?: boolean; releaseError?: string } = {}) {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/release') && init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) })
      if (opts.releaseOk === false) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: opts.releaseError ?? 'This reimbursement was already released' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { ...HELD_ITEM, status: 'RELEASED' } }) })
    }
    if (url.startsWith('/api/admin/gst-reimbursements')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: listResponse() }) })
    }
    return Promise.reject(new Error('unexpected fetch in test: ' + url))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, posts }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/admin/gst-reimbursements — GST-holdback release queue', () => {
  it('GIFSY sees the HELD list with money via formatINR and a status=HELD GET', async () => {
    asRole('GIFSY_ADMIN')
    const { fetchMock } = stubFetch()
    render(<GstReimbursementsPage />)

    expect(await screen.findByText('INV-GST-1')).toBeInTheDocument()
    expect((await screen.findAllByText('₹2,500.00')).length).toBeGreaterThan(0)

    const getCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/gst-reimbursements') && !(c[0] as string).includes('/release'),
    )
    expect(getCall).toBeTruthy()
    expect(getCall![0] as string).toContain('status=HELD')
  })

  it('CLIENT_ADMIN sees the gated card and never fetches', async () => {
    asRole('CLIENT_ADMIN')
    const { fetchMock } = stubFetch()
    render(<GstReimbursementsPage />)

    expect(screen.getByText(/only available to Gifsy Platform Admins/i)).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 300))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Release POSTs { proofUrl, releasePayoutRef } to /:id/release', async () => {
    asRole('GIFSY_ADMIN')
    const { posts } = stubFetch()
    render(<GstReimbursementsPage />)

    fireEvent.click(await screen.findByText('Release GST'))
    fireEvent.change(await screen.findByPlaceholderText(/ticket attachment/i), { target: { value: 'https://proof/1' } })
    fireEvent.change(screen.getByPlaceholderText(/UTR/i), { target: { value: 'UTR-123' } })
    fireEvent.click(screen.getByText('Confirm Release'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/admin/gst-reimbursements/r1/release')
    expect(posts[0].body).toEqual({ proofUrl: 'https://proof/1', releasePayoutRef: 'UTR-123' })
  })

  it('handles a 409 already-released without crashing (queue refreshes)', async () => {
    asRole('GIFSY_ADMIN')
    const { fetchMock, posts } = stubFetch({ releaseOk: false })
    render(<GstReimbursementsPage />)

    fireEvent.click(await screen.findByText('Release GST'))
    fireEvent.change(await screen.findByPlaceholderText(/ticket attachment/i), { target: { value: 'https://proof/1' } })
    fireEvent.change(screen.getByPlaceholderText(/UTR/i), { target: { value: 'UTR-123' } })
    fireEvent.click(screen.getByText('Confirm Release'))

    await waitFor(() => expect(posts).toHaveLength(1))
    // The 409 path calls onReleased() → a fresh GET reload of the queue.
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/api/admin/gst-reimbursements') && !(c[0] as string).includes('/release'),
      )
      expect(getCalls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
