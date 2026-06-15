/// <reference types="vitest/globals" />
/**
 * TDD — KYC Bulk Verification Parser (revamped contract)
 *
 * Groups:
 *   A — Happy-path approvals: 3 fields approved → 1 update
 *   B — REJECT without remark: error naming the field
 *   C — Unknown / blank Submission ID
 *   D — Invalid decision value
 *   E — Blank decisions are skipped
 *   F — Multi-issue row → single error entry with joined message
 *   G — Summary counts (rowsParsed / fieldsSet / errors)
 *   H — Mixed clean + error rows
 */

import { describe, it, expect, beforeAll } from 'vitest'

// ─── Shared helpers ────────────────────────────────────────────────────────────

const VALID_IDS = new Set(['KYC-2026-0001', 'KYC-2026-0002', 'KYC-2026-0003'])

/** Build a minimal row from the new column contract. */
function makeRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'Submission ID': 'KYC-2026-0001',
    // All field columns blank by default
    'Payment (Bank/UPI) — Decision': '',
    'Payment (Bank/UPI) — Remark':   '',
    'GST Validation — Decision':      '',
    'GST Validation — Remark':        '',
    'GST Document — Decision':        '',
    'GST Document — Remark':          '',
    'Address — Decision':             '',
    'Address — Remark':               '',
    'Address Document — Decision':    '',
    'Address Document — Remark':      '',
    'Store Board Photo — Decision':   '',
    'Store Board Photo — Remark':     '',
    'Owner Photo — Decision':         '',
    'Owner Photo — Remark':           '',
    ...overrides,
  }
}

// ─── A: Happy-path approvals ──────────────────────────────────────────────────

describe('A — 3 fields approved → 1 update with those 3 fields APPROVED', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('A1: produces one update and no errors', () => {
    const row = makeRow({
      'Payment (Bank/UPI) — Decision': 'APPROVE',
      'GST Validation — Decision':      'APPROVE',
      'GST Document — Decision':        'APPROVE',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates).toHaveLength(1)
  })

  it('A2: the update has exactly 3 fields', () => {
    const row = makeRow({
      'Payment (Bank/UPI) — Decision': 'APPROVE',
      'GST Validation — Decision':      'APPROVE',
      'GST Document — Decision':        'APPROVE',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(Object.keys(result.updates[0].fields)).toHaveLength(3)
  })

  it('A3: each approved field has decision APPROVED', () => {
    const row = makeRow({
      'Payment (Bank/UPI) — Decision': 'APPROVE',
      'GST Validation — Decision':      'APPROVE',
      'GST Document — Decision':        'APPROVE',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    const { fields } = result.updates[0]
    expect(fields.PAYMENT?.decision).toBe('APPROVED')
    expect(fields.GST_VALIDATION?.decision).toBe('APPROVED')
    expect(fields.GST_DOCUMENT?.decision).toBe('APPROVED')
  })

  it('A4: "APPROVED" (long form) is also accepted', () => {
    const row = makeRow({ 'Payment (Bank/UPI) — Decision': 'APPROVED' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates[0].fields.PAYMENT?.decision).toBe('APPROVED')
  })

  it('A5: "REJECTED" (long form) is accepted for a field with a remark', () => {
    const row = makeRow({
      'Owner Photo — Decision': 'REJECTED',
      'Owner Photo — Remark':   'Photo blurry',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates[0].fields.OWNER_PHOTO?.decision).toBe('REJECTED')
  })

  it('A6: submissionId is set correctly on the update', () => {
    const row = makeRow({ 'Payment (Bank/UPI) — Decision': 'APPROVE' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.updates[0].submissionId).toBe('KYC-2026-0001')
  })

  it('A7: case-insensitive — "approve" is normalised to APPROVED', () => {
    const row = makeRow({ 'Payment (Bank/UPI) — Decision': 'approve' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates[0].fields.PAYMENT?.decision).toBe('APPROVED')
  })
})

// ─── B: REJECT without remark ─────────────────────────────────────────────────

describe('B — REJECT without remark → error naming the field', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('B1: REJECT with no remark produces one error entry', () => {
    const row = makeRow({ 'Owner Photo — Decision': 'REJECT' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.updates).toHaveLength(0)
  })

  it('B2: error message mentions "Owner Photo"', () => {
    const row = makeRow({ 'Owner Photo — Decision': 'REJECT' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors[0].message).toMatch(/Owner Photo/)
  })

  it('B3: error message mentions "remark"', () => {
    const row = makeRow({ 'GST Document — Decision': 'REJECT' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors[0].message).toMatch(/remark/i)
  })

  it('B4: REJECT with non-empty remark is accepted', () => {
    const row = makeRow({
      'Owner Photo — Decision': 'REJECT',
      'Owner Photo — Remark':   'Blurry image',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates[0].fields.OWNER_PHOTO?.decision).toBe('REJECTED')
    expect(result.updates[0].fields.OWNER_PHOTO?.remark).toBe('Blurry image')
  })
})

// ─── C: Unknown / blank Submission ID ─────────────────────────────────────────

describe('C — Unknown / blank Submission ID', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('C1: unknown ID → error "Unknown or missing Submission ID"', () => {
    const row = makeRow({ 'Submission ID': 'KYC-9999-9999' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/Unknown or missing Submission ID/)
  })

  it('C2: blank ID → error', () => {
    const row = makeRow({ 'Submission ID': '' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].submissionId).toBe('(blank)')
  })

  it('C3: unknown-ID row is excluded from updates', () => {
    const row = makeRow({ 'Submission ID': 'KYC-9999-9999' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.updates).toHaveLength(0)
  })
})

// ─── D: Invalid decision value ────────────────────────────────────────────────

describe('D — Invalid decision value', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('D1: invalid decision "MAYBE" → error referencing the value', () => {
    const row = makeRow({ 'Payment (Bank/UPI) — Decision': 'MAYBE' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/MAYBE/)
    expect(result.errors[0].message).toMatch(/is not APPROVE\/REJECT/)
  })

  it('D2: invalid decision "OK" → error', () => {
    const row = makeRow({ 'GST Validation — Decision': 'OK' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/OK/)
  })

  it('D3: row with invalid decision is excluded from updates', () => {
    const row = makeRow({ 'Address — Decision': 'PENDING' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.updates).toHaveLength(0)
  })
})

// ─── E: Blank decisions are skipped ──────────────────────────────────────────

describe('E — Blank decisions skipped', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('E1: row with all blank decisions produces one update with no fields', () => {
    const row = makeRow()   // all field decisions blank
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(0)
    expect(result.updates).toHaveLength(1)
    expect(Object.keys(result.updates[0].fields)).toHaveLength(0)
  })

  it('E2: blank decision cell does NOT appear in fields', () => {
    const row = makeRow({
      'Payment (Bank/UPI) — Decision': 'APPROVE',
      // all others blank
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.updates[0].fields).toHaveProperty('PAYMENT')
    expect(result.updates[0].fields).not.toHaveProperty('GST_VALIDATION')
  })
})

// ─── F: Multi-issue row → single error with joined message ────────────────────

describe('F — Multi-issue row → single error entry with joined message', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('F1: two REJECT-without-remark fields → one error entry (not two)', () => {
    const row = makeRow({
      'Owner Photo — Decision':  'REJECT',
      'Address — Decision':      'REJECT',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
  })

  it('F2: the single error message contains both field names joined by "; "', () => {
    const row = makeRow({
      'Owner Photo — Decision':  'REJECT',
      'Address — Decision':      'REJECT',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    const msg = result.errors[0].message
    expect(msg).toMatch(/Owner Photo/)
    expect(msg).toMatch(/Address/)
    expect(msg).toContain('; ')
  })

  it('F3: unknown ID + invalid field decision → one error, message contains both issues', () => {
    const row = makeRow({
      'Submission ID':              'KYC-9999-0000',
      'Payment (Bank/UPI) — Decision': 'MAYBE',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.errors).toHaveLength(1)
    const msg = result.errors[0].message
    expect(msg).toMatch(/Unknown or missing Submission ID/)
    expect(msg).toMatch(/MAYBE/)
  })
})

// ─── G: Summary counts ────────────────────────────────────────────────────────

describe('G — Summary counts correct', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('G1: empty input → rowsParsed=0, fieldsSet=0, errors=0', () => {
    const result = parseKycApprovalSheet([], VALID_IDS)
    expect(result.summary).toEqual({ rowsParsed: 0, fieldsSet: 0, errors: 0 })
  })

  it('G2: 1 row with 3 approved fields → rowsParsed=1, fieldsSet=3', () => {
    const row = makeRow({
      'Payment (Bank/UPI) — Decision': 'APPROVE',
      'GST Validation — Decision':      'APPROVE',
      'Owner Photo — Decision':         'APPROVE',
    })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.summary.rowsParsed).toBe(1)
    expect(result.summary.fieldsSet).toBe(3)
    expect(result.summary.errors).toBe(0)
  })

  it('G3: 1 error row → rowsParsed=1, fieldsSet=0, errors=1', () => {
    const row = makeRow({ 'Submission ID': 'KYC-9999-0000' })
    const result = parseKycApprovalSheet([row], VALID_IDS)
    expect(result.summary.rowsParsed).toBe(1)
    expect(result.summary.fieldsSet).toBe(0)
    expect(result.summary.errors).toBe(1)
  })

  it('G4: rowsParsed always equals the number of input rows', () => {
    const rows = [makeRow(), makeRow({ 'Submission ID': 'KYC-2026-0002' })]
    const result = parseKycApprovalSheet(rows, VALID_IDS)
    expect(result.summary.rowsParsed).toBe(2)
  })
})

// ─── H: Mixed clean + error rows ──────────────────────────────────────────────

describe('H — Mixed clean and error rows', () => {
  let parseKycApprovalSheet: typeof import('../kyc-bulk-verify').parseKycApprovalSheet

  beforeAll(async () => {
    const mod = await import('../kyc-bulk-verify')
    parseKycApprovalSheet = mod.parseKycApprovalSheet
  })

  it('H1: 1 clean + 1 error → 1 update, 1 error, rowsParsed=2', () => {
    const cleanRow = makeRow({
      'Submission ID':             'KYC-2026-0001',
      'Payment (Bank/UPI) — Decision': 'APPROVE',
    })
    const errorRow = makeRow({
      'Submission ID': 'KYC-9999-0000',  // unknown
    })
    const result = parseKycApprovalSheet([cleanRow, errorRow], VALID_IDS)
    expect(result.updates).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.summary.rowsParsed).toBe(2)
    expect(result.summary.errors).toBe(1)
    expect(result.summary.fieldsSet).toBe(1)
  })

  it('H2: error row does not bleed into the update list', () => {
    const cleanRow = makeRow({
      'Submission ID':             'KYC-2026-0002',
      'GST Document — Decision':   'APPROVE',
    })
    const errorRow = makeRow({
      'Submission ID':            'KYC-2026-0003',
      'Owner Photo — Decision':   'REJECT',   // no remark → error
    })
    const result = parseKycApprovalSheet([cleanRow, errorRow], VALID_IDS)
    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].submissionId).toBe('KYC-2026-0002')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].submissionId).toBe('KYC-2026-0003')
  })

  it('H3: rowNumber for second row error is 3 (1-based header=1, first-data=2)', () => {
    const cleanRow = makeRow({ 'Submission ID': 'KYC-2026-0001' })
    const errorRow = makeRow({ 'Submission ID': 'KYC-9999-0000' })
    const result   = parseKycApprovalSheet([cleanRow, errorRow], VALID_IDS)
    expect(result.errors[0].rowNumber).toBe(3)
  })
})
