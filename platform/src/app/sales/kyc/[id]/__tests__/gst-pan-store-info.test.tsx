/// <reference types="vitest/globals" />
/**
 * TDD — GST and PAN visible in Store Information for the sales team
 *
 * T1: GST number label + value shown when Store Information is expanded
 * T2: PAN number label + value shown when Store Information is expanded
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

async function renderK1() {
  const params = Promise.resolve({ id: 'k1' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  await waitFor(
    () => expect(screen.getByText('Kumar General Store')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('T — GST and PAN in Store Information', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('T1: GST number is shown in the Store Information section', async () => {
    await renderK1();
    fireEvent.click(screen.getByText(/store information/i));
    await waitFor(() => {
      expect(screen.getByTestId('kyc-store-gst')).toBeInTheDocument();
      expect(screen.getByTestId('kyc-store-gst').textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  it('T2: PAN number is shown in the Store Information section', async () => {
    await renderK1();
    fireEvent.click(screen.getByText(/store information/i));
    await waitFor(() => {
      expect(screen.getByTestId('kyc-store-pan')).toBeInTheDocument();
      expect(screen.getByTestId('kyc-store-pan').textContent?.trim().length).toBeGreaterThan(0);
    });
  });
});
