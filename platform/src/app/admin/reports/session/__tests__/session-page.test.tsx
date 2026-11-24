/// <reference types="vitest/globals" />
/**
 * Admin Session Report page — App Installed + level-ID columns (owner 2026-11-24, platform-wide).
 *
 *  - SR1: header order User · Role · Mobile · App Installed · <tenant level> ID × 5 · Last Login · months
 *  - SR2: cells — "Yes — Android, iOS" / "No", ID codes (multi-rep " | " kept whole, full value on hover), admin blank
 *  - SR3: a payload without the new fields (older API) still renders (no ID columns, App Installed "No")
 */

import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { vi, describe, it, expect, afterEach } from 'vitest'
import SessionReportPage from '../page'

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }))

const MONTHS = [
  { ym: '2026-10', label: 'Oct 2026' },
  { ym: '2026-11', label: 'Nov 2026' },
]

const PAYLOAD = {
  generatedAt: '2026-11-24T00:00:00.000Z',
  timezone: 'Asia/Kolkata',
  months: MONTHS,
  idHeaders: ['ISR ID', 'SO ID', 'ASM ID', 'SM ID', 'ZH ID'],
  rows: [
    {
      userId: 'u1', name: 'Isha Rep', phone: '9000000001', role: 'SALES_ISR',
      appInstalled: true, appPlatforms: ['Android', 'iOS'],
      levelIds: ['I1', 'S1', 'A1', 'M1', 'Z1'],
      lastLoginAt: null, activeDays: { '2026-11': 3 },
    },
    {
      userId: 'u2', name: 'Ravi Retail', phone: '9000000002', role: 'WHOLESALER',
      appInstalled: false, appPlatforms: [],
      levelIds: ['I1 | I2', 'S1 | S2', 'A1 | A1', 'M1 | M1', 'Z1 | Z1'],
      lastLoginAt: null, activeDays: {},
    },
    {
      userId: 'u3', name: 'Adi Admin', phone: '9000000003', role: 'CLIENT_ADMIN',
      appInstalled: false, appPlatforms: [],
      levelIds: ['', '', '', '', ''],
      lastLoginAt: null, activeDays: {},
    },
  ],
}

function stubFetch(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data }), { status: 200 })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Session Report page — App Installed + level IDs', () => {
  it('SR1: renders the new columns between Mobile and Last Login', async () => {
    stubFetch(PAYLOAD)
    render(<SessionReportPage />)
    await screen.findByText('Isha Rep')
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent)
    expect(headers).toEqual([
      'User', 'Role', 'Mobile', 'App Installed',
      'ISR ID', 'SO ID', 'ASM ID', 'SM ID', 'ZH ID',
      'Last Login', 'Oct 2026', 'Nov 2026',
    ])
  })

  it('SR2: shows install status with platforms and the ID codes per row', async () => {
    stubFetch(PAYLOAD)
    render(<SessionReportPage />)
    const isr = (await screen.findByText('Isha Rep')).closest('tr')!
    const isrCells = within(isr).getAllByRole('cell').map(c => c.textContent)
    expect(isrCells.slice(3, 9)).toEqual(['Yes — Android, iOS', 'I1', 'S1', 'A1', 'M1', 'Z1'])

    const retail = screen.getByText('Ravi Retail').closest('tr')!
    const retailCells = within(retail).getAllByRole('cell')
    expect(retailCells.slice(3, 9).map(c => c.textContent)).toEqual(['No', 'I1 | I2', 'S1 | S2', 'A1 | A1', 'M1 | M1', 'Z1 | Z1'])
    expect(retailCells[4].getAttribute('title')).toBe('I1 | I2')

    const admin = screen.getByText('Adi Admin').closest('tr')!
    expect(within(admin).getAllByRole('cell').slice(3, 9).map(c => c.textContent)).toEqual(['No', '', '', '', '', ''])
  })

  it('SR3: an older payload without the new fields still renders', async () => {
    const legacy = {
      generatedAt: PAYLOAD.generatedAt,
      timezone: PAYLOAD.timezone,
      months: MONTHS,
      rows: [{ userId: 'u9', name: 'Old Row', phone: '9', role: 'SSS', lastLoginAt: null, activeDays: {} }],
    }
    stubFetch(legacy)
    render(<SessionReportPage />)
    const row = (await screen.findByText('Old Row')).closest('tr')!
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent)
    expect(headers).toEqual(['User', 'Role', 'Mobile', 'App Installed', 'Last Login', 'Oct 2026', 'Nov 2026'])
    expect(within(row).getAllByRole('cell')[3].textContent).toBe('No')
  })
})
