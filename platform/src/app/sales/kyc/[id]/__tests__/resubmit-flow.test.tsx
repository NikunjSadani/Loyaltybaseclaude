/// <reference types="vitest/globals" />
/**
 * TDD — Approval flow for re-submitted rejected KYC
 *
 * Rule: After fixing a rejected KYC, resubmission follows the SAME approval
 * chain as a fresh KYC (submitter → immediate senior → Gifsy).
 * Edge case: if the immediate senior's phone is blank (resigned), escalate
 * to the next level — just like fresh KYC — and record escalatedFrom.
 *
 * T13: After resubmitting a rejected KYC (submitted by XSR), status → PENDING_SO_APPROVAL
 * T14: If SO phone is vacant, status → PENDING_ASM_APPROVAL and escalatedFrom = 'SO'
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

// We need to be able to inject custom ROLE_PHONES for the escalation test.
// The detail page imports resolveApprover from @/lib/sales-role.
// We mock sales-role so we can simulate a vacant SO phone.
import * as salesRole from '@/lib/sales-role';

import SalesKYCDetailPage from '../page';

async function renderK3() {
  const params = Promise.resolve({ id: 'k3' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  await waitFor(
    () => expect(screen.getByText('Patel Grocery')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

async function clickResubmit() {
  // Upload at least one file to enable the button
  const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(fileInput).toBeTruthy();

  // Simulate a file selection (jsdom has no DataTransfer — build a minimal FileList)
  const file = new File(['dummy'], 'photo.jpg', { type: 'image/jpeg' });
  const mockFileList = Object.assign([file], {
    length: 1,
    item: (i: number) => (i === 0 ? file : null),
  });
  Object.defineProperty(fileInput!, 'files', { value: mockFileList, configurable: true });
  fireEvent.change(fileInput!);

  // Wait for the resubmit button to become enabled
  await waitFor(
    () => {
      const btn = screen.getByRole('button', { name: /resubmit for review/i });
      expect(btn).not.toBeDisabled();
    },
    { timeout: 2000 },
  );
  fireEvent.click(screen.getByRole('button', { name: /resubmit for review/i }));
}

describe('T — Resubmit approval flow', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('T13: resubmitting a rejected XSR-submitted KYC routes to PENDING_SO_APPROVAL', async () => {
    await renderK3();
    await clickResubmit();

    // After 1000 ms (the resubmit delay), status badge should show "Awaiting SO"
    await waitFor(
      () => expect(screen.getByText(/awaiting so/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('T14: if SO is vacant, resubmission escalates to ASM and marks escalatedFrom', async () => {
    // Simulate a vacant SO — capture the original BEFORE spying to avoid self-recursion
    const originalResolveApprover = salesRole.resolveApprover;
    vi.spyOn(salesRole, 'resolveApprover').mockImplementation(
      (role, phones) => originalResolveApprover(role, { ...salesRole.ROLE_PHONES, SO: '' }),
    );

    await renderK3();
    await clickResubmit();

    // Should escalate to ASM
    await waitFor(
      () => expect(screen.getByText(/awaiting asm/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // Escalation banner should show
    await waitFor(
      () => expect(screen.getByText(/approval escalated/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});
