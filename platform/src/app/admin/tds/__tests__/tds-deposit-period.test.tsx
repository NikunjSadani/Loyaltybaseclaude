/// <reference types="vitest/globals" />
/**
 * TDS page — "TDS for month" on deposits:
 *  - the Deposited cell lists the months the counted deposits pay for ("for Feb-2026, Mar-2026");
 *  - a row with no dated deposits shows only the amount;
 *  - the deposit upload panel explains the column + the default rule.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminTdsPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/admin-session', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/admin-session')>();
  return {
    ...mod,
    useAdminSession: vi.fn(() => ({ role: 'CLIENT_ADMIN', clientId: 'deoleo', name: 'T', canManageSchemes: false })),
  };
});

const MOCK_194R = {
  success: true,
  data: {
    section: '194R',
    fyLabel: '2025-26',
    summary: { baseFyTotalPaise: 0, liabilityPaise: 0, depositedPaise: 0, outstandingPaise: 0 },
    rows: [
      {
        panNumber: 'ABCDE1234F',
        baseFyTotalPaise: 3000000,
        liabilityPaise: 333300,
        depositedPaise: 333300,
        outstandingPaise: 0,
        depositForPeriods: ['2026-02', '2026-03'],
      },
      {
        panNumber: 'XYZPQ9876G',
        baseFyTotalPaise: 100000,
        liabilityPaise: 0,
        depositedPaise: 0,
        outstandingPaise: 0,
      },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('TDS page — deposit "TDS for month"', () => {
  it('shows the months under the deposited amount, only where deposits exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(MOCK_194R) }));
    render(<AdminTdsPage />);
    await screen.findByText('ABCDE1234F');
    expect(screen.getByText('for Feb-2026, Mar-2026')).toBeTruthy();
    expect(screen.getAllByText(/^for /)).toHaveLength(1);
  });

  it('the deposit upload panel explains the optional TDS for month column and the default rule', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(MOCK_194R) }));
    render(<AdminTdsPage />);
    const hint = await screen.findByTestId('deposit-for-month-hint');
    expect(hint.textContent).toMatch(/TDS for month/);
    expect(hint.textContent).toMatch(/1st–7th counts for the previous month/);
    expect(hint.textContent).toMatch(/8–30 April counts for March/);
    expect(hint.textContent).toMatch(/07\/04\/2026 = 7 April 2026/);
    // Never re-upload TDS Gifsy already withheld (deduct) + deposits can't be edited after upload.
    const warn = screen.getAllByTestId('deposit-upload-warnings')[0];
    expect(warn.textContent).toMatch(/Do not upload TDS that Gifsy already withheld from payouts/);
    expect(warn.textContent).toMatch(/cannot be edited or deleted/);
  });
});
