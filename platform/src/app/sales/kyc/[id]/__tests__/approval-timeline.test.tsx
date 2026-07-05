/// <reference types="vitest/globals" />
/**
 * TIMELINE — Approval Status stepper on the sales KYC detail page.
 *
 * The stepper (Submitted → first-approver → Gifsy) must reflect the CURRENT
 * submission's true state across all cycles — a re-KYC'd + rejected outlet must NOT
 * show a stale prior-cycle "Approved" / "Queued for Gifsy".
 *
 * Cases covered:
 *   T1 (the bug): stale FIRST_APPROVER APPROVED then a newer REJECTED, status REJECTED
 *      → first-approver step = Rejected, Gifsy step = pending (never "Queued for Gifsy").
 *   T2: happy PENDING_GIFSY → first-approver complete (Approved by X), Gifsy active.
 *   T3: fresh submit awaiting first approver (PENDING_ASM) → first-approver active,
 *      Gifsy pending.
 *   T4: Gifsy rejection → first-approver complete, Gifsy rejected.
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

interface HistoryRow {
  toStatus: string;
  createdAt: string;
  notes?: string | null;
  metadata?: { stage?: string; approverRole?: string } | null;
}

/** Build an API submission with a given status + statusHistory (newest-first, as the
 *  backend returns it via GET /v1/kyc/:id `orderBy createdAt desc`). */
function submission(status: string, statusHistory: HistoryRow[], rejectionReason: string | null = null) {
  return {
    id: 'kyc-1',
    status,
    submittedAt: '2026-06-01T00:00:00.000Z',
    rejectionReason,
    user: { id: 'u1', name: 'Rep Anil', phone: '9000000003', role: 'SO' },
    partner: {
      id: 'p1', businessName: 'Charan Trading', ownerName: 'Charan',
      outlets: [{ id: 'o1', name: 'Charan Trading', outletCode: 'OUT-2026-009', phone: '7766554433' }],
    },
    documents: [],
    statusHistory,
  };
}

async function renderWith(sub: ReturnType<typeof submission>) {
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
// SO submitter → first-approver label is "ASM Review".
beforeEach(() => { localStorage.clear(); localStorage.setItem('loyaltybase_sales_role', 'SO'); });

describe('TIMELINE — Approval Status stepper', () => {
  it('T1 (bug): re-KYC then first-approver rejection shows ASM Review = Rejected, Gifsy = pending (no "Queued for Gifsy")', async () => {
    // Chronology (backend returns newest-first): original approval cycle, admin re-KYC,
    // then a first-approver rejection. The OLD FIRST_APPROVER APPROVED must NOT win.
    await renderWith(submission('REJECTED', [
      { toStatus: 'REJECTED',        createdAt: '2026-06-05T00:00:00Z', notes: 'Others: Phone number is incorrect', metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } },
      { toStatus: 'RE_KYC_REQUIRED', createdAt: '2026-06-04T00:00:00Z', notes: 'Mobile number re-capture', metadata: { stage: 'GIFSY' } },
      { toStatus: 'APPROVED',        createdAt: '2026-06-03T00:00:00Z', notes: null, metadata: { stage: 'GIFSY' } },
      { toStatus: 'PENDING_GIFSY',   createdAt: '2026-06-02T00:00:00Z', notes: null, metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } },
    ], 'Others: Phone number is incorrect'));

    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    const gifsy = await screen.findByTestId('timeline-step-gifsy');

    // ASM Review = Rejected (with approver + current remark), NOT "Approved by".
    expect(within(firstApprover).getByText('ASM Review')).toBeInTheDocument();
    expect(firstApprover).toHaveTextContent(/rejected/i);
    expect(firstApprover).toHaveTextContent('Others: Phone number is incorrect');
    expect(firstApprover).not.toHaveTextContent(/approved by/i);

    // Gifsy = pending — never "Queued for Gifsy" / "Approved".
    expect(gifsy).not.toHaveTextContent(/queued for gifsy/i);
    expect(gifsy).not.toHaveTextContent(/under gifsy review/i);
    expect(gifsy).not.toHaveTextContent(/^Approved$/);
  });

  it('T2: PENDING_GIFSY shows first approver complete (Approved by ASM) + Gifsy active', async () => {
    await renderWith(submission('PENDING_GIFSY', [
      { toStatus: 'PENDING_GIFSY', createdAt: '2026-06-02T00:00:00Z', notes: 'Approved by ASM', metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } },
    ]));

    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    const gifsy = await screen.findByTestId('timeline-step-gifsy');

    expect(firstApprover).toHaveTextContent(/approved by asm/i);
    expect(firstApprover).not.toHaveTextContent(/rejected/i);
    expect(gifsy).toHaveTextContent(/under gifsy review/i);
  });

  it('T3: fresh submit awaiting ASM (PENDING_ASM_APPROVAL) → first-approver active, Gifsy pending', async () => {
    await renderWith(submission('PENDING_ASM_APPROVAL', []));

    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    const gifsy = await screen.findByTestId('timeline-step-gifsy');

    expect(firstApprover).toHaveTextContent(/awaiting review/i);
    expect(gifsy).not.toHaveTextContent(/queued for gifsy/i);
    expect(gifsy).not.toHaveTextContent(/under gifsy review/i);
  });

  // ── First-approver LABEL — derived from the actual reviewer level, not the
  //    submitter (which was mis-cast so `=== 'XSR'` never matched → always "ASM Review").
  it('L1 (bug): XSR-submitted, PENDING_SO_APPROVAL, no approval events → label = "SO Review"', async () => {
    await renderWith(submission('PENDING_SO_APPROVAL', []));
    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    // The status badge already read "Awaiting SO"; the stepper label must match, not "ASM Review".
    expect(within(firstApprover).getByText('SO Review')).toBeInTheDocument();
    expect(firstApprover).not.toHaveTextContent(/asm review/i);
  });

  it('L2: PENDING_ASM_APPROVAL (SO submitted / vacant-SO escalation) → label = "ASM Review"', async () => {
    await renderWith(submission('PENDING_ASM_APPROVAL', []));
    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    expect(within(firstApprover).getByText('ASM Review')).toBeInTheDocument();
  });

  it('L3: acted FIRST_APPROVER event with role SALES_SO → label = "SO Review"', async () => {
    await renderWith(submission('PENDING_GIFSY', [
      { toStatus: 'PENDING_GIFSY', createdAt: '2026-06-02T00:00:00Z', notes: 'Approved by SO', metadata: { stage: 'FIRST_APPROVER', approverRole: 'SALES_SO' } },
    ]));
    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    expect(within(firstApprover).getByText('SO Review')).toBeInTheDocument();
    expect(firstApprover).not.toHaveTextContent(/asm review/i);
  });

  it('T4: Gifsy rejection → first-approver complete, Gifsy rejected (with remark)', async () => {
    await renderWith(submission('REJECTED', [
      { toStatus: 'REJECTED',      createdAt: '2026-06-05T00:00:00Z', notes: 'Docs mismatch', metadata: { stage: 'GIFSY', approverRole: 'GIFSY_ADMIN' } },
      { toStatus: 'PENDING_GIFSY', createdAt: '2026-06-02T00:00:00Z', notes: 'Approved by ASM', metadata: { stage: 'FIRST_APPROVER', approverRole: 'ASM' } },
    ], 'Docs mismatch'));

    const firstApprover = await screen.findByTestId('timeline-step-first-approver');
    const gifsy = await screen.findByTestId('timeline-step-gifsy');

    // First approver cleared this cycle — complete, not rejected.
    expect(firstApprover).toHaveTextContent(/approved by asm/i);
    expect(firstApprover).not.toHaveTextContent(/rejected/i);
    // Gifsy carries the rejection + remark.
    expect(gifsy).toHaveTextContent(/rejected/i);
    expect(gifsy).toHaveTextContent('Docs mismatch');
  });
});
