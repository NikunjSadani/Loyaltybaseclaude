/// <reference types="vitest/globals" />
/**
 * TDD — KYC Review Dump Export
 *
 * Groups:
 *   A — Column constants: header counts and labels
 *   B — generateKycReviewDumpExcel: returns Uint8Array, sheet structure, verification labels
 *   C — demoKycReviewRows: determinism, required fields, submissionId format
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── A: Column constants ──────────────────────────────────────────────────────

describe('A — Column constants', () => {
  let KYC_DUMP_CONTEXT_HEADERS:       typeof import('../kyc-review-dump').KYC_DUMP_CONTEXT_HEADERS
  let KYC_DUMP_VERIFICATION_HEADERS:  typeof import('../kyc-review-dump').KYC_DUMP_VERIFICATION_HEADERS

  beforeAll(async () => {
    const mod = await import('../kyc-review-dump')
    KYC_DUMP_CONTEXT_HEADERS      = mod.KYC_DUMP_CONTEXT_HEADERS
    KYC_DUMP_VERIFICATION_HEADERS = mod.KYC_DUMP_VERIFICATION_HEADERS
  })

  it('A1: KYC_DUMP_CONTEXT_HEADERS has exactly 16 entries', () => {
    expect(KYC_DUMP_CONTEXT_HEADERS).toHaveLength(16)
  })

  it('A2: KYC_DUMP_VERIFICATION_HEADERS has exactly 10 entries', () => {
    expect(KYC_DUMP_VERIFICATION_HEADERS).toHaveLength(10)
  })

  it('A3: context headers start with "Submission ID"', () => {
    expect(KYC_DUMP_CONTEXT_HEADERS[0]).toBe('Submission ID')
  })

  it('A4: context headers end with "Sales User"', () => {
    expect(KYC_DUMP_CONTEXT_HEADERS[KYC_DUMP_CONTEXT_HEADERS.length - 1]).toBe('Sales User')
  })

  it('A5: context headers include all required context labels', () => {
    const required = [
      'Submission ID', 'Outlet Code', 'Outlet Name', 'Owner Name', 'Phone',
      'GST Number', 'PAN Number', 'Address', 'City', 'State', 'Pincode',
      'Bank Name', 'Account Number', 'IFSC', 'Submitted At', 'Sales User',
    ]
    for (const label of required) {
      expect(KYC_DUMP_CONTEXT_HEADERS).toContain(label)
    }
  })

  it('A6: verification headers include all required verification labels', () => {
    const required = [
      'Bank Verified', 'Bank Name Match', 'Penny-drop Ref',
      'GST Registration Type', 'GST Legal Name', 'GST Status',
      'Address Approved', 'Owner Approved', 'Decision', 'Reason',
    ]
    for (const label of required) {
      expect(KYC_DUMP_VERIFICATION_HEADERS).toContain(label)
    }
  })

  it('A7: verification headers start with "Bank Verified"', () => {
    expect(KYC_DUMP_VERIFICATION_HEADERS[0]).toBe('Bank Verified')
  })

  it('A8: verification headers end with "Reason"', () => {
    expect(KYC_DUMP_VERIFICATION_HEADERS[KYC_DUMP_VERIFICATION_HEADERS.length - 1]).toBe('Reason')
  })
})

// ─── B: generateKycReviewDumpExcel ───────────────────────────────────────────

describe('B — generateKycReviewDumpExcel', () => {
  let generateKycReviewDumpExcel:     typeof import('../kyc-review-dump').generateKycReviewDumpExcel
  let demoKycReviewRows:              typeof import('../kyc-review-dump').demoKycReviewRows
  let KYC_DUMP_CONTEXT_HEADERS:       typeof import('../kyc-review-dump').KYC_DUMP_CONTEXT_HEADERS
  let KYC_DUMP_VERIFICATION_HEADERS:  typeof import('../kyc-review-dump').KYC_DUMP_VERIFICATION_HEADERS

  beforeAll(async () => {
    const mod = await import('../kyc-review-dump')
    generateKycReviewDumpExcel    = mod.generateKycReviewDumpExcel
    demoKycReviewRows             = mod.demoKycReviewRows
    KYC_DUMP_CONTEXT_HEADERS      = mod.KYC_DUMP_CONTEXT_HEADERS
    KYC_DUMP_VERIFICATION_HEADERS = mod.KYC_DUMP_VERIFICATION_HEADERS
  })

  it('B1: returns a non-empty Uint8Array', () => {
    const bytes = generateKycReviewDumpExcel([])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(100)
  })

  it('B2: works with an empty rows array', () => {
    const bytes = generateKycReviewDumpExcel([])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('B3: returns a non-empty Uint8Array for demo rows', () => {
    const bytes = generateKycReviewDumpExcel(demoKycReviewRows())
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(500)
  })

  it('B4: header row has exactly 26 columns (16 context + 10 verification)', async () => {
    const XLSX  = await import('xlsx')
    const bytes = generateKycReviewDumpExcel([])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    expect(aoa[0]).toHaveLength(16 + 10)
  })

  it('B5: header includes all context column labels', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = generateKycReviewDumpExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    for (const label of KYC_DUMP_CONTEXT_HEADERS) {
      expect(header).toContain(label)
    }
  })

  it('B6: header includes all verification column labels', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = generateKycReviewDumpExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    for (const label of KYC_DUMP_VERIFICATION_HEADERS) {
      expect(header).toContain(label)
    }
  })

  it('B7: context columns come before verification columns in header order', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = generateKycReviewDumpExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    const submissionIdIdx  = header.indexOf('Submission ID')
    const bankVerifiedIdx  = header.indexOf('Bank Verified')
    expect(submissionIdIdx).toBeGreaterThanOrEqual(0)
    expect(bankVerifiedIdx).toBeGreaterThan(submissionIdIdx)
  })

  it('B8: verification columns are blank in data rows', async () => {
    const XLSX   = await import('xlsx')
    const rows   = demoKycReviewRows()
    const bytes  = generateKycReviewDumpExcel(rows)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][]
    // Verification columns start at index 16 (0-based)
    const dataRow = aoa[1] as string[]
    for (let i = 16; i < 26; i++) {
      expect(dataRow[i]).toBe('')
    }
  })

  it('B9: first data row Submission ID matches first demo row', async () => {
    const XLSX   = await import('xlsx')
    const rows   = demoKycReviewRows()
    const bytes  = generateKycReviewDumpExcel(rows)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // Submission ID is column 0
    expect(aoa[1][0]).toBe(rows[0].submissionId)
  })

  it('B10: data row count matches input rows count', async () => {
    const XLSX   = await import('xlsx')
    const rows   = demoKycReviewRows()
    const bytes  = generateKycReviewDumpExcel(rows)
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
    // Row 0 = header; rows 1..N = data
    expect(aoa.length).toBe(rows.length + 1)
  })
})

// ─── C: demoKycReviewRows ─────────────────────────────────────────────────────

describe('C — demoKycReviewRows', () => {
  let demoKycReviewRows: typeof import('../kyc-review-dump').demoKycReviewRows

  beforeAll(async () => {
    const mod = await import('../kyc-review-dump')
    demoKycReviewRows = mod.demoKycReviewRows
  })

  it('C1: returns ~8 rows', () => {
    const rows = demoKycReviewRows()
    expect(rows.length).toBeGreaterThanOrEqual(8)
  })

  it('C2: deterministic — calling twice returns deep-equal output', () => {
    expect(demoKycReviewRows()).toEqual(demoKycReviewRows())
  })

  it('C3: every row has a non-empty submissionId', () => {
    demoKycReviewRows().forEach(r => expect(r.submissionId).toBeTruthy())
  })

  it('C4: submissionIds follow the KYC-2026-NNNN pattern', () => {
    demoKycReviewRows().forEach(r =>
      expect(r.submissionId).toMatch(/^KYC-2026-\d{4}$/)
    )
  })

  it('C5: every row has a non-empty outletCode', () => {
    demoKycReviewRows().forEach(r => expect(r.outletCode).toBeTruthy())
  })

  it('C6: every row has a non-empty outletName', () => {
    demoKycReviewRows().forEach(r => expect(r.outletName).toBeTruthy())
  })

  it('C7: every row has a non-empty ownerName', () => {
    demoKycReviewRows().forEach(r => expect(r.ownerName).toBeTruthy())
  })

  it('C8: every row has a non-empty bankName', () => {
    demoKycReviewRows().forEach(r => expect(r.bankName).toBeTruthy())
  })

  it('C9: every row has a non-empty submittedAt', () => {
    demoKycReviewRows().forEach(r => expect(r.submittedAt).toBeTruthy())
  })

  it('C10: submissionIds are all unique', () => {
    const rows = demoKycReviewRows()
    const ids  = rows.map(r => r.submissionId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('C11: first row is Kumar General Store', () => {
    const rows = demoKycReviewRows()
    expect(rows[0].outletName).toBe('Kumar General Store')
  })

  it('C12: second row is Singh Supermart', () => {
    const rows = demoKycReviewRows()
    expect(rows[1].outletName).toBe('Singh Supermart')
  })
})
