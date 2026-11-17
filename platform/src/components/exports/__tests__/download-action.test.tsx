/**
 * M2 / L2 / L3 — the shared report-button state: one busy label ("Preparing…"), a queued request keeps the
 * button disabled as "Being prepared — see Downloads" until the message is dismissed, errors sit below the
 * button, and the screen-reader live region is mounted BEFORE any message appears.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const downloadOrQueue = vi.fn();
vi.mock('@/lib/exports/download', () => ({
  downloadOrQueue: (...a: unknown[]) => downloadOrQueue(...a),
  DOWNLOADS_PAGE_HREF: '/admin/downloads',
}));

import { useDownloadAction, downloadButtonLabel, DOWNLOAD_BUSY_LABEL, DOWNLOAD_QUEUED_LABEL } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '../download-action-status';
import { DOWNLOADS_CHANGED_EVENT } from '@/lib/exports/seen';

function Harness() {
  const a = useDownloadAction();
  return (
    <div>
      <button type="button" disabled={a.blocked} onClick={() => { void a.run('/api/x'); }}>
        {downloadButtonLabel(a, 'Download report')}
      </button>
      <DownloadActionStatus action={a} />
    </div>
  );
}

beforeEach(() => { downloadOrQueue.mockReset(); });

describe('useDownloadAction + DownloadActionStatus', () => {
  it('queued → button disabled as "Being prepared — see Downloads" until dismissed; live region pre-mounted', async () => {
    let resolve!: (v: unknown) => void;
    downloadOrQueue.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const changed = vi.fn();
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, changed);
    render(<Harness />);
    const region = screen.getByTestId('download-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    expect(screen.getByRole('button', { name: DOWNLOAD_BUSY_LABEL })).toBeDisabled();
    await act(async () => { resolve({ kind: 'queued', exportRequestId: 'e1', message: "We're preparing your file." }); });

    const btn = await screen.findByRole('button', { name: DOWNLOAD_QUEUED_LABEL });
    expect(btn).toBeDisabled();
    expect(await screen.findByTestId('download-live-region')).toBe(region); // same node — not re-created
    expect(region).toHaveTextContent(/We're preparing your file\. Open Downloads/);
    expect(changed).toHaveBeenCalled(); // nav badge re-counts
    fireEvent.click(btn);
    expect(downloadOrQueue).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /dismiss message/i }));
    expect(screen.getByRole('button', { name: 'Download report' })).not.toBeDisabled();
    window.removeEventListener(DOWNLOADS_CHANGED_EVENT, changed);
  });

  it('error → plain message below the button (role=alert), button usable again', async () => {
    downloadOrQueue.mockResolvedValue({ kind: 'error', message: 'You already have 3 downloads being prepared.' });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have 3 downloads being prepared.');
    expect(await screen.findByRole('button', { name: 'Download report' })).not.toBeDisabled();
  });

  it('downloaded → back to idle', async () => {
    downloadOrQueue.mockResolvedValue({ kind: 'downloaded', fileName: 'x.xlsx' });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download report' })).not.toBeDisabled());
  });
});
