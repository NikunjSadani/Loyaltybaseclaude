/**
 * RosterRemoveByExcelPanel — bulk-remove roster outlets by uploading an Excel of Outlet IDs.
 *
 * Load-bearing contract:
 *   • choosing a file runs a dryRun PREVIEW (no writes) and shows will-remove / hidden-enrollment
 *     / not-found counts;
 *   • Confirm performs the real removal (dryRun:false), surfaces the result, and calls onRemoved;
 *   • a preview with willRemove:0 shows "nothing to remove" and offers NO destructive button.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const removeRosterByUpload = vi.fn();
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    removeRosterByUpload: (...a: unknown[]) => removeRosterByUpload(...a),
  },
}));

import { RosterRemoveByExcelPanel } from '../SchemeAudienceEditor';

const onRemoved = vi.fn();

function renderPanel() {
  return render(<RosterRemoveByExcelPanel schemeId="s1" onRemoved={onRemoved} />);
}

function chooseFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'remove.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('RosterRemoveByExcelPanel', () => {
  it('previews on file select (dryRun) and shows will-remove / enrollment / not-found detail', async () => {
    removeRosterByUpload.mockResolvedValueOnce({
      success: true,
      data: { dryRun: true, totalRefs: 3, willRemove: 2, withEnrollmentCount: 1, notFoundCount: 1, notFoundRefs: ['OUT3'] },
    });
    const { container } = renderPanel();
    chooseFile(container);

    await waitFor(() => expect(screen.getByText(/2 of 3 Outlet IDs will be removed/i)).toBeInTheDocument());
    // the first call is a preview, never a write
    expect(removeRosterByUpload).toHaveBeenCalledWith('s1', expect.any(File), { idColumn: undefined, dryRun: true });
    expect(screen.getByText(/a filled enrollment/i)).toBeInTheDocument();
    expect(screen.getByText(/OUT3/)).toBeInTheDocument();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('Confirm performs the real removal (dryRun:false), reports the result, and calls onRemoved', async () => {
    removeRosterByUpload
      .mockResolvedValueOnce({
        success: true,
        data: { dryRun: true, totalRefs: 3, willRemove: 2, withEnrollmentCount: 1, notFoundCount: 1, notFoundRefs: ['OUT3'] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { dryRun: false, totalRefs: 3, removed: 2, removedWithEnrollment: 1, notFoundCount: 1, notFoundRefs: ['OUT3'] },
      });
    const { container } = renderPanel();
    chooseFile(container);

    const confirm = await screen.findByRole('button', { name: /Remove 2 outlets/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(removeRosterByUpload).toHaveBeenNthCalledWith(2, 's1', expect.any(File), { idColumn: undefined, dryRun: false });
    expect(screen.getByText(/Removed 2 outlets/i)).toBeInTheDocument();
    expect(screen.getByText(/1 had a filled enrollment/i)).toBeInTheDocument();
  });

  it('a preview with nothing to remove shows the notice and offers no destructive button', async () => {
    removeRosterByUpload.mockResolvedValueOnce({
      success: true,
      data: { dryRun: true, totalRefs: 3, willRemove: 0, withEnrollmentCount: 0, notFoundCount: 3, notFoundRefs: ['OUT1', 'OUT2', 'OUT3'] },
    });
    const { container } = renderPanel();
    chooseFile(container);

    await waitFor(() => expect(screen.getByText(/Nothing to remove/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Remove \d+ outlet/i })).not.toBeInTheDocument();
  });

  it('surfaces a backend error from the preview call', async () => {
    removeRosterByUpload.mockResolvedValueOnce({ success: false, error: 'Invalid or corrupted xlsx file' });
    const { container } = renderPanel();
    chooseFile(container);
    await waitFor(() => expect(screen.getByText(/Invalid or corrupted xlsx file/i)).toBeInTheDocument());
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
