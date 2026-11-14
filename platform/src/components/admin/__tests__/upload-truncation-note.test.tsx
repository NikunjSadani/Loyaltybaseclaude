/// <reference types="vitest/globals" />
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { UploadTruncationNote, TRUNCATION_NEXT } from '../UploadTruncationNote'

describe('UploadTruncationNote (memory-safety: uploads echo ≤ 500 problem rows)', () => {
  it('renders nothing when the list is complete', () => {
    const { container } = render(<UploadTruncationNote shown={3} total={3} truncated={false} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing for an older response without the flag', () => {
    const { container } = render(<UploadTruncationNote shown={3} total={undefined} truncated={undefined} />)
    expect(container.textContent).toBe('')
  })

  it('says how many of how many when the API capped the list (preview wording by default)', () => {
    render(<UploadTruncationNote shown={500} total={1234} truncated noun="errors" />)
    const text = screen.getByRole('status').textContent
    expect(text).toMatch(/Showing the first 500 of 1,234 errors/)
    expect(text).toContain(TRUNCATION_NEXT.PREVIEW)
  })

  it('partial-save uploads say re-upload ONLY the failed rows, never "re-upload the file"', () => {
    render(<UploadTruncationNote shown={500} total={900} truncated noun="failed rows" next={TRUNCATION_NEXT.PARTIAL_SAVE} />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toMatch(/re-upload only the failed rows/i)
    expect(text).not.toMatch(/re-upload the file/i)
  })
})
