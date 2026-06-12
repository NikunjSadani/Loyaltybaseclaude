/// <reference types="vitest/globals" />
/**
 * TDD — "Submit Visibility Photo" quick action: tenant feature flag
 *
 * The visibility-photo feature is multi-tenant. Deoleo shoots their own photos
 * so they turn it OFF. Other tenants keep it ON.
 *
 * T3: Quick action "Submit Visibility Photo" is present when flag is not set (default ON)
 * T4: Quick action is HIDDEN when GifsySettings.visibilityPhotoEnabled === false
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

const SETTINGS_KEY = 'gifsy_settings_v1';

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

describe('T — Submit Visibility Photo feature flag', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('T3: "Submit Visibility Photo" action is shown when visibilityPhotoEnabled=true (non-Deoleo tenant)', async () => {
    // Deoleo default is false; other tenants explicitly enable it
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ visibilityPhotoEnabled: true }));
    await renderK1();
    expect(screen.getByText(/submit visibility photo/i)).toBeInTheDocument();
  });

  it('T4: "Submit Visibility Photo" action is HIDDEN when visibilityPhotoEnabled = false', async () => {
    // Simulate Deoleo tenant setting: visibility photos disabled
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ visibilityPhotoEnabled: false }));
    await renderK1();
    expect(screen.queryByText(/submit visibility photo/i)).not.toBeInTheDocument();
  });
});
