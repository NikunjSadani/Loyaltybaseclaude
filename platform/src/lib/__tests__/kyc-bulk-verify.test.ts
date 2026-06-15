/// <reference types="vitest/globals" />
/**
 * TDD — KYC Bulk Verification Parser
 *
 * Groups:
 *   A — Valid APPROVE row: all fields verified, resultingStatus APPROVED
 *   B — APPROVE validation errors: missing required fields
 *   C — REJECT / RE_UPLOAD rules: reason required
 *   D — Field-level validation: Y/N, GST type, Decision enum
 *   E — Unknown / missing Submission ID
 *   F — Summary counts and error exclusion
 *   G — rowNumber offset and error shape
 *   H — Constants
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── Shared helpers ────────────────────────────────────────────────────────────

const VALID_IDS = new Set(['KYC-2026-0001', 'KYC-2026-0002', 'KYC-2026-0003'])

/** A fully valid APPROVE row */
const VALID_APPROVE_ROW: Record<string, string> = {
  'Submission ID':        'KYC-2026-0001',
  'Outlet Name':          'Kumar General Store',
  'Bank Verified':        'Y',
  'Bank Name Match':      'MATCH',
  'Penny-drop Ref':       'PD-20260615-001',
  'GST Registration Type': 'REGULAR',
  'GST Legal Name':       'Kumar Enterprises',
  'GST Status':           'ACTIVE',
  'Address Approved':     'Y',
  'Owner Approved':       'Y',
  'Decision':             'APPROVE',
  'Reason':               '',
}

/** A fully valid RE_UPLOAD row */
const VALID_REUPLOAD_ROW: Record<string, string> = {
  'Submission ID':        'KYC-2026-0002',
  'Outlet Name':          'Singh Supermart',
  'Bank Verified':        'N',
  'Bank Name Match':      'MISMATCH',
  'Penny-drop Ref':       '',
  'GST Registration Type': 'COMPOSITE',
  'GST Legal Name':       'Singh & Co',
  'GST Status':           'ACTIVE',
  'Address Approved':     'Y',
  'Owner Approved':       'Y',
  'Decision':             'RE_UPLOAD',
  'Reason':               'Bank account name mismatch — please upload correct cancelled cheque',
}

/** A fully valid REJECT row */
const VALID_REJECT_ROW: Record<string, string> = {
  'Submission ID':        'KYC-2026-0003',
  'Outlet Name':          'Sharma General Store',
  'Bank Verified':        'N',
  'Bank Name Match':      'MISMATCH',
  'Penny-drop Ref':       '',
  'GST Registration Type': '',
  'GST Legal Name':       '',
  'GST Status':           '',
  'Address Approved':     'N',
  'Owner Approved':       'N',
  'Decision':             'REJECT',
  'Reason':               'GST number does not match submitted documents',
}

// ─── A: Valid APPROVE row ─────────────────────────────────────────────────────

describe('A — Valid APPROVE row', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('A1: produces one previewRow with no errors', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.previewRows).toHaveLength(1)
  })

  it('A2: previewRow has decision=APPROVE', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].decision).toBe('APPROVE')
  })

  it('A3: bankStatus is VERIFIED when Bank Verified=Y', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].bankStatus).toBe('VERIFIED')
  })

  it('A4: gstStatus is VERIFIED when GST Registration Type is set', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].gstStatus).toBe('VERIFIED')
  })

  it('A5: addressStatus is VERIFIED when Address Approved=Y', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].addressStatus).toBe('VERIFIED')
  })

  it('A6: ownerStatus is VERIFIED when Owner Approved=Y', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].ownerStatus).toBe('VERIFIED')
  })

  it('A7: resultingStatus is APPROVED', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].resultingStatus).toBe('APPROVED')
  })

  it('A8: gstRegistrationType is set on the preview row', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].gstRegistrationType).toBe('REGULAR')
  })

  it('A9: submissionId and outletName pass through', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.previewRows[0].submissionId).toBe('KYC-2026-0001')
    expect(result.previewRows[0].outletName).toBe('Kumar General Store')
  })

  it('A10: case-insensitive Decision=approve is accepted', () => {
    const row = { ...VALID_APPROVE_ROW, Decision: 'approve' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.previewRows[0].decision).toBe('APPROVE')
  })
})

// ─── B: APPROVE validation errors ────────────────────────────────────────────

describe('B — APPROVE missing required fields', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('B1: APPROVE with Bank Verified=N → error mentioning Bank Verified=Y', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Bank Verified': 'N' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Bank Verified=Y/)
  })

  it('B2: APPROVE with blank GST Registration Type → error mentioning GST Registration Type', () => {
    const row    = { ...VALID_APPROVE_ROW, 'GST Registration Type': '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/GST Registration Type/)
  })

  it('B3: APPROVE with Address Approved=N → error mentioning Address Approved=Y', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Address Approved': 'N' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Address Approved=Y/)
  })

  it('B4: APPROVE with Owner Approved=N → error mentioning Owner Approved=Y', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Owner Approved': 'N' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Owner Approved=Y/)
  })

  it('B5: APPROVE with all 4 fields missing → single error listing all 4', () => {
    const row = {
      ...VALID_APPROVE_ROW,
      'Bank Verified': 'N',
      'GST Registration Type': '',
      'Address Approved': 'N',
      'Owner Approved': 'N',
    }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    const msg = result.errors[0].message
    expect(msg).toMatch(/Bank Verified=Y/)
    expect(msg).toMatch(/GST Registration Type/)
    expect(msg).toMatch(/Address Approved=Y/)
    expect(msg).toMatch(/Owner Approved=Y/)
  })

  it('B6: errored APPROVE row is NOT in previewRows', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Bank Verified': 'N' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.previewRows).toHaveLength(0)
  })
})

// ─── C: REJECT / RE_UPLOAD rules ─────────────────────────────────────────────

describe('C — REJECT / RE_UPLOAD rules', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('C1: REJECT without Reason → error', () => {
    const row    = { ...VALID_REJECT_ROW, Reason: '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Reason/)
  })

  it('C2: REJECT with Reason → valid, resultingStatus REJECTED', () => {
    const result = parseKycVerificationRows([VALID_REJECT_ROW], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.previewRows[0].resultingStatus).toBe('REJECTED')
  })

  it('C3: RE_UPLOAD without Reason → error', () => {
    const row    = { ...VALID_REUPLOAD_ROW, Reason: '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Reason/)
  })

  it('C4: RE_UPLOAD with Reason → valid, resultingStatus RE_UPLOAD_REQUIRED', () => {
    const result = parseKycVerificationRows([VALID_REUPLOAD_ROW], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.previewRows[0].resultingStatus).toBe('RE_UPLOAD_REQUIRED')
  })

  it('C5: REJECT bankStatus is REJECTED when Bank Verified=N', () => {
    const result = parseKycVerificationRows([VALID_REJECT_ROW], VALID_IDS)
    expect(result.previewRows[0].bankStatus).toBe('REJECTED')
  })

  it('C6: RE_UPLOAD bankStatus is PENDING when Bank Verified=N', () => {
    const result = parseKycVerificationRows([VALID_REUPLOAD_ROW], VALID_IDS)
    expect(result.previewRows[0].bankStatus).toBe('PENDING')
  })

  it('C7: reason passes through on valid RE_UPLOAD preview row', () => {
    const result = parseKycVerificationRows([VALID_REUPLOAD_ROW], VALID_IDS)
    expect(result.previewRows[0].reason).toBe(VALID_REUPLOAD_ROW['Reason'])
  })
})

// ─── D: Field-level validation ────────────────────────────────────────────────

describe('D — Field-level validation', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('D1: invalid Decision value → error', () => {
    const row    = { ...VALID_APPROVE_ROW, Decision: 'MAYBE' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Invalid Decision/)
  })

  it('D2: invalid GST Registration Type → error', () => {
    const row    = { ...VALID_APPROVE_ROW, 'GST Registration Type': 'CASUAL' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/GST Registration Type/)
  })

  it('D3: invalid Bank Verified value → error', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Bank Verified': 'YES' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Bank Verified/)
  })

  it('D4: invalid Address Approved value → error', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Address Approved': 'YES' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Address Approved/)
  })

  it('D5: invalid Owner Approved value → error', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Owner Approved': 'NO' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Owner Approved/)
  })

  it('D6: blank Bank Verified is allowed (not triggering Y/N format error)', () => {
    // Blank Y/N is treated as not-filled (allowed); APPROVE validation catches missing=Y separately.
    // RE_UPLOAD row with blank Bank Verified + valid reason should parse without any Y/N format error.
    const row = {
      ...VALID_REUPLOAD_ROW,
      'Bank Verified': '',
    }
    const result = parseKycVerificationRows([row], VALID_IDS)
    // No errors at all — RE_UPLOAD with reason and blank Bank Verified is valid
    expect(result.errors).toHaveLength(0)
    expect(result.previewRows).toHaveLength(1)
  })

  it('D7: all three valid GST types are accepted (REGULAR, COMPOSITE, UNREGISTERED)', () => {
    for (const gstType of ['REGULAR', 'COMPOSITE', 'UNREGISTERED']) {
      const row    = { ...VALID_APPROVE_ROW, 'GST Registration Type': gstType }
      const result = parseKycVerificationRows([row], VALID_IDS)
      expect(result.errors).toHaveLength(0)
    }
  })
})

// ─── E: Unknown / missing Submission ID ──────────────────────────────────────

describe('E — Unknown / missing Submission ID', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('E1: Submission ID not in validIds → error "Unknown or missing Submission ID"', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': 'KYC-9999-0000' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Unknown or missing Submission ID/)
  })

  it('E2: blank Submission ID → error', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Unknown or missing Submission ID/)
  })

  it('E3: blank Submission ID error has submissionId "(blank)"', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors[0].submissionId).toBe('(blank)')
  })

  it('E4: unknown ID row is excluded from previewRows', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': 'KYC-9999-0000' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.previewRows).toHaveLength(0)
  })
})

// ─── F: Summary counts and error exclusion ────────────────────────────────────

describe('F — Summary counts and error exclusion', () => {
  let parseKycVerificationRows: typeof import('../kyc-bulk-verify').parseKycVerificationRows

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows = mod.parseKycVerificationRows
  })

  it('F1: empty input → all summary fields are 0', () => {
    const result = parseKycVerificationRows([], VALID_IDS)
    expect(result.summary).toEqual({ toApprove: 0, toReupload: 0, toReject: 0, errors: 0, total: 0 })
  })

  it('F2: one valid APPROVE → summary.toApprove=1, total=1', () => {
    const result = parseKycVerificationRows([VALID_APPROVE_ROW], VALID_IDS)
    expect(result.summary.toApprove).toBe(1)
    expect(result.summary.total).toBe(1)
    expect(result.summary.errors).toBe(0)
  })

  it('F3: one valid REJECT → summary.toReject=1', () => {
    const result = parseKycVerificationRows([VALID_REJECT_ROW], VALID_IDS)
    expect(result.summary.toReject).toBe(1)
  })

  it('F4: one valid RE_UPLOAD → summary.toReupload=1', () => {
    const result = parseKycVerificationRows([VALID_REUPLOAD_ROW], VALID_IDS)
    expect(result.summary.toReupload).toBe(1)
  })

  it('F5: error row is counted in summary.errors, not in toApprove/toReupload/toReject', () => {
    const badRow = { ...VALID_APPROVE_ROW, 'Bank Verified': 'N' }
    const result = parseKycVerificationRows([badRow], VALID_IDS)
    expect(result.summary.errors).toBe(1)
    expect(result.summary.toApprove).toBe(0)
    expect(result.summary.total).toBe(1)
  })

  it('F6: mixed rows: 1 valid + 1 error → total=2, errors=1, toApprove=1', () => {
    const badRow = { ...VALID_APPROVE_ROW, 'Bank Verified': 'N' }
    const result = parseKycVerificationRows([VALID_APPROVE_ROW, badRow], VALID_IDS)
    // VALID_APPROVE_ROW (KYC-2026-0001) and badRow (also KYC-2026-0001) — duplicate ID is fine for parsing
    expect(result.summary.total).toBe(2)
    expect(result.summary.errors).toBe(1)
    expect(result.summary.toApprove).toBe(1)
    expect(result.previewRows).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
  })

  it('F7: summary.total = previewRows.length + errors.length', () => {
    const rows   = [VALID_APPROVE_ROW, VALID_REUPLOAD_ROW, VALID_REJECT_ROW]
    const result = parseKycVerificationRows(rows, VALID_IDS)
    expect(result.summary.total).toBe(result.previewRows.length + result.errors.length)
  })
})

// ─── G: rowNumber offset and error shape ──────────────────────────────────────

describe('G — rowNumber offset and error shape', () => {
  let parseKycVerificationRows:   typeof import('../kyc-bulk-verify').parseKycVerificationRows
  let KYC_VERIFY_ROW_NUMBER_OFFSET: number

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycVerificationRows      = mod.parseKycVerificationRows
    KYC_VERIFY_ROW_NUMBER_OFFSET  = mod.KYC_VERIFY_ROW_NUMBER_OFFSET
  })

  it('G1: KYC_VERIFY_ROW_NUMBER_OFFSET is 2', () => {
    expect(KYC_VERIFY_ROW_NUMBER_OFFSET).toBe(2)
  })

  it('G2: first row error has rowNumber === KYC_VERIFY_ROW_NUMBER_OFFSET', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': 'UNKNOWN' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    expect(result.errors[0].rowNumber).toBe(KYC_VERIFY_ROW_NUMBER_OFFSET)
  })

  it('G3: second row error has rowNumber === KYC_VERIFY_ROW_NUMBER_OFFSET + 1', () => {
    const badRow = { ...VALID_APPROVE_ROW, 'Submission ID': 'UNKNOWN' }
    const result = parseKycVerificationRows([VALID_APPROVE_ROW, badRow], VALID_IDS)
    expect(result.errors[0].rowNumber).toBe(KYC_VERIFY_ROW_NUMBER_OFFSET + 1)
  })

  it('G4: error object has rowNumber, submissionId, and message', () => {
    const row    = { ...VALID_APPROVE_ROW, 'Submission ID': '' }
    const result = parseKycVerificationRows([row], VALID_IDS)
    const err    = result.errors[0]
    expect(err).toHaveProperty('rowNumber')
    expect(err).toHaveProperty('submissionId')
    expect(err).toHaveProperty('message')
  })
})

// ─── H: Constants ─────────────────────────────────────────────────────────────

describe('H — Constants', () => {
  const { readFileSync } = require('fs')
  const { resolve }      = require('path')
  const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf-8')

  it('H1: FieldStatus type is exported', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export type FieldStatus/)
  })

  it('H2: KycVerifyPreviewRow interface is exported', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export interface KycVerifyPreviewRow/)
  })

  it('H3: KycVerifyError interface is exported', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export interface KycVerifyError/)
  })

  it('H4: KycVerifyResult interface is exported', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export interface KycVerifyResult/)
  })

  it('H5: parseKycVerificationRows function is exported', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export function parseKycVerificationRows/)
  })

  it('H6: KYC_VERIFY_ROW_NUMBER_OFFSET is exported as const', () => {
    const code = src('src/lib/kyc-bulk-verify.ts')
    expect(code).toMatch(/export const KYC_VERIFY_ROW_NUMBER_OFFSET/)
  })

  it('H7: KYC_DUMP_CONTEXT_HEADERS and KYC_DUMP_VERIFICATION_HEADERS are exported from review-dump', () => {
    const code = src('src/lib/kyc-review-dump.ts')
    expect(code).toMatch(/export const KYC_DUMP_CONTEXT_HEADERS/)
    expect(code).toMatch(/export const KYC_DUMP_VERIFICATION_HEADERS/)
  })
})
