/// <reference types="vitest/globals" />
/**
 * TDD — Points Summary visibility and content rules (Deoleo tenant)
 *
 * U1: Points Summary card is shown for WHOLESALER
 * U2: Points Summary card is NOT shown for RETAILER
 * U3: Points Summary card is NOT shown for SUB_STOCKIST
 * U4: Points Summary card is NOT shown for MT
 * U5: Points Summary shows "Redeemable" label
 * U6: Points Summary does NOT show "Available" label
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const SESSION_KEY = 'partner_outlet_type_demo';

import ProfilePage from '../page';

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function setOutletType(type: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT') {
  localStorage.setItem(SESSION_KEY, type);
}

async function renderAndLoad() {
  render(<ProfilePage />);
  await waitFor(
    () => expect(screen.getByTestId('profile-header')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

/* ─── Tests ──────────────────────────────────────────────────────────────────── */

describe('U — Points Summary rules (Deoleo tenant)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Visibility by outlet type ──

  it('U1: Points Summary card is shown for WHOLESALER', async () => {
    setOutletType('WHOLESALER');
    await renderAndLoad();
    expect(screen.getByTestId('points-summary')).toBeInTheDocument();
  });

  it('U2: Points Summary card is NOT shown for RETAILER', async () => {
    setOutletType('SSS');
    await renderAndLoad();
    expect(screen.queryByTestId('points-summary')).not.toBeInTheDocument();
  });

  it('U3: Points Summary card is NOT shown for SUB_STOCKIST', async () => {
    setOutletType('SUB_STOCKIST');
    await renderAndLoad();
    expect(screen.queryByTestId('points-summary')).not.toBeInTheDocument();
  });

  it('U4: Points Summary card is NOT shown for SSS_TOT', async () => {
    setOutletType('SSS_TOT');
    await renderAndLoad();
    expect(screen.queryByTestId('points-summary')).not.toBeInTheDocument();
  });

  // ── Content ──

  it('U5: Points Summary shows "Redeemable" label', async () => {
    setOutletType('WHOLESALER');
    await renderAndLoad();
    expect(screen.getByTestId('points-summary')).toHaveTextContent(/redeemable/i);
  });

  it('U6: Points Summary does NOT show "Available" label', async () => {
    setOutletType('WHOLESALER');
    await renderAndLoad();
    expect(screen.getByTestId('points-summary')).not.toHaveTextContent(/available/i);
  });
});
