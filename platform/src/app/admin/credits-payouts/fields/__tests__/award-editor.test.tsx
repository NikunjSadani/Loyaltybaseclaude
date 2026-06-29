/// <reference types="vitest/globals" />
/**
 * AWE — Admin Credit Field award-map editor (Credits & Payouts → Field Configuration)
 *
 * AWE1: renders the two fields from the GET response
 * AWE2: expanding a field and changing a NON-money-path selector (NA → POINTS)
 *       Saves immediately and PATCHes the FULL outletTypeAwards map
 * AWE3: a POINTS ↔ PAYOUT flip requires the inline confirm before the PATCH fires;
 *       the confirmed PATCH carries the flipped value
 * AWE4: the activate/deactivate toggle still PATCHes { action } (unchanged)
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import FieldConfigPage from '../page';

const FIELDS = [
  {
    id: 'f1',
    name: 'Scheme Volume',
    isActive: true,
    isSeparatePayout: false,
    order: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    // WHOLESALER = POINTS so we can test a POINTS→PAYOUT flip; rest default NA.
    outletTypeAwards: { WHOLESALER: 'POINTS' },
  },
  {
    id: 'f2',
    name: 'Visibility',
    isActive: true,
    isSeparatePayout: true,
    order: 2,
    outletTypeAwards: {},
  },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

/** The tenant's enabled outlet types now come from the backend (dynamic, not hardcoded). */
const OUTLET_TYPES = [
  { code: 'SSS',          label: 'SSS' },
  { code: 'SSS_TOT',      label: 'SSS TOT' },
  { code: 'SUB_STOCKIST', label: 'Sub-Stockist' },
  { code: 'WHOLESALER',   label: 'Wholesaler' },
];

/** Route fetch by URL + method, recording every call for assertions. */
function installFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/admin/credits/outlet-types')) {
      return jsonOk(OUTLET_TYPES);
    }
    if (url.startsWith('/api/admin/credits/fields') && (!init?.method || init.method === 'GET')) {
      return jsonOk(FIELDS);
    }
    if (url.startsWith('/api/admin/credits/fields/') && init?.method === 'PATCH') {
      return jsonOk(FIELDS[0]);
    }
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function lastPatch(calls: { url: string; init?: RequestInit }[]) {
  return [...calls].reverse().find((c) => c.init?.method === 'PATCH');
}

/** Walk up from the field-name span to the FieldRow root (carries data-field-row;
 *  contains BOTH the header toggle AND the expandable editor). */
function rowFor(name: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(name);
  while (el && !el.hasAttribute('data-field-row')) {
    el = el.parentElement;
  }
  if (!el) throw new Error(`row not found for ${name}`);
  return el;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AWE — Credit field award-map editor', () => {
  it('AWE1: renders the fields from the GET response', async () => {
    installFetch();
    render(<FieldConfigPage />);
    expect(await screen.findByText('Scheme Volume')).toBeInTheDocument();
    expect(screen.getByText('Visibility')).toBeInTheDocument();
  });

  it('AWE2: NA → POINTS change Saves immediately and PATCHes the full map', async () => {
    const { calls } = installFetch();
    render(<FieldConfigPage />);

    // Expand the second field (Visibility — all awards default NA).
    await screen.findByText('Visibility');
    const row = rowFor('Visibility');
    const editToggle = within(row).getByRole('button', { name: /edit award map/i });
    await userEvent.click(editToggle);

    // Set SSS → POINTS (was NA: no money-path confirm needed).
    // The editor label is the only "SSS" span sitting next to a POINTS button.
    const sssLabel = within(row).getByText('SSS', { selector: 'span.w-28' });
    const sssGroup = sssLabel.parentElement as HTMLElement;
    await userEvent.click(within(sssGroup).getByRole('button', { name: 'POINTS' }));

    await userEvent.click(within(row).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const patch = lastPatch(calls);
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('/api/admin/credits/fields/f2');
      const body = JSON.parse(String(patch!.init!.body));
      // Full map for ALL outlet types is sent.
      expect(body.outletTypeAwards).toEqual({
        WHOLESALER: 'NA',
        SSS: 'POINTS',
        SUB_STOCKIST: 'NA',
        SSS_TOT: 'NA',
      });
    });
  });

  it('AWE3: POINTS → PAYOUT flip requires the inline confirm before PATCH', async () => {
    const { calls } = installFetch();
    render(<FieldConfigPage />);

    await screen.findByText('Scheme Volume');
    const row = rowFor('Scheme Volume');
    await userEvent.click(within(row).getByRole('button', { name: /edit award map/i }));

    // Flip WHOLESALER POINTS → PAYOUT (money-path sensitive).
    const whLabel = within(row).getByText('Wholesaler', { selector: 'span.w-28' });
    const whGroup = whLabel.parentElement as HTMLElement;
    await userEvent.click(within(whGroup).getByRole('button', { name: 'PAYOUT' }));

    // First Save click only shows the confirm — no PATCH yet.
    await userEvent.click(within(row).getByRole('button', { name: /^save$/i }));
    expect(within(row).getByText(/become wallet points or bank payouts/i)).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);

    // Confirm & Save issues the PATCH with the flipped value.
    await userEvent.click(within(row).getByRole('button', { name: /confirm & save/i }));
    await waitFor(() => {
      const patch = lastPatch(calls);
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('/api/admin/credits/fields/f1');
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.outletTypeAwards.WHOLESALER).toBe('PAYOUT');
    });
  });

  it('AWE4: the activate/deactivate toggle still PATCHes { action }', async () => {
    const { calls } = installFetch();
    render(<FieldConfigPage />);

    await screen.findByText('Scheme Volume');
    const row = rowFor('Scheme Volume');
    // The active toggle's visible label is "Active"; clicking it deactivates.
    await userEvent.click(within(row).getByRole('button', { name: /active/i }));

    await waitFor(() => {
      const patch = lastPatch(calls);
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.action).toBe('deactivate');
      expect(body.outletTypeAwards).toBeUndefined();
    });
  });
});
