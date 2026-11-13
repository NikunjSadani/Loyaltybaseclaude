/// <reference types="vitest/globals" />
/**
 * Memory-safety (2026-11-13): KYC bulk-verify no longer echoes every per-submission outcome.
 * The commit response carries only the FAILED submissions (problemRows, capped at 500) and the
 * parse errors capped at 500 (errorCount = true total). The screen lists the failures and says
 * when a list was cut.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ has: () => true, loading: false }),
}));

import KycApprovalsPage from '../page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(commit: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/kyc/review-queue')) return json({ success: true, data: [] });
    if (url.startsWith('/api/kyc/bulk-verify?apply=false')) {
      return json({
        success: true,
        data: {
          committed: false, updates: [], errors: [], errorCount: 0, errorsTruncated: false,
          summary: { rowsParsed: 3, fieldsSet: 3, submissionsTouched: 3 },
        },
      });
    }
    if (url.startsWith('/api/kyc/bulk-verify?apply=true')) return json({ success: true, data: commit });
    return json({ success: true, data: [] });
  }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('KYC bulk-verify commit — capped echo', () => {
  it('lists the failed submissions and notes when the API capped the list', async () => {
    stubFetch({
      committed: true,
      problemRows: [{ submissionId: 'sub-bad-1', outcome: 'error', detail: 'Submission is no longer pending' }],
      problemRowCount: 650,
      problemRowsTruncated: true,
      errors: [],
      errorCount: 0,
      errorsTruncated: false,
      summary: { rowsParsed: 3, fieldsSet: 3, submissionsTouched: 3, approved: 2, rejected: 0, stillPending: 0, errored: 650 },
    });
    render(<KycApprovalsPage />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'v.xlsx')] } }); });
    await act(async () => { fireEvent.click(screen.getByText(/Validate & Preview/)); });
    await act(async () => { fireEvent.click(await screen.findByText(/Commit \(apply=true\)/)); });

    expect(await screen.findByRole('table', { name: 'Failed submissions' })).toBeInTheDocument();
    expect(screen.getByText('sub-bad-1')).toBeInTheDocument();
    expect(screen.getByText('Submission is no longer pending')).toBeInTheDocument();
    expect(screen.getByText(/Showing the first 1 of 650 failed submissions/)).toBeInTheDocument();
  });
});
