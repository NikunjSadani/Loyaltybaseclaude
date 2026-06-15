/// <reference types="vitest/globals" />
/**
 * TDD — Outlet Points Ledger Export
 *
 * Groups:
 *   A — monthsInRange: correct output, boundary enforcement
 *   B — aggregateLedgerToRow: earn/burn/expire bucketing, closing-balance math
 *   C — generatePointsLedgerExcel: returns bytes, column count, header labels
 *   D — demoPointsLedgerRows: deterministic, structural invariants, closing-balance reconciliation
 *   E — Type shape (source-read)
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── A: monthsInRange ─────────────────────────────────────────────────────────

describe('A — monthsInRange', () => {
  let monthsInRange: typeof import('../points-ledger-export').monthsInRange

  beforeAll(async () => {
    const mod = await import('../points-ledger-export')
    monthsInRange = mod.monthsInRange
  })

  it('A1: returns 3 months for a 3-month range', () => {
    const result = monthsInRange('2026-04', '2026-06')
    expect(result).toHaveLength(3)
  })

  it('A2: monthKey format is YYYY-MM', () => {
    const result = monthsInRange('2026-04', '2026-06')
    result.forEach(m => expect(m.monthKey).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/))
  })

  it('A3: label format is "MMM YYYY"', () => {
    const result = monthsInRange('2026-04', '2026-06')
    expect(result[0].label).toBe('Apr 2026')
    expect(result[1].label).toBe('May 2026')
    expect(result[2].label).toBe('Jun 2026')
  })

  it('A4: monthKey values are in correct ascending order', () => {
    const result = monthsInRange('2026-04', '2026-06')
    expect(result[0].monthKey).toBe('2026-04')
    expect(result[1].monthKey).toBe('2026-05')
    expect(result[2].monthKey).toBe('2026-06')
  })

  it('A5: single-month range returns exactly 1 entry', () => {
    const result = monthsInRange('2026-06', '2026-06')
    expect(result).toHaveLength(1)
    expect(result[0].monthKey).toBe('2026-06')
    expect(result[0].label).toBe('Jun 2026')
  })

  it('A6: exactly 24-month span is accepted', () => {
    // from 2024-07 to 2026-06 = 24 months inclusive
    const result = monthsInRange('2024-07', '2026-06')
    expect(result).toHaveLength(24)
  })

  it('A7: throws RangeError when span exceeds 24 months', () => {
    expect(() => monthsInRange('2024-06', '2026-06')).toThrow(RangeError)
    expect(() => monthsInRange('2024-06', '2026-06')).toThrow(/24/)
  })

  it('A8: throws RangeError when from is after to', () => {
    expect(() => monthsInRange('2026-06', '2026-04')).toThrow(RangeError)
  })

  it('A9: handles year boundary correctly (Dec → Jan)', () => {
    const result = monthsInRange('2025-11', '2026-02')
    expect(result).toHaveLength(4)
    expect(result[0].label).toBe('Nov 2025')
    expect(result[1].label).toBe('Dec 2025')
    expect(result[2].label).toBe('Jan 2026')
    expect(result[3].label).toBe('Feb 2026')
  })
})

// ─── B: aggregateLedgerToRow ──────────────────────────────────────────────────

describe('B — aggregateLedgerToRow', () => {
  let aggregateLedgerToRow: typeof import('../points-ledger-export').aggregateLedgerToRow
  let monthsInRange:        typeof import('../points-ledger-export').monthsInRange

  beforeAll(async () => {
    const mod = await import('../points-ledger-export')
    aggregateLedgerToRow = mod.aggregateLedgerToRow
    monthsInRange        = mod.monthsInRange
  })

  const META = { outletId: 'OUT-001', outletName: 'Test Outlet' }
  const MONTHS_3 = [
    { monthKey: '2026-04', label: 'Apr 2026' },
    { monthKey: '2026-05', label: 'May 2026' },
    { monthKey: '2026-06', label: 'Jun 2026' },
  ]

  it('B1: EARN entries sum to totalEarn and bucket into correct month', () => {
    const entries = [
      { type: 'EARN', points: 100, createdAt: new Date('2026-04-10T00:00:00Z') },
      { type: 'EARN', points: 200, createdAt: new Date('2026-05-15T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 0, entries, MONTHS_3)
    expect(row.totalEarn).toBe(300)
    expect(row.months[0].earn).toBe(100)  // Apr
    expect(row.months[1].earn).toBe(200)  // May
    expect(row.months[2].earn).toBe(0)    // Jun (none)
  })

  it('B2: REDEEM entries sum to totalBurn and bucket into correct month', () => {
    const entries = [
      { type: 'REDEEM', points: 50, createdAt: new Date('2026-04-20T00:00:00Z') },
      { type: 'REDEEM', points: 75, createdAt: new Date('2026-06-01T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 0, entries, MONTHS_3)
    expect(row.totalBurn).toBe(125)
    expect(row.months[0].burn).toBe(50)
    expect(row.months[2].burn).toBe(75)
  })

  it('B3: EXPIRE entries accumulate in totalExpired (not in monthly earn/burn)', () => {
    const entries = [
      { type: 'EXPIRE', points: 30, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 200, entries, MONTHS_3)
    expect(row.totalExpired).toBe(30)
    // Expired points are NOT reflected in monthly earn or burn columns
    expect(row.months[1].earn).toBe(0)
    expect(row.months[1].burn).toBe(0)
  })

  it('B4: closing = opening + earn - burn - expired', () => {
    const entries = [
      { type: 'EARN',   points: 500, createdAt: new Date('2026-04-01T00:00:00Z') },
      { type: 'REDEEM', points: 150, createdAt: new Date('2026-05-01T00:00:00Z') },
      { type: 'EXPIRE', points: 50,  createdAt: new Date('2026-06-01T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 100, entries, MONTHS_3)
    // 100 + 500 - 150 - 50 = 400
    expect(row.closingBalance).toBe(400)
  })

  it('B5: empty entries yields all-zero months and closing equals opening', () => {
    const row = aggregateLedgerToRow(META, 250, [], MONTHS_3)
    expect(row.totalEarn).toBe(0)
    expect(row.totalBurn).toBe(0)
    expect(row.totalExpired).toBe(0)
    expect(row.closingBalance).toBe(250)
    row.months.forEach(cell => {
      expect(cell.earn).toBe(0)
      expect(cell.burn).toBe(0)
    })
  })

  it('B6: months array length matches the provided months list', () => {
    const row = aggregateLedgerToRow(META, 0, [], MONTHS_3)
    expect(row.months).toHaveLength(3)
  })

  it('B7: entries outside the month range are ignored (no out-of-bounds bucket)', () => {
    const entries = [
      // Before range
      { type: 'EARN', points: 999, createdAt: new Date('2026-03-31T23:59:59Z') },
      // After range
      { type: 'EARN', points: 999, createdAt: new Date('2026-07-01T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 0, entries, MONTHS_3)
    // Out-of-range entries do not add to monthly buckets
    row.months.forEach(cell => expect(cell.earn).toBe(0))
    // But they DO still count toward totals (entries param is not pre-filtered)
    // — this is intentional: caller is responsible for pre-scoping the entries.
    // The month cells just won't have them.
    expect(row.totalEarn).toBe(1998)
  })

  it('B8: ADJUST/REVERSE/LOCK/UNLOCK entries are excluded from all totals', () => {
    const entries = [
      { type: 'ADJUST',  points: 100, createdAt: new Date('2026-04-01T00:00:00Z') },
      { type: 'REVERSE', points: 100, createdAt: new Date('2026-04-01T00:00:00Z') },
      { type: 'LOCK',    points: 100, createdAt: new Date('2026-04-01T00:00:00Z') },
      { type: 'UNLOCK',  points: 100, createdAt: new Date('2026-04-01T00:00:00Z') },
    ]
    const row = aggregateLedgerToRow(META, 0, entries, MONTHS_3)
    expect(row.totalEarn).toBe(0)
    expect(row.totalBurn).toBe(0)
    expect(row.totalExpired).toBe(0)
    expect(row.closingBalance).toBe(0)
  })

  it('B9: meta fields are passed through to the row', () => {
    const metaFull = {
      outletId:         'OUT-999',
      outletName:       'Full Meta Outlet',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-W01',
      asmId:            'ASM-W01',
      soId:             'SO-W01',
      xsrId:            'XSR-W01',
      distributorCode:  'DIST-01',
      distributorName:  'Test Distributor',
      programName:      'Test Programme',
      programCategory:  'Premium',
      outletType:       'WHOLESALER',
    }
    const row = aggregateLedgerToRow(metaFull, 0, [], MONTHS_3)
    expect(row.outletId).toBe('OUT-999')
    expect(row.zone).toBe('West')
    expect(row.distributorName).toBe('Test Distributor')
    expect(row.programCategory).toBe('Premium')
  })
})

// ─── C: generatePointsLedgerExcel ─────────────────────────────────────────────

describe('C — generatePointsLedgerExcel', () => {
  let generatePointsLedgerExcel: typeof import('../points-ledger-export').generatePointsLedgerExcel
  let POINTS_LEDGER_FIXED_COLUMN_COUNT: number
  let demoPointsLedgerRows: typeof import('../points-ledger-export').demoPointsLedgerRows
  let monthsInRange: typeof import('../points-ledger-export').monthsInRange

  beforeAll(async () => {
    const mod = await import('../points-ledger-export')
    generatePointsLedgerExcel       = mod.generatePointsLedgerExcel
    POINTS_LEDGER_FIXED_COLUMN_COUNT = mod.POINTS_LEDGER_FIXED_COLUMN_COUNT
    demoPointsLedgerRows            = mod.demoPointsLedgerRows
    monthsInRange                   = mod.monthsInRange
  })

  const MONTHS_3 = [
    { monthKey: '2026-04', label: 'Apr 2026' },
    { monthKey: '2026-05', label: 'May 2026' },
    { monthKey: '2026-06', label: 'Jun 2026' },
  ]

  it('C1: POINTS_LEDGER_FIXED_COLUMN_COUNT equals 18', () => {
    expect(POINTS_LEDGER_FIXED_COLUMN_COUNT).toBe(18)
  })

  it('C2: returns a non-empty Uint8Array', () => {
    const bytes = generatePointsLedgerExcel([], MONTHS_3)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(100)
  })

  it('C3: works with an empty rows array', () => {
    const bytes = generatePointsLedgerExcel([], MONTHS_3)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('C4: total column count equals FIXED + 2*N months', async () => {
    // Parse the workbook and check the header row length
    const XLSX = await import('xlsx')
    const bytes  = generatePointsLedgerExcel([], MONTHS_3)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    const N = MONTHS_3.length
    expect(header.length).toBe(POINTS_LEDGER_FIXED_COLUMN_COUNT + 2 * N)
  })

  it('C5: header contains "Apr 2026 Earn" and "Apr 2026 Burn" for a range including Apr 2026', async () => {
    const XLSX = await import('xlsx')
    const bytes  = generatePointsLedgerExcel([], MONTHS_3)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    expect(header).toContain('Apr 2026 Earn')
    expect(header).toContain('Apr 2026 Burn')
  })

  it('C6: header contains "Closing balance" as last column', async () => {
    const XLSX = await import('xlsx')
    const bytes  = generatePointsLedgerExcel([], MONTHS_3)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    expect(header[header.length - 1]).toBe('Closing balance')
  })

  it('C7: returns data rows when rows are provided', async () => {
    const XLSX   = await import('xlsx')
    const months = monthsInRange('2026-04', '2026-06')
    const rows   = demoPointsLedgerRows(months)
    const bytes  = generatePointsLedgerExcel(rows, months)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // Row 0 = header, rows 1..N = data
    expect(aoa.length).toBe(rows.length + 1)
  })

  it('C8: single-month range produces 2 month columns', async () => {
    const XLSX = await import('xlsx')
    const months = [{ monthKey: '2026-06', label: 'Jun 2026' }]
    const bytes  = generatePointsLedgerExcel([], months)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    // 18 fixed + 2*1 = 20
    expect(header.length).toBe(POINTS_LEDGER_FIXED_COLUMN_COUNT + 2)
    expect(header).toContain('Jun 2026 Earn')
    expect(header).toContain('Jun 2026 Burn')
  })
})

// ─── D: demoPointsLedgerRows ──────────────────────────────────────────────────

describe('D — demoPointsLedgerRows', () => {
  let demoPointsLedgerRows: typeof import('../points-ledger-export').demoPointsLedgerRows
  let monthsInRange:        typeof import('../points-ledger-export').monthsInRange

  beforeAll(async () => {
    const mod = await import('../points-ledger-export')
    demoPointsLedgerRows = mod.demoPointsLedgerRows
    monthsInRange        = mod.monthsInRange
  })

  const MONTHS = [
    { monthKey: '2026-01', label: 'Jan 2026' },
    { monthKey: '2026-02', label: 'Feb 2026' },
    { monthKey: '2026-03', label: 'Mar 2026' },
  ]

  it('D1: returns ~8 rows', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    expect(rows.length).toBeGreaterThanOrEqual(8)
  })

  it('D2: every row has a non-empty outletId', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => expect(r.outletId).toBeTruthy())
  })

  it('D3: every row has a non-empty outletName', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => expect(r.outletName).toBeTruthy())
  })

  it('D4: each row has a months array matching the provided month list length', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => expect(r.months).toHaveLength(MONTHS.length))
  })

  it('D5: deterministic — calling twice with the same months yields deep-equal output', () => {
    const rows1 = demoPointsLedgerRows(MONTHS)
    const rows2 = demoPointsLedgerRows(MONTHS)
    expect(rows1).toEqual(rows2)
  })

  it('D6: closing = opening + totalEarn - totalBurn - totalExpired for every row', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => {
      const expected = r.openingBalance + r.totalEarn - r.totalBurn - r.totalExpired
      expect(r.closingBalance).toBe(expected)
    })
  })

  it('D7: every row has a non-negative closingBalance', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => expect(r.closingBalance).toBeGreaterThanOrEqual(0))
  })

  it('D8: totalEarn = sum of all month earn cells', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => {
      const sumEarn = r.months.reduce((s, c) => s + c.earn, 0)
      expect(r.totalEarn).toBe(sumEarn)
    })
  })

  it('D9: totalBurn = sum of all month burn cells', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    rows.forEach(r => {
      const sumBurn = r.months.reduce((s, c) => s + c.burn, 0)
      expect(r.totalBurn).toBe(sumBurn)
    })
  })

  it('D10: demo rows include at least one WHOLESALER and one SSS', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    const types = new Set(rows.map(r => r.outletType))
    expect(types.has('WHOLESALER')).toBe(true)
    expect(types.has('SSS')).toBe(true)
  })

  it('D11: demo rows include multiple zones', () => {
    const rows = demoPointsLedgerRows(MONTHS)
    const zones = new Set(rows.map(r => r.zone))
    expect(zones.size).toBeGreaterThan(1)
  })

  it('D12: different month list lengths produce correspondingly sized month arrays', () => {
    const months6 = monthsInRange('2026-01', '2026-06')
    const rows6   = demoPointsLedgerRows(months6)
    rows6.forEach(r => expect(r.months).toHaveLength(6))

    const months1 = [{ monthKey: '2026-06', label: 'Jun 2026' }]
    const rows1   = demoPointsLedgerRows(months1)
    rows1.forEach(r => expect(r.months).toHaveLength(1))
  })
})

// ─── E: Type shape (source-read) ─────────────────────────────────────────────

describe('E — Type shape', () => {
  const { readFileSync } = require('fs')
  const { resolve }      = require('path')
  const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf-8')

  it('E1: PointsLedgerMonthCell is exported from src/types/index.ts', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/export interface PointsLedgerMonthCell/)
  })

  it('E2: PointsLedgerReportRow is exported from src/types/index.ts', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/export interface PointsLedgerReportRow/)
  })

  it('E3: PointsLedgerReportRow includes months field typed as PointsLedgerMonthCell array', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/months:\s*PointsLedgerMonthCell\[\]/)
  })

  it('E4: PointsLedgerReportRow includes all required financial fields', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/openingBalance:\s*number/)
    expect(code).toMatch(/totalEarn:\s*number/)
    expect(code).toMatch(/totalBurn:\s*number/)
    expect(code).toMatch(/totalExpired:\s*number/)
    expect(code).toMatch(/closingBalance:\s*number/)
  })

  it('E5: POINTS_LEDGER_FIXED_COLUMN_COUNT is exported from points-ledger-export.ts', () => {
    const code = src('src/lib/points-ledger-export.ts')
    expect(code).toMatch(/export const POINTS_LEDGER_FIXED_COLUMN_COUNT/)
  })

  it('E6: lib file exports monthsInRange, aggregateLedgerToRow, generatePointsLedgerExcel, demoPointsLedgerRows', () => {
    const code = src('src/lib/points-ledger-export.ts')
    expect(code).toMatch(/export function monthsInRange/)
    expect(code).toMatch(/export function aggregateLedgerToRow/)
    expect(code).toMatch(/export function generatePointsLedgerExcel/)
    expect(code).toMatch(/export function demoPointsLedgerRows/)
  })
})
