/**
 * Regression: the New-KYC outlet selector must show the human-readable outlet
 * CODE (e.g. OUT-2026-001), never the internal Prisma CUID.
 *
 * Reported bug: below "Verma Traders" the dropdown rendered
 * `cmqphsp8h000001s62s1ephnr` (the id) instead of the outlet code. The fix keeps
 * `outletId` (CUID) as the select/Not-Interested identity but adds `outletCode`
 * for every user-facing surface.
 *
 * Run: npx vitest run src/app/sales/kyc/new/__tests__/outlet-code-display.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import NewKYCPage from '../page';

const CUID = 'cmqphsp8h000001s62s1ephnr';
const CODE = 'OUT-2026-001';

beforeEach(() => {
  vi.clearAllMocks();
  // /api/sales/outlets — one outlet with a CUID id distinct from its human code.
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { outlets: [{ id: CUID, outletCode: CODE, name: 'Verma Traders', district: 'Beat 1', type: 'SSS' }] },
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  });
});

describe('New KYC — outlet selector shows the code, not the CUID', () => {
  it('dropdown row shows the outlet code and never the internal id', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);

    // The select identity is still the CUID (data-testid keyed on outletId).
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    const row = await screen.findByTestId(`outlet-option-${CUID}`);

    // Human code is visible…
    expect(row).toHaveTextContent(CODE);
    // …and the raw CUID is nowhere on screen.
    expect(screen.queryByText((c) => c.includes(CUID))).toBeNull();
  });

  it('the selected-outlet summary shows the code after selection', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));
    await user.click(await screen.findByTestId(`outlet-option-${CUID}`));

    // After selection the code surfaces (collapsed trigger + summary card); the CUID never does.
    await waitFor(() => expect(document.body.textContent).toContain(CODE));
    expect(document.body.textContent).not.toContain(CUID);
  });
});
