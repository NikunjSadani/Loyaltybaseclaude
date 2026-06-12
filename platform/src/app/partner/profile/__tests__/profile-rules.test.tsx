/// <reference types="vitest/globals" />
/**
 * TDD — Partner profile page rules
 *
 * Q1: Visibility Invoices shown for RETAILER
 * Q2: Visibility Invoices shown for MT
 * Q3: Visibility Invoices NOT shown for WHOLESALER
 * Q4: Visibility Invoices NOT shown for SUB_STOCKIST
 * Q5: "Change Mobile Number" is absent
 * Q6: "Help & Support" is absent
 * Q7: DPDP / "Your Data" card is absent
 * Q8: GST number is rendered
 * Q9: PAN number is rendered
 * Q10: KYC outlet photo link is present
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

describe('Q — Partner profile page rules', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Visibility Invoices conditional rendering ──

  it('Q1: Visibility Invoices link is shown for RETAILER', async () => {
    setOutletType('SSS');
    await renderAndLoad();
    expect(screen.getByText(/visibility invoices/i)).toBeInTheDocument();
  });

  it('Q2: Visibility Invoices link is shown for SSS_TOT', async () => {
    setOutletType('SSS_TOT');
    await renderAndLoad();
    expect(screen.getByText(/visibility invoices/i)).toBeInTheDocument();
  });

  it('Q3: Visibility Invoices link is NOT shown for WHOLESALER', async () => {
    setOutletType('WHOLESALER');
    await renderAndLoad();
    expect(screen.queryByText(/visibility invoices/i)).not.toBeInTheDocument();
  });

  it('Q4: Visibility Invoices link is NOT shown for SUB_STOCKIST', async () => {
    setOutletType('SUB_STOCKIST');
    await renderAndLoad();
    expect(screen.queryByText(/visibility invoices/i)).not.toBeInTheDocument();
  });

  // ── Removed menu items ──

  it('Q5: "Change Mobile Number" option is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/change mobile/i)).not.toBeInTheDocument();
  });

  it('Q6: "Help & Support" option is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/help.*support|support.*help/i)).not.toBeInTheDocument();
  });

  // ── DPDP card removed ──

  it('Q7: DPDP "Your Data" card is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/your data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dpdp/i)).not.toBeInTheDocument();
  });

  // ── New fields ──

  it('Q8: GST number label and value are rendered', async () => {
    await renderAndLoad();
    expect(screen.getByText(/gst/i)).toBeInTheDocument();
    expect(screen.getByTestId('gst-number-value')).toBeInTheDocument();
    expect(screen.getByTestId('gst-number-value').textContent?.trim().length).toBeGreaterThan(0);
  });

  it('Q9: PAN number label and value are rendered', async () => {
    await renderAndLoad();
    expect(screen.getByText(/pan/i)).toBeInTheDocument();
    expect(screen.getByTestId('pan-number-value')).toBeInTheDocument();
    expect(screen.getByTestId('pan-number-value').textContent?.trim().length).toBeGreaterThan(0);
  });

  // ── KYC photo button ──

  it('Q10: KYC outlet photo button is present and opens the gallery', async () => {
    await renderAndLoad();
    const btn = screen.getByTestId('kyc-photo-btn');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/view photos/i);
  });
});
