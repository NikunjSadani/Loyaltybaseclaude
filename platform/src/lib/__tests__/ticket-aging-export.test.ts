/// <reference types="vitest/globals" />
/**
 * TDD — Ticket Aging Export
 *
 * Groups:
 *   A — ageInDays: correct floor, clamp-to-0, day boundaries
 *   B — agingBucket: each boundary value
 *   C — firstResponseHours: null path + computed value
 *   D — buildTicketAgingRow: shape and computed fields
 *   E — summarizeAging: all buckets present, counts, slaBreached tally
 *   F — generateTicketAgingExcel: returns Uint8Array, column count, rendering
 *   G — demoTicketAgingRows: determinism, bucket spread, invariants
 *   H — Type shape (source-read)
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── A: ageInDays ─────────────────────────────────────────────────────────────

describe('A — ageInDays', () => {
  let ageInDays: typeof import('../ticket-aging-export').ageInDays

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    ageInDays = mod.ageInDays
  })

  it('A1: returns 0 for the same instant', () => {
    const d = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(d, d)).toBe(0)
  })

  it('A2: returns 1 for exactly 24 hours later', () => {
    const created = new Date('2026-06-14T00:00:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(1)
  })

  it('A3: floors partial days (23h59m → 0)', () => {
    const created = new Date('2026-06-14T00:01:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(0)
  })

  it('A4: clamps to 0 when asOf is before createdAt (future ticket)', () => {
    const created = new Date('2026-06-20T00:00:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(0)
  })

  it('A5: accepts string dates', () => {
    expect(ageInDays('2026-06-10T00:00:00Z', '2026-06-15T00:00:00Z')).toBe(5)
  })

  it('A6: returns 7 for exactly 7 days', () => {
    const created = new Date('2026-06-08T00:00:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(7)
  })

  it('A7: returns 30 for exactly 30 days', () => {
    const created = new Date('2026-05-16T00:00:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(30)
  })

  it('A8: returns 31 for 31 days', () => {
    const created = new Date('2026-05-15T00:00:00Z')
    const asOf    = new Date('2026-06-15T00:00:00Z')
    expect(ageInDays(created, asOf)).toBe(31)
  })
})

// ─── B: agingBucket ───────────────────────────────────────────────────────────

describe('B — agingBucket', () => {
  let agingBucket: typeof import('../ticket-aging-export').agingBucket

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    agingBucket = mod.agingBucket
  })

  it('B1: 0 days → "0-1 days"', () => {
    expect(agingBucket(0)).toBe('0-1 days')
  })

  it('B2: 1 day → "0-1 days"', () => {
    expect(agingBucket(1)).toBe('0-1 days')
  })

  it('B3: 2 days → "2-3 days"', () => {
    expect(agingBucket(2)).toBe('2-3 days')
  })

  it('B4: 3 days → "2-3 days"', () => {
    expect(agingBucket(3)).toBe('2-3 days')
  })

  it('B5: 4 days → "4-7 days"', () => {
    expect(agingBucket(4)).toBe('4-7 days')
  })

  it('B6: 7 days → "4-7 days"', () => {
    expect(agingBucket(7)).toBe('4-7 days')
  })

  it('B7: 8 days → "8-14 days"', () => {
    expect(agingBucket(8)).toBe('8-14 days')
  })

  it('B8: 14 days → "8-14 days"', () => {
    expect(agingBucket(14)).toBe('8-14 days')
  })

  it('B9: 15 days → "15-30 days"', () => {
    expect(agingBucket(15)).toBe('15-30 days')
  })

  it('B10: 30 days → "15-30 days"', () => {
    expect(agingBucket(30)).toBe('15-30 days')
  })

  it('B11: 31 days → "30+ days"', () => {
    expect(agingBucket(31)).toBe('30+ days')
  })

  it('B12: 100 days → "30+ days"', () => {
    expect(agingBucket(100)).toBe('30+ days')
  })
})

// ─── C: firstResponseHours ────────────────────────────────────────────────────

describe('C — firstResponseHours', () => {
  let firstResponseHours: typeof import('../ticket-aging-export').firstResponseHours

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    firstResponseHours = mod.firstResponseHours
  })

  it('C1: returns null when firstResponseAt is null', () => {
    expect(firstResponseHours(null, new Date('2026-06-15T00:00:00Z'))).toBeNull()
  })

  it('C2: returns null when firstResponseAt is undefined', () => {
    expect(firstResponseHours(undefined, new Date('2026-06-15T00:00:00Z'))).toBeNull()
  })

  it('C3: returns 1.0 for exactly 1 hour response time', () => {
    const created  = new Date('2026-06-15T10:00:00Z')
    const response = new Date('2026-06-15T11:00:00Z')
    expect(firstResponseHours(response, created)).toBe(1.0)
  })

  it('C4: returns 2.5 for 2h30m response time', () => {
    const created  = new Date('2026-06-15T08:00:00Z')
    const response = new Date('2026-06-15T10:30:00Z')
    expect(firstResponseHours(response, created)).toBe(2.5)
  })

  it('C5: accepts string dates', () => {
    const result = firstResponseHours(
      '2026-06-15T12:00:00Z',
      '2026-06-15T10:00:00Z',
    )
    expect(result).toBe(2.0)
  })

  it('C6: rounds to 1 decimal place', () => {
    // 1h 6min = 1.1 hours (exactly 1.1)
    const created  = new Date('2026-06-15T00:00:00Z')
    const response = new Date('2026-06-15T01:06:00Z')
    expect(firstResponseHours(response, created)).toBe(1.1)
  })
})

// ─── D: buildTicketAgingRow ───────────────────────────────────────────────────

describe('D — buildTicketAgingRow', () => {
  let buildTicketAgingRow: typeof import('../ticket-aging-export').buildTicketAgingRow

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    buildTicketAgingRow = mod.buildTicketAgingRow
  })

  const CREATED_AT = new Date('2026-06-10T00:00:00Z')
  const AS_OF      = new Date('2026-06-15T00:00:00Z') // 5 days later

  const BASE_TICKET = {
    ticketNumber:    'TKT-2026-0001',
    subject:         'Test ticket',
    category:        'KYC',
    priority:        'HIGH',
    status:          'OPEN',
    createdByName:   'Suresh Kumar',
    assignedToName:  'Priya Iyer',
    createdAt:       CREATED_AT,
    updatedAt:       new Date('2026-06-12T00:00:00Z'),
    firstResponseAt: new Date('2026-06-10T02:00:00Z'),
    slaBreached:     false,
  }

  it('D1: row has correct ticketNumber', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.ticketNumber).toBe('TKT-2026-0001')
  })

  it('D2: ageDays is computed from createdAt → asOf', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.ageDays).toBe(5)
  })

  it('D3: agingBucket is "4-7 days" for 5 days', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.agingBucket).toBe('4-7 days')
  })

  it('D4: firstResponseHours is computed correctly', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.firstResponseHours).toBe(2.0)
  })

  it('D5: firstResponseHours is null when no firstResponseAt', () => {
    const row = buildTicketAgingRow({ ...BASE_TICKET, firstResponseAt: null }, AS_OF)
    expect(row.firstResponseHours).toBeNull()
  })

  it('D6: createdAt is an ISO string', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('D7: lastUpdatedAt is an ISO string', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('D8: slaBreached is passed through', () => {
    const row = buildTicketAgingRow({ ...BASE_TICKET, slaBreached: true }, AS_OF)
    expect(row.slaBreached).toBe(true)
  })

  it('D9: assignedToName is optional (undefined passes through)', () => {
    const row = buildTicketAgingRow({ ...BASE_TICKET, assignedToName: undefined }, AS_OF)
    expect(row.assignedToName).toBeUndefined()
  })

  it('D10: all required fields are present on the returned row', () => {
    const row = buildTicketAgingRow(BASE_TICKET, AS_OF)
    expect(row).toHaveProperty('ticketNumber')
    expect(row).toHaveProperty('subject')
    expect(row).toHaveProperty('category')
    expect(row).toHaveProperty('priority')
    expect(row).toHaveProperty('status')
    expect(row).toHaveProperty('createdByName')
    expect(row).toHaveProperty('createdAt')
    expect(row).toHaveProperty('ageDays')
    expect(row).toHaveProperty('agingBucket')
    expect(row).toHaveProperty('firstResponseHours')
    expect(row).toHaveProperty('slaBreached')
    expect(row).toHaveProperty('lastUpdatedAt')
  })
})

// ─── E: summarizeAging ────────────────────────────────────────────────────────

describe('E — summarizeAging', () => {
  let summarizeAging: typeof import('../ticket-aging-export').summarizeAging
  let AGING_BUCKETS:  typeof import('../ticket-aging-export').AGING_BUCKETS

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    summarizeAging = mod.summarizeAging
    AGING_BUCKETS  = mod.AGING_BUCKETS
  })

  it('E1: empty array → total 0, slaBreached 0, all buckets present with 0', () => {
    const s = summarizeAging([])
    expect(s.total).toBe(0)
    expect(s.slaBreached).toBe(0)
    for (const b of AGING_BUCKETS) {
      expect(s.byBucket[b]).toBe(0)
    }
  })

  it('E2: all 6 bucket keys are always present', () => {
    const s = summarizeAging([])
    expect(Object.keys(s.byBucket)).toHaveLength(6)
  })

  it('E3: total equals row count', () => {
    const rows = [
      { agingBucket: '0-1 days', slaBreached: false },
      { agingBucket: '4-7 days', slaBreached: true },
      { agingBucket: '30+ days', slaBreached: true },
    ] as any[]
    const s = summarizeAging(rows)
    expect(s.total).toBe(3)
  })

  it('E4: slaBreached count is the number of rows with slaBreached=true', () => {
    const rows = [
      { agingBucket: '0-1 days', slaBreached: true },
      { agingBucket: '0-1 days', slaBreached: false },
      { agingBucket: '8-14 days', slaBreached: true },
    ] as any[]
    const s = summarizeAging(rows)
    expect(s.slaBreached).toBe(2)
  })

  it('E5: byBucket counts correctly for each bucket', () => {
    const rows = [
      { agingBucket: '0-1 days',   slaBreached: false },
      { agingBucket: '0-1 days',   slaBreached: false },
      { agingBucket: '4-7 days',   slaBreached: true  },
      { agingBucket: '30+ days',   slaBreached: true  },
    ] as any[]
    const s = summarizeAging(rows)
    expect(s.byBucket['0-1 days']).toBe(2)
    expect(s.byBucket['4-7 days']).toBe(1)
    expect(s.byBucket['30+ days']).toBe(1)
    expect(s.byBucket['2-3 days']).toBe(0)
    expect(s.byBucket['8-14 days']).toBe(0)
    expect(s.byBucket['15-30 days']).toBe(0)
  })
})

// ─── F: generateTicketAgingExcel ─────────────────────────────────────────────

describe('F — generateTicketAgingExcel', () => {
  let generateTicketAgingExcel:  typeof import('../ticket-aging-export').generateTicketAgingExcel
  let TICKET_AGING_COLUMN_COUNT: number
  let demoTicketAgingRows:       typeof import('../ticket-aging-export').demoTicketAgingRows

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    generateTicketAgingExcel  = mod.generateTicketAgingExcel
    TICKET_AGING_COLUMN_COUNT = mod.TICKET_AGING_COLUMN_COUNT
    demoTicketAgingRows       = mod.demoTicketAgingRows
  })

  it('F1: TICKET_AGING_COLUMN_COUNT equals 13', () => {
    expect(TICKET_AGING_COLUMN_COUNT).toBe(13)
  })

  it('F2: returns a non-empty Uint8Array', () => {
    const bytes = generateTicketAgingExcel([])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(100)
  })

  it('F3: works with an empty rows array', () => {
    const bytes = generateTicketAgingExcel([])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('F4: header row has exactly 13 columns', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = generateTicketAgingExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    expect(aoa[0]).toHaveLength(TICKET_AGING_COLUMN_COUNT)
  })

  it('F5: header contains all required column names', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = generateTicketAgingExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    expect(header).toContain('Ticket #')
    expect(header).toContain('Subject')
    expect(header).toContain('Age (days)')
    expect(header).toContain('Aging bucket')
    expect(header).toContain('First response (hrs)')
    expect(header).toContain('SLA breached')
    expect(header[header.length - 1]).toBe('Last updated')
  })

  it('F6: null firstResponseHours renders as "Pending"', async () => {
    const XLSX = await import('xlsx')
    const row = {
      ticketNumber: 'TKT-0001', subject: 'Test', category: 'KYC', priority: 'LOW',
      status: 'OPEN', createdByName: 'A', assignedToName: undefined,
      createdAt: '2026-06-10T00:00:00.000Z', ageDays: 5, agingBucket: '4-7 days',
      firstResponseHours: null, slaBreached: false,
      lastUpdatedAt: '2026-06-12T00:00:00.000Z',
    }
    const bytes = generateTicketAgingExcel([row])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // data row is index 1, firstResponseHours is column 10 (index 10)
    expect(aoa[1][10]).toBe('Pending')
  })

  it('F7: slaBreached=true renders as "Yes"', async () => {
    const XLSX = await import('xlsx')
    const row = {
      ticketNumber: 'TKT-0002', subject: 'Test', category: 'POINTS', priority: 'CRITICAL',
      status: 'ESCALATED', createdByName: 'B', assignedToName: undefined,
      createdAt: '2026-06-01T00:00:00.000Z', ageDays: 14, agingBucket: '8-14 days',
      firstResponseHours: 2.0, slaBreached: true,
      lastUpdatedAt: '2026-06-05T00:00:00.000Z',
    }
    const bytes = generateTicketAgingExcel([row])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // slaBreached is column 11 (index 11)
    expect(aoa[1][11]).toBe('Yes')
  })

  it('F8: slaBreached=false renders as "No"', async () => {
    const XLSX = await import('xlsx')
    const row = {
      ticketNumber: 'TKT-0003', subject: 'Test', category: 'ACCOUNT', priority: 'LOW',
      status: 'OPEN', createdByName: 'C', assignedToName: undefined,
      createdAt: '2026-06-14T00:00:00.000Z', ageDays: 1, agingBucket: '0-1 days',
      firstResponseHours: 0.5, slaBreached: false,
      lastUpdatedAt: '2026-06-14T06:00:00.000Z',
    }
    const bytes = generateTicketAgingExcel([row])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    expect(aoa[1][11]).toBe('No')
  })

  it('F9: dates render as YYYY-MM-DD format', async () => {
    const XLSX = await import('xlsx')
    const row = {
      ticketNumber: 'TKT-0004', subject: 'Test', category: 'PAYOUT', priority: 'MEDIUM',
      status: 'IN_PROGRESS', createdByName: 'D', assignedToName: 'E',
      createdAt: '2026-06-10T00:00:00.000Z', ageDays: 5, agingBucket: '4-7 days',
      firstResponseHours: 1.0, slaBreached: false,
      lastUpdatedAt: '2026-06-12T00:00:00.000Z',
    }
    const bytes = generateTicketAgingExcel([row])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // Created is column 7 (index 7), Last updated is column 12 (index 12)
    expect(aoa[1][7]).toBe('2026-06-10')
    expect(aoa[1][12]).toBe('2026-06-12')
  })

  it('F10: data row count matches rows input', async () => {
    const XLSX  = await import('xlsx')
    const asOf  = new Date('2026-06-15T00:00:00Z')
    const rows  = demoTicketAgingRows(asOf)
    const bytes = generateTicketAgingExcel(rows)
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // Row 0 = header, rows 1..N = data
    expect(aoa.length).toBe(rows.length + 1)
  })
})

// ─── G: demoTicketAgingRows ───────────────────────────────────────────────────

describe('G — demoTicketAgingRows', () => {
  let demoTicketAgingRows: typeof import('../ticket-aging-export').demoTicketAgingRows
  let AGING_BUCKETS:       typeof import('../ticket-aging-export').AGING_BUCKETS

  beforeAll(async () => {
    const mod = await import('../ticket-aging-export')
    demoTicketAgingRows = mod.demoTicketAgingRows
    AGING_BUCKETS       = mod.AGING_BUCKETS
  })

  const AS_OF = new Date('2026-06-15T00:00:00Z')

  it('G1: returns ~10 rows', () => {
    const rows = demoTicketAgingRows(AS_OF)
    expect(rows.length).toBeGreaterThanOrEqual(10)
  })

  it('G2: deterministic — calling twice with the same asOf yields deep-equal output', () => {
    const rows1 = demoTicketAgingRows(AS_OF)
    const rows2 = demoTicketAgingRows(AS_OF)
    expect(rows1).toEqual(rows2)
  })

  it('G3: different asOf values produce different createdAt values', () => {
    const asOf1 = new Date('2026-06-15T00:00:00Z')
    const asOf2 = new Date('2026-06-01T00:00:00Z')
    const rows1 = demoTicketAgingRows(asOf1)
    const rows2 = demoTicketAgingRows(asOf2)
    // The same slot's createdAt should differ by the same offset as asOf
    expect(rows1[0].createdAt).not.toBe(rows2[0].createdAt)
  })

  it('G4: covers multiple aging buckets (at least 4 distinct)', () => {
    const rows    = demoTicketAgingRows(AS_OF)
    const buckets = new Set(rows.map(r => r.agingBucket))
    expect(buckets.size).toBeGreaterThanOrEqual(4)
  })

  it('G5: all 6 AGING_BUCKETS are represented', () => {
    const rows    = demoTicketAgingRows(AS_OF)
    const buckets = new Set(rows.map(r => r.agingBucket))
    for (const b of AGING_BUCKETS) {
      expect(buckets.has(b)).toBe(true)
    }
  })

  it('G6: has at least 1 row with slaBreached=true', () => {
    const rows = demoTicketAgingRows(AS_OF)
    expect(rows.some(r => r.slaBreached)).toBe(true)
  })

  it('G7: has at least 1 row with firstResponseHours===null', () => {
    const rows = demoTicketAgingRows(AS_OF)
    expect(rows.some(r => r.firstResponseHours === null)).toBe(true)
  })

  it('G8: every row has a non-empty ticketNumber', () => {
    const rows = demoTicketAgingRows(AS_OF)
    rows.forEach(r => expect(r.ticketNumber).toBeTruthy())
  })

  it('G9: every row has a non-empty createdByName', () => {
    const rows = demoTicketAgingRows(AS_OF)
    rows.forEach(r => expect(r.createdByName).toBeTruthy())
  })

  it('G10: ageDays is always >= 0', () => {
    const rows = demoTicketAgingRows(AS_OF)
    rows.forEach(r => expect(r.ageDays).toBeGreaterThanOrEqual(0))
  })

  it('G11: agingBucket is consistent with ageDays for every row', () => {
    const rows = demoTicketAgingRows(AS_OF)
    rows.forEach(r => {
      let expected: string
      if (r.ageDays <= 1)       expected = '0-1 days'
      else if (r.ageDays <= 3)  expected = '2-3 days'
      else if (r.ageDays <= 7)  expected = '4-7 days'
      else if (r.ageDays <= 14) expected = '8-14 days'
      else if (r.ageDays <= 30) expected = '15-30 days'
      else                      expected = '30+ days'
      expect(r.agingBucket).toBe(expected)
    })
  })
})

// ─── H: Type shape (source-read) ─────────────────────────────────────────────

describe('H — Type shape', () => {
  const { readFileSync } = require('fs')
  const { resolve }      = require('path')
  const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf-8')

  it('H1: TicketAgingRow is exported from src/types/index.ts', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/export interface TicketAgingRow/)
  })

  it('H2: TicketAgingSummary is exported from src/types/index.ts', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/export interface TicketAgingSummary/)
  })

  it('H3: TicketAgingRow includes firstResponseHours typed as number | null', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/firstResponseHours:\s*number \| null/)
  })

  it('H4: TicketAgingRow includes slaBreached typed as boolean', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/slaBreached:\s*boolean/)
  })

  it('H5: TicketAgingSummary includes byBucket field', () => {
    const code = src('src/types/index.ts')
    expect(code).toMatch(/byBucket:\s*Record<string, number>/)
  })

  it('H6: TICKET_AGING_COLUMN_COUNT is exported from ticket-aging-export.ts', () => {
    const code = src('src/lib/ticket-aging-export.ts')
    expect(code).toMatch(/export const TICKET_AGING_COLUMN_COUNT/)
  })

  it('H7: lib file exports all required functions', () => {
    const code = src('src/lib/ticket-aging-export.ts')
    expect(code).toMatch(/export function ageInDays/)
    expect(code).toMatch(/export function agingBucket/)
    expect(code).toMatch(/export function firstResponseHours/)
    expect(code).toMatch(/export function buildTicketAgingRow/)
    expect(code).toMatch(/export function summarizeAging/)
    expect(code).toMatch(/export function generateTicketAgingExcel/)
    expect(code).toMatch(/export function demoTicketAgingRows/)
  })

  it('H8: AGING_BUCKETS constant is exported and contains all 6 buckets', () => {
    const code = src('src/lib/ticket-aging-export.ts')
    expect(code).toMatch(/export const AGING_BUCKETS/)
    expect(code).toMatch(/'0-1 days'/)
    expect(code).toMatch(/'30\+ days'/)
  })
})
