/// <reference types="vitest/globals" />
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { UploadTruncationNote } from '../UploadTruncationNote'

describe('UploadTruncationNote (memory-safety: uploads echo ≤ 500 problem rows)', () => {
  it('renders nothing when the list is complete', () => {
    const { container } = render(<UploadTruncationNote shown={3} total={3} truncated={false} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing for an older response without the flag', () => {
    const { container } = render(<UploadTruncationNote shown={3} total={undefined} truncated={undefined} />)
    expect(container.textContent).toBe('')
  })

  it('says how many of how many when the API capped the list', () => {
    render(<UploadTruncationNote shown={500} total={1234} truncated noun="errors" />)
    expect(screen.getByRole('status').textContent).toMatch(/Showing the first 500 of 1,234 errors/)
  })
})
