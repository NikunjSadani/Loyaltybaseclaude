/// <reference types="vitest/globals" />
/**
 * FTS — Sales KYC detail: GIFSY-reject fast-track (Bajaj flag gifsyRejectFastTrack).
 *
 * FTS1: fastTrack + PENDING_GIFSY → the "sent straight to GIFSY" note; the stepper's manager step
 *       reads "Skipped" (never "Approved" / "Approved by SO" from the DRAFT→PENDING_GIFSY row);
 *       Gifsy step is active; no Approve / Reject buttons — even for an ASM / SO viewer.
 * FTS2: fastTrack null → no note, stepper unchanged ("Approved by ASM").
 * FTS3: fastTrack missing (older API) → no note.
 * FTS4: fast-tracked KYC later rejected by GIFSY → manager step still "Skipped", NO note once decided.
 * FTS5 (F4): ANY rejection of a fast-tracked KYC is Gifsy's — even a legacy row with no stage — so the
 *       stepper never shows "SO Review — Rejected" under a skipped step.
 * FTS6 (F3): approved fast-tracked KYC → no note; step "Skipped".
 */
import React, { Suspense, act } from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

// F3: one line inside the existing PENDING_GIFSY box (sales surfaces use the page's "Gifsy" casing).
const NOTE = 'Sent directly to Gifsy. Your manager does not need to approve it again.';
const SKIPPED = 'Not needed — resent after Gifsy rejection';
const HISTORY_NOTE = 'Resubmitted after a GIFSY rejection — sent directly to GIFSY; managers did not re-approve.';
const LOAD = { timeout: 15_000 }; // never below the suite asyncUtilTimeout (vitest.setup.ts)

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const FAST = { previousSubmissionId: 'kyc-prev', previousRejectedAt: daysAgo(3) };

function submission(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'kyc-1',
    status,
    submittedAt: daysAgo(2),
    rejectionReason: null,
    user: { id: 'u1', name: 'Rep Anil', phone: '9000000003', role: 'SO' },
    partner: {
      id: 'p1', businessName: 'Charan Trading', ownerName: 'Charan',
      outlets: [{ id: 'o1', name: 'Charan Trading', outletCode: 'OUT-2026-009', phone: '7766554433' }],
    },
    documents: [],
    // The backend's fast-track row: DRAFT→PENDING_GIFSY, no approver.
    statusHistory: [{ toStatus: 'PENDING_GIFSY', createdAt: daysAgo(2), notes: HISTORY_NOTE, metadata: null }],
    ...extra,
  };
}

async function renderWith(sub: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: sub } }),
  }));
  const params = Promise.resolve({ id: 'kyc-1' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { localStorage.clear(); localStorage.setItem('loyaltybase_sales_role', 'ASM'); });

describe('FTS — sales KYC fast-track', { timeout: 30_000 }, () => {
  it('FTS1: PENDING_GIFSY fast-track → one line in the PENDING_GIFSY box, manager step "Skipped", Gifsy active', async () => {
    await renderWith(submission('PENDING_GIFSY', { fastTrack: FAST }));

    const note = await screen.findByTestId('fast-track-note', undefined, LOAD);
    expect(note).toHaveTextContent(NOTE);
    // Merged INTO the existing PENDING_GIFSY box — not a second box.
    const box = await screen.findByTestId('pending-gifsy-notice');
    expect(box).toContainElement(note);
    expect(box).toHaveTextContent('Awaiting final validation by Gifsy. No action required from your side.');

    const manager = await screen.findByTestId('timeline-step-first-approver');
    expect(await within(manager).findByText('Manager Review')).toBeInTheDocument();
    expect(manager).toHaveTextContent(SKIPPED);
    expect(manager).not.toHaveTextContent(/approved/i);
    expect(within(manager).getByTestId('step-dot-skipped')).toBeInTheDocument();
    expect(await screen.findByTestId('timeline-step-gifsy')).toHaveTextContent(/under gifsy review/i);

    // A manager viewing it cannot act — it is with GIFSY.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    expect(screen.getByText('Awaiting final validation by Gifsy. No action required from your side.')).toBeInTheDocument();
  });

  it('FTS1b: SO viewer also gets no approve/reject on a fast-tracked KYC', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'SO');
    await renderWith(submission('PENDING_GIFSY', { fastTrack: FAST }));
    await screen.findByTestId('fast-track-note', undefined, LOAD);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('FTS2: fastTrack null → no note; normal stepper ("Approved by ASM")', async () => {
    await renderWith(submission('PENDING_GIFSY', {
      fastTrack: null,
      statusHistory: [{ toStatus: 'PENDING_GIFSY', createdAt: daysAgo(2), notes: 'Approved by ASM', metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } }],
    }));
    const manager = await screen.findByTestId('timeline-step-first-approver', undefined, LOAD);
    expect(manager).toHaveTextContent(/approved by asm/i);
    expect(screen.queryByTestId('fast-track-note')).toBeNull();
    expect(screen.queryByTestId('step-dot-skipped')).toBeNull();
  });

  it('FTS3: fastTrack missing (older API) → no note', async () => {
    await renderWith(submission('PENDING_GIFSY', {
      statusHistory: [{ toStatus: 'PENDING_GIFSY', createdAt: daysAgo(2), notes: null, metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } }],
    }));
    await screen.findByTestId('timeline-step-first-approver', undefined, LOAD);
    expect(screen.queryByTestId('fast-track-note')).toBeNull();
  });

  it('FTS4: fast-tracked KYC then rejected by GIFSY → manager step stays "Skipped", no note once decided', async () => {
    await renderWith(submission('REJECTED', {
      fastTrack: FAST,
      rejectionReason: 'PAN photo blurred',
      statusHistory: [
        { toStatus: 'REJECTED', createdAt: daysAgo(1), notes: 'PAN photo blurred', metadata: { stage: 'GIFSY' } },
        { toStatus: 'PENDING_GIFSY', createdAt: daysAgo(2), notes: HISTORY_NOTE, metadata: null },
      ],
    }));
    const manager = await screen.findByTestId('timeline-step-first-approver', undefined, LOAD);
    expect(manager).toHaveTextContent(SKIPPED);
    expect(await screen.findByTestId('timeline-step-gifsy')).toHaveTextContent(/rejected — pan photo blurred/i);
    expect(screen.queryByTestId('fast-track-note')).toBeNull();
  });

  it('FTS5 (F4): rejection row WITHOUT a Gifsy stage on a fast-tracked KYC → still Gifsy-rejected, never "SO Review — Rejected"', async () => {
    await renderWith(submission('RE_UPLOAD_REQUIRED', {
      fastTrack: FAST,
      rejectionReason: 'Cheque unreadable',
      statusHistory: [
        // Legacy/raw row: no metadata.stage → the default classifier would call it a first-approver rejection.
        { toStatus: 'RE_UPLOAD_REQUIRED', createdAt: daysAgo(1), notes: 'Cheque unreadable', metadata: null },
        { toStatus: 'PENDING_GIFSY', createdAt: daysAgo(2), notes: HISTORY_NOTE, metadata: null },
      ],
    }));
    const manager = await screen.findByTestId('timeline-step-first-approver', undefined, LOAD);
    expect(manager).toHaveTextContent('Manager Review');
    expect(manager).toHaveTextContent(SKIPPED);
    expect(manager).not.toHaveTextContent(/rejected/i);
    expect(within(manager).queryByText(/SO Review/)).toBeNull();
    expect(await screen.findByTestId('timeline-step-gifsy')).toHaveTextContent(/rejected — cheque unreadable/i);
  });

  it('FTS6 (F3): approved fast-tracked KYC → no note (an approved KYC opens the outlet view, no stepper)', async () => {
    await renderWith(submission('APPROVED', { fastTrack: FAST }));
    expect(await screen.findByTestId('outlet-detail-back', undefined, LOAD)).toBeInTheDocument();
    expect(screen.queryByTestId('fast-track-note')).toBeNull();
    expect(screen.queryByTestId('pending-gifsy-notice')).toBeNull();
  });
});
