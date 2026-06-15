/// <reference types="vitest/globals" />
/**
 * TDD — KYC Review Dump Export (revamped contract)
 *
 * Groups:
 *   A — Column constants: KYC_DUMP_TOTAL_COLUMN_COUNT, headers
 *   B — generateKycReviewDumpExcel: Uint8Array, structure, hyperlinks
 *   C — demoKycApprovalEntries: determinism, fields, documents, EXCEL entries
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── A: Column constants ──────────────────────────────────────────────────────

describe('A — Column constants', () => {
  let mod: typeof import('../kyc-review-dump')

  beforeAll(async () => { mod = await import('../kyc-review-dump') })

  it('A1: KYC_DUMP_TOTAL_COLUMN_COUNT === 40', () => {
    expect(mod.KYC_DUMP_TOTAL_COLUMN_COUNT).toBe(40)
  })

  it('A2: KYC_DUMP_CONTEXT_HEADERS has exactly 20 entries', () => {
    expect(mod.KYC_DUMP_CONTEXT_HEADERS).toHaveLength(20)
  })

  it('A3: KYC_DUMP_DOC_HEADERS has exactly 6 entries', () => {
    expect(mod.KYC_DUMP_DOC_HEADERS).toHaveLength(6)
  })

  it('A4: KYC_FIELD_ORDER has exactly 7 entries', () => {
    expect(mod.KYC_FIELD_ORDER).toHaveLength(7)
  })

  it('A5: KYC_FIELD_ORDER keys are the 7 canonical field keys in order', () => {
    const keys = mod.KYC_FIELD_ORDER.map(f => f.key)
    expect(keys).toEqual([
      'PAYMENT', 'GST_VALIDATION', 'GST_DOCUMENT',
      'ADDRESS', 'ADDRESS_DOCUMENT', 'BOARD_PHOTO', 'OWNER_PHOTO',
    ])
  })

  it('A6: context headers start with "Submission ID"', () => {
    expect(mod.KYC_DUMP_CONTEXT_HEADERS[0]).toBe('Submission ID')
  })

  it('A7: doc headers include "GST Certificate" and "Owner Photo"', () => {
    const h = mod.KYC_DUMP_DOC_HEADERS as readonly string[]
    expect(h).toContain('GST Certificate')
    expect(h).toContain('Owner Photo')
  })

  it('A8: kycFieldDecisionHeader returns "<label> — Decision"', () => {
    expect(mod.kycFieldDecisionHeader('Payment (Bank/UPI)')).toBe('Payment (Bank/UPI) — Decision')
  })

  it('A9: kycFieldRemarkHeader returns "<label> — Remark"', () => {
    expect(mod.kycFieldRemarkHeader('Owner Photo')).toBe('Owner Photo — Remark')
  })

  it('A10: 20 context + 6 doc + 14 per-field = 40', () => {
    const perField = mod.KYC_FIELD_ORDER.length * 2   // Decision + Remark each
    expect(mod.KYC_DUMP_CONTEXT_HEADERS.length + mod.KYC_DUMP_DOC_HEADERS.length + perField)
      .toBe(mod.KYC_DUMP_TOTAL_COLUMN_COUNT)
  })
})

// ─── B: generateKycReviewDumpExcel ───────────────────────────────────────────

describe('B — generateKycReviewDumpExcel', () => {
  let mod: typeof import('../kyc-review-dump')

  beforeAll(async () => { mod = await import('../kyc-review-dump') })

  it('B1: returns a non-empty Uint8Array for empty input', () => {
    const bytes = mod.generateKycReviewDumpExcel([])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(100)
  })

  it('B2: returns a non-empty Uint8Array for demo entries', () => {
    const bytes = mod.generateKycReviewDumpExcel(mod.demoKycApprovalEntries())
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(500)
  })

  it('B3: header row has exactly 40 columns', async () => {
    const XLSX  = await import('xlsx')
    const bytes = mod.generateKycReviewDumpExcel([])
    const wb    = XLSX.read(bytes, { type: 'buffer' })
    const ws    = wb.Sheets[wb.SheetNames[0]]
    const aoa   = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    expect(aoa[0]).toHaveLength(40)
  })

  it('B4: header includes all 14 per-field headers', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = mod.generateKycReviewDumpExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    for (const { label } of mod.KYC_FIELD_ORDER) {
      expect(header).toContain(mod.kycFieldDecisionHeader(label))
      expect(header).toContain(mod.kycFieldRemarkHeader(label))
    }
  })

  it('B5: header includes all 6 doc headers', async () => {
    const XLSX   = await import('xlsx')
    const bytes  = mod.generateKycReviewDumpExcel([])
    const wb     = XLSX.read(bytes, { type: 'buffer' })
    const ws     = wb.Sheets[wb.SheetNames[0]]
    const aoa    = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    const header = aoa[0]
    for (const label of mod.KYC_DUMP_DOC_HEADERS) {
      expect(header).toContain(label)
    }
  })

  it('B6: a doc-link cell carries .l.Target when URL is present', async () => {
    const XLSX    = await import('xlsx')
    const entries = mod.demoKycApprovalEntries()
    const bytes   = mod.generateKycReviewDumpExcel(entries)
    const wb      = XLSX.read(bytes, { type: 'buffer' })
    const ws      = wb.Sheets[wb.SheetNames[0]]
    // GST Certificate is doc col index 20 (0-based), data row 1 (r=1)
    // Entry 0 has gstCertificateUrl set
    const cellAddr = XLSX.utils.encode_cell({ r: 1, c: 20 })
    const cell = ws[cellAddr]
    expect(cell).toBeDefined()
    expect(cell.l).toBeDefined()
    expect(typeof cell.l.Target).toBe('string')
    expect(cell.l.Target).toContain('KYC-2026-0001')
  })

  it('B7: PENDING field Decision cell is empty string', async () => {
    const XLSX    = await import('xlsx')
    const entries = mod.demoKycApprovalEntries()
    // entry 0 has all fields PENDING
    const bytes   = mod.generateKycReviewDumpExcel([entries[0]])
    const wb      = XLSX.read(bytes, { type: 'buffer' })
    const ws      = wb.Sheets[wb.SheetNames[0]]
    const aoa     = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][]
    // Decision cols start at index 26 (20 context + 6 doc)
    const dataRow = aoa[1]
    expect(dataRow[26]).toBe('')  // PAYMENT Decision
  })

  it('B8: APPROVED field Decision cell is "APPROVE"', async () => {
    const XLSX    = await import('xlsx')
    const entries = mod.demoKycApprovalEntries()
    // entry index 1 (Singh Supermart) has PAYMENT=APPROVED
    const bytes   = mod.generateKycReviewDumpExcel([entries[1]])
    const wb      = XLSX.read(bytes, { type: 'buffer' })
    const ws      = wb.Sheets[wb.SheetNames[0]]
    const aoa     = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][]
    const dataRow = aoa[1]
    expect(dataRow[26]).toBe('APPROVE')  // PAYMENT Decision col
  })

  it('B9: data row count matches input entries count', async () => {
    const XLSX    = await import('xlsx')
    const entries = mod.demoKycApprovalEntries()
    const bytes   = mod.generateKycReviewDumpExcel(entries)
    const wb      = XLSX.read(bytes, { type: 'buffer' })
    const ws      = wb.Sheets[wb.SheetNames[0]]
    const aoa     = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][]
    expect(aoa.length).toBe(entries.length + 1)
  })
})

// ─── C: demoKycApprovalEntries ────────────────────────────────────────────────

describe('C — demoKycApprovalEntries', () => {
  let mod: typeof import('../kyc-review-dump')

  beforeAll(async () => { mod = await import('../kyc-review-dump') })

  it('C1: returns 8 entries', () => {
    expect(mod.demoKycApprovalEntries()).toHaveLength(8)
  })

  it('C2: deterministic — two calls produce deep-equal output', () => {
    expect(mod.demoKycApprovalEntries()).toEqual(mod.demoKycApprovalEntries())
  })

  it('C3: every entry has exactly 7 fields', () => {
    for (const e of mod.demoKycApprovalEntries()) {
      expect(Object.keys(e.fields)).toHaveLength(7)
    }
  })

  it('C4: every entry has all 7 canonical field keys', () => {
    const expectedKeys = mod.KYC_FIELD_ORDER.map(f => f.key)
    for (const e of mod.demoKycApprovalEntries()) {
      for (const key of expectedKeys) {
        expect(e.fields).toHaveProperty(key)
      }
    }
  })

  it('C5: at least one entry has a pre-set EXCEL field', () => {
    const entries = mod.demoKycApprovalEntries()
    const hasExcel = entries.some(e =>
      Object.values(e.fields).some(f => f.source === 'EXCEL')
    )
    expect(hasExcel).toBe(true)
  })

  it('C6: at least one entry has an APPROVED EXCEL field', () => {
    const entries = mod.demoKycApprovalEntries()
    const hasApprovedExcel = entries.some(e =>
      Object.values(e.fields).some(f => f.source === 'EXCEL' && f.decision === 'APPROVED')
    )
    expect(hasApprovedExcel).toBe(true)
  })

  it('C7: at least one entry has a REJECTED EXCEL field with a remark', () => {
    const entries = mod.demoKycApprovalEntries()
    const hasRejectedExcel = entries.some(e =>
      Object.values(e.fields).some(f => f.source === 'EXCEL' && f.decision === 'REJECTED' && !!f.remark)
    )
    expect(hasRejectedExcel).toBe(true)
  })

  it('C8: every entry has a documents object', () => {
    for (const e of mod.demoKycApprovalEntries()) {
      expect(e.documents).toBeDefined()
      expect(typeof e.documents).toBe('object')
    }
  })

  it('C9: at least one entry has a gstCertificateUrl', () => {
    const hasGstUrl = mod.demoKycApprovalEntries().some(e => !!e.documents.gstCertificateUrl)
    expect(hasGstUrl).toBe(true)
  })

  it('C10: all submissionIds are unique', () => {
    const entries = mod.demoKycApprovalEntries()
    const ids     = entries.map(e => e.submissionId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('C11: first entry is Kumar General Store', () => {
    expect(mod.demoKycApprovalEntries()[0].outletName).toBe('Kumar General Store')
  })

  it('C12: second entry is Singh Supermart', () => {
    expect(mod.demoKycApprovalEntries()[1].outletName).toBe('Singh Supermart')
  })

  it('C13: at least one entry uses UPI payment mode', () => {
    const hasUpi = mod.demoKycApprovalEntries().some(e => e.paymentMode === 'upi')
    expect(hasUpi).toBe(true)
  })

  it('C14: UPI entries have upiId and no bankName', () => {
    for (const e of mod.demoKycApprovalEntries()) {
      if (e.paymentMode === 'upi') {
        expect(e.upiId).toBeTruthy()
        // bank fields should be absent or empty
        expect(e.bankName ?? '').toBe('')
      }
    }
  })

  it('C15: all entries have boardGeo', () => {
    for (const e of mod.demoKycApprovalEntries()) {
      expect(e.boardGeo).toBeDefined()
      expect(typeof e.boardGeo!.lat).toBe('number')
      expect(typeof e.boardGeo!.lng).toBe('number')
    }
  })
})
