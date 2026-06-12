/// <reference types="vitest/globals" />
/**
 * TDD — Outlet code in partner profile
 *
 * P1: outlet code label is present in the rendered profile
 * P2: outlet code value is rendered (the actual code)
 * P3: outlet code appears in the profile header card (dark gradient section)
 * P4: outlet code has monospace styling (font-mono)
 * P5: ProfileData.partner carries an outletCode field (type-level check via runtime)
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import ProfilePage from '../page';

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

async function renderAndLoad() {
  render(<ProfilePage />);
  // Wait for the mock data to load (500 ms setTimeout inside the component)
  await waitFor(
    () => expect(screen.getByText('Kumar General Store')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

/* ─── Tests ──────────────────────────────────────────────────────────────────── */

describe('P — Outlet Code in Partner Profile', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('P1: "Outlet Code" label is visible in the profile', async () => {
    await renderAndLoad();
    expect(screen.getByText(/outlet code/i)).toBeInTheDocument();
  });

  it('P2: the outlet code value is rendered on screen', async () => {
    await renderAndLoad();
    // The mock profile should expose an outlet code string
    const el = screen.getByTestId('outlet-code-value');
    expect(el).toBeInTheDocument();
    expect(el.textContent).toBeTruthy();
  });

  it('P3: outlet code is rendered inside the dark profile header card', async () => {
    await renderAndLoad();
    const header = screen.getByTestId('profile-header');
    expect(header).toContainElement(screen.getByTestId('outlet-code-value'));
  });

  it('P4: outlet code element has font-mono class', async () => {
    await renderAndLoad();
    const el = screen.getByTestId('outlet-code-value');
    expect(el.className).toMatch(/font-mono/);
  });

  it('P5: MOCK_PROFILE partner object has outletCode field', async () => {
    await renderAndLoad();
    // If outletCode exists in mock data and is rendered, the testid will have a non-empty value
    const el = screen.getByTestId('outlet-code-value');
    expect(el.textContent?.length).toBeGreaterThan(0);
  });
});
