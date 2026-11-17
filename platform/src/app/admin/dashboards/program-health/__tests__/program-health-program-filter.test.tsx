/// <reference types="vitest/globals" />
/**
 * Program Health + KYC — shared program filter.
 *  - PH1: no program → request with NO param (byte-identical to before); no dropdown for < 2 programs
 *  - PH2: choosing a program refetches with `program`; the dashboard stays rendered
 *  - PH3: notProgramScoped section key → tenant-wide note only with a program selected
 *  - PH4: a stored program (chosen on Overview) is sent on first load
 *  - PH5: a stored program not in availablePrograms → dropped to All programs, notice shown
 *  - KYC1: KYC sends the stored program as `programName` on first load
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import ProgramHealthPage from '../page';
import KycDashboardPage from '../../kyc/page';
import { DASHBOARD_PROGRAM_STORAGE_KEY } from '@/lib/dashboard-program';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 220 }}>{children}</div>
    ),
  };
});

const PH = {
  scope: { tenant: 'Bajaj', generatedAt: '2026-06-27T08:30:00.000Z', period: '2026-06' },
  activation: { registered: 1000, kycApproved: 734, firstEarn: 600, firstRedeem: 220, medianTimeToActivateDays: 4.5 },
  participation: { addressable: 1000, activeEarnersThisMonth: 420, activeRatePct: 42, trend: [] },
  pointsEconomy: {
    issued: 1250000, redeemed: 480000, outstandingLiabilityPoints: 3400000,
    outstandingLiabilityRupees: 340000, breakagePct: 3.2, expiringIn30dPoints: 95000,
  },
  targetAchievement: { period: '2026-06', primary: null, kpis: [] },
  redemptions: { period: '2026-06', byMode: [], fulfilment: [] },
};

const KYC = {
  scope: { tenant: 'Bajaj', generatedAt: '2026-06-27T08:30:00.000Z' },
  availablePrograms: ['Gold', 'Silver'],
  universe: { addressableOutlets: 10, notInterested: 0, inactive: 0 },
  headline: {
    coveragePct: 50, approved: 5, inPipeline: 1, pendingField: 1, awaitingGifsy: 0,
    rejectedOrReupload: 0, notStarted: 4, approvalRatePct: 80,
  },
  funnel: [],
  buckets: {
    pendingFieldApproval: { count: 0, withinSla: 0, breached: 0, slaHours: 24 },
    pendingGifsyApproval: { count: 0, withinSla: 0, breached: 0, slaHours: 96 },
  },
  sla: { endToEndAvgHours: 1, fieldChainAvgHours: 1, gifsyReviewAvgHours: 1, fieldCompliancePct: 100, gifsyCompliancePct: 100, sampleSize: 1 },
  quality: { topRejectionReasons: [], reUploadRatePct: 0 },
  coverageBy: { state: [], outletType: [], program: [] },
};

function mockOk(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const urls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[0]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  window.history.replaceState(null, '', '/');
});

describe('Program Health — program filter', () => {
  it('PH1: no program → no param; no dropdown with < 2 programs', async () => {
    const fn = mockOk({ ...PH, availablePrograms: ['Only'], notProgramScoped: [] });
    render(<ProgramHealthPage />);
    expect(await screen.findByTestId('participation-rate')).toHaveTextContent('42.0%');
    expect(urls(fn)).toEqual(['/api/admin/dashboard/program-health']);
    expect(screen.queryByTestId('program-health-program-filter')).not.toBeInTheDocument();
  });

  it('PH2: choosing a program refetches with `program` and keeps the dashboard rendered', async () => {
    const fn = mockOk({ ...PH, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] });
    render(<ProgramHealthPage />);
    await screen.findByTestId('program-health-dashboard');
    fireEvent.change(await screen.findByTestId('program-health-program-filter'), { target: { value: 'Gold' } });
    await waitFor(() => expect(urls(fn)).toContain('/api/admin/dashboard/program-health?program=Gold'));
    expect(await screen.findByTestId('program-health-dashboard')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('program-health-refetching')).not.toBeInTheDocument());
  });

  it('PH3: notProgramScoped section key → note only with a program selected', async () => {
    mockOk({ ...PH, availablePrograms: ['Gold', 'Silver'], notProgramScoped: ['pointsEconomy'] });
    render(<ProgramHealthPage />);
    await screen.findByTestId('program-health-dashboard');
    expect(screen.queryByTestId('tenant-wide-note')).not.toBeInTheDocument();
    fireEvent.change(await screen.findByTestId('program-health-program-filter'), { target: { value: 'Silver' } });
    // six points-economy tiles carry the note
    await waitFor(() => expect(screen.getAllByTestId('tenant-wide-note')).toHaveLength(6));
  });

  it('PH4: a stored program is sent on first load', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Silver');
    const fn = mockOk({ ...PH, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] });
    render(<ProgramHealthPage />);
    await screen.findByTestId('program-health-dashboard');
    expect(urls(fn)[0]).toBe('/api/admin/dashboard/program-health?program=Silver');
  });

  it('PH5: a stored program this tenant does not have → All programs + notice', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Platinum');
    const fn = mockOk({ ...PH, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] });
    render(<ProgramHealthPage />);
    expect(await screen.findByTestId('program-filter-dropped')).toHaveTextContent('Program “Platinum” isn\'t available here');
    await waitFor(() => expect(urls(fn)).toContain('/api/admin/dashboard/program-health'));
    expect(await screen.findByTestId('program-health-dashboard')).toBeInTheDocument();
    expect(((await screen.findByTestId('program-health-program-filter')) as HTMLSelectElement).value).toBe('');
  });
});

describe('KYC — shared program filter', () => {
  it('KYC1: a stored program is sent as programName on first load', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    const fn = mockOk(KYC);
    render(<KycDashboardPage />);
    await screen.findByTestId('kyc-dashboard');
    expect(urls(fn)[0]).toBe('/api/admin/dashboard/kyc?programName=Gold');
    expect(((await screen.findByTestId('kyc-program-filter')) as HTMLSelectElement).value).toBe('Gold');
  });

  it('KYC2: no dropdown when the tenant has fewer than 2 programs', async () => {
    mockOk({ ...KYC, availablePrograms: ['Gold'] });
    render(<KycDashboardPage />);
    await screen.findByTestId('kyc-dashboard');
    expect(screen.queryByTestId('kyc-program-filter')).not.toBeInTheDocument();
  });
});
