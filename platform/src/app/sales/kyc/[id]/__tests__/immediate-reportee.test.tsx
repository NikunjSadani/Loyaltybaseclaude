/// <reference types="vitest/globals" />
/**
 * Outlet-detail — manager-only "immediate reportee" contact row + context back arrow.
 *
 * IR1: a MANAGER (hasTeamView) viewing an outlet whose backend resolves an immediate reportee
 *      sees a "Contact: {name}" row with a tap-to-call (tel:) link.
 * IR2: when the backend resolves null (no reportee in the chain), NOTHING renders — no empty row.
 * IR3: an ISR/leaf viewer (no team view) never shows the row AND never calls the endpoint.
 * IR4: a resolved reportee with no phone shows the name but no call link.
 *
 * BACK1: the header back arrow calls router.back() when there is in-app history.
 * BACK2: it falls back to router.push('/sales/kyc') on a deep link (history.length <= 1).
 */

import React, { Suspense, act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { GifsySettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/lib/gifsy-settings';

const mockRouter = { push: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// The page reads the sales role via getRole(); keep the REAL hasTeamView so the gate is honest.
let roleMock = 'ASM';
vi.mock('@/lib/sales-role', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/sales-role');
  return { ...actual, getRole: () => roleMock };
});

let mockSettings: GifsySettings = DEFAULT_SETTINGS;
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/gifsy-settings');
  return { ...actual, useGifsySettings: () => mockSettings };
});

import SalesKYCDetailPage from '../page';

function submission() {
  return {
    id: 'KYC42',
    status: 'APPROVED',
    submittedAt: '2026-05-01T00:00:00.000Z',
    rejectionReason: null,
    user: { id: 'u1', name: 'Anil Rep', phone: '9900000011', role: 'SALES_SO' },
    partner: {
      id: 'p1',
      businessName: 'Mehta Distributors',
      ownerName: 'Mehta',
      address: '12 Market Rd',
      city: 'Pune',
      state: 'Maharashtra',
      outlets: [{
        id: 'OUT9', name: 'Mehta Distributors', outletCode: 'W123', phone: '9900000011',
        addressLine1: '12 Market Rd', city: 'Pune', state: 'Maharashtra', pincode: '411001',
        outletType: { code: 'WHOLESALER' },
      }],
    },
    documents: [],
    statusHistory: [],
  };
}

/** URL-aware fetch: the KYC detail for /api/kyc/:id, the given payload for /api/sales/outlet-reportee,
 *  and a benign empty success for everything else (outlet-targets etc. then self-hide). */
function stubFetch(reporteePayload: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/sales/outlet-reportee')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(reporteePayload) });
    }
    if (url.startsWith('/api/kyc/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { submission: submission() } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function renderPage(id: string) {
  const params = Promise.resolve({ id });
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  return result;
}

function setHistoryLength(n: number) {
  Object.defineProperty(window.history, 'length', { configurable: true, value: n });
}

beforeEach(() => { mockSettings = DEFAULT_SETTINGS; roleMock = 'ASM'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setHistoryLength(1); });

describe('Outlet-detail immediate-reportee contact row', () => {
  it('IR1: a manager sees "Contact: {name}" with a tap-to-call tel: link', async () => {
    stubFetch({ success: true, data: { immediateReportee: { name: 'Ravi SO', phone: '9876500001' } } });
    await renderPage('KYC42');

    const row = await screen.findByTestId('immediate-reportee-row');
    expect(row).toHaveTextContent('Ravi SO');
    const call = await screen.findByTestId('immediate-reportee-call');
    expect(call).toHaveAttribute('href', 'tel:9876500001');
  });

  it('IR2: renders nothing when the backend resolves null (no reportee in chain)', async () => {
    stubFetch({ success: true, data: { immediateReportee: null } });
    await renderPage('KYC42');

    await screen.findAllByText('Mehta Distributors'); // page hydrated
    expect(screen.queryByTestId('immediate-reportee-row')).toBeNull();
  });

  it('IR3: an ISR/leaf viewer never shows the row and never calls the endpoint', async () => {
    roleMock = 'XSR'; // leaf → hasTeamView false
    const fn = stubFetch({ success: true, data: { immediateReportee: { name: 'Ravi SO', phone: '9876500001' } } });
    await renderPage('KYC42');

    await screen.findAllByText('Mehta Distributors');
    expect(screen.queryByTestId('immediate-reportee-row')).toBeNull();
    const calledReportee = fn.mock.calls.some((c) => String(c[0]).includes('/api/sales/outlet-reportee'));
    expect(calledReportee).toBe(false);
  });

  it('IR4: a reportee with no phone shows the name but no call link', async () => {
    stubFetch({ success: true, data: { immediateReportee: { name: 'Ravi SO', phone: '' } } });
    await renderPage('KYC42');

    const row = await screen.findByTestId('immediate-reportee-row');
    expect(row).toHaveTextContent('Ravi SO');
    expect(screen.queryByTestId('immediate-reportee-call')).toBeNull();
  });
});

describe('Outlet-detail context back arrow', () => {
  it('BACK1: calls router.back() when there is in-app history', async () => {
    stubFetch({ success: true, data: { immediateReportee: null } });
    await renderPage('KYC42');
    setHistoryLength(3);

    fireEvent.click(await screen.findByTestId('outlet-detail-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('BACK2: falls back to /sales/kyc on a deep link with no in-app history', async () => {
    stubFetch({ success: true, data: { immediateReportee: null } });
    await renderPage('KYC42');
    setHistoryLength(1);

    fireEvent.click(await screen.findByTestId('outlet-detail-back'));
    expect(mockRouter.push).toHaveBeenCalledWith('/sales/kyc');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
