/// <reference types="vitest/globals" />
/**
 * Regression: the Gifsy-admin KYC detail page's Approve / Reject / Request-Reupload
 * buttons used to be LOCAL-ONLY stubs — they flashed a success banner without ever
 * calling the backend, so a Gifsy admin "could not reject a KYC". These tests drive
 * the real KYCReviewer decision controls and assert the page POSTs to the API.
 *
 * AKR1: Reject → POST /api/kyc/:id/reject with status REJECTED
 * AKR2: Request Re-upload → POST /api/kyc/:id/reject with status RE_UPLOAD_REQUIRED
 * AKR3: Approve → POST /api/kyc/:id/approve
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import AdminKYCDetailPage from '../page';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const SUBMISSION = {
  id: TEST_UUID,
  status: 'PENDING_GIFSY',
  submittedAt: '2026-06-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rep Anil', phone: '9000000003', role: 'XSR' },
  partner: {
    id: 'p1', businessName: 'Verma Traders', ownerName: 'Suresh',
    outlets: [{ name: 'Verma Traders', outletCode: 'OUT-2026-001', phone: '7766554433' }],
  },
  documents: [
    { id: 'd1', documentType: 'STORE_BOARD_PHOTO', status: 'SUBMITTED', viewUrl: 'data:image/jpeg;base64,AAAA' },
  ],
  verificationItems: [],
  statusHistory: [],
};

/** fetch mock: GET returns the submission; the POST action returns success. */
function installFetch() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if ((init?.method ?? 'GET') === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { submission: SUBMISSION } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'ok' }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem: () => {}, removeItem: () => {}, clear: () => {} });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

async function renderPage() {
  const params = Promise.resolve({ id: TEST_UUID });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <AdminKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

describe('AKR — admin KYC detail decision wiring', () => {
  it('AKR1: Reject posts to /api/kyc/:id/reject with status REJECTED', async () => {
    const calls = installFetch();
    await renderPage();
    // Open the reject modal, pick a reason, confirm.
    const rejectBtn = await screen.findByRole('button', { name: /reject kyc/i });
    fireEvent.click(rejectBtn);
    fireEvent.click(await screen.findByLabelText('Document is expired'));
    fireEvent.click(screen.getByRole('button', { name: /confirm reject/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes(`/api/kyc/${TEST_UUID}/reject`));
      expect(post).toBeTruthy();
      expect(post!.body).toContain('REJECTED');
    });
  });

  it('AKR2: Request Re-upload posts to /reject with status RE_UPLOAD_REQUIRED', async () => {
    const calls = installFetch();
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /request re-upload/i }));
    fireEvent.click(await screen.findByLabelText('Document is expired'));
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes(`/api/kyc/${TEST_UUID}/reject`));
      expect(post).toBeTruthy();
      expect(post!.body).toContain('RE_UPLOAD_REQUIRED');
    });
  });

  it('AKR3: Approve posts to /api/kyc/:id/approve', async () => {
    const calls = installFetch();
    await renderPage();
    const approveBtn = await screen.findByRole('button', { name: /approve kyc/i });
    fireEvent.click(approveBtn);                                   // arm
    fireEvent.click(await screen.findByRole('button', { name: /confirm approve/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes(`/api/kyc/${TEST_UUID}/approve`));
      expect(post).toBeTruthy();
    });
  });
});
