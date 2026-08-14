/// <reference types="vitest/globals" />
/**
 * Gifsy-admin KYC classification + group-inheritance (admin/kyc/[id]).
 *
 * The "Classification · Set by Gifsy Admin" block is now compulsory and wired to the backend:
 *  CL1: no stored classification → the selects show the EMPTY placeholder (not INDIVIDUAL /
 *       UNREGISTERED), and both Save + Approve are disabled.
 *  CL2: picking both values + Save POSTs /api/kyc/:id/gst-details and, once persisted (re-fetch),
 *       the Approve control un-gates.
 *  CL3: a locked (group-inherited) classification disables both selects, shows the lock note,
 *       hides the Save button, and seeds the selects to the locked values.
 *  CL4: a GROUP_INHERITED verification item renders the "Auto-verified from group" badge.
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import AdminKYCDetailPage from '../page';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

type Sub = Record<string, unknown>;

function baseSubmission(overrides: Sub = {}): Sub {
  return {
    id: TEST_UUID,
    status: 'PENDING_GIFSY',
    submittedAt: '2026-06-01T00:00:00.000Z',
    user: { id: 'u1', name: 'Rep Anil', phone: '9000000003', role: 'XSR' },
    partner: {
      id: 'p1', businessName: 'Verma Traders', ownerName: 'Suresh',
      outlets: [{ name: 'Verma Traders', outletCode: 'OUT-2026-001', phone: '7766554433' }],
    },
    documents: [
      { id: 'd1', documentType: 'STORE_BOARD_PHOTO', status: 'SUBMITTED', viewUrl: 'data:image/jpeg;base64,AAAA' },
    ],
    verificationItems: [],
    statusHistory: [],
    entityType: null,
    gstRegistrationType: null,
    classificationLock: null,
    ...overrides,
  };
}

interface FetchOpts {
  // Override the POST /gst-details response (e.g. a lock 400). When set, no persistence.
  gstDetails?: { ok: boolean; body: unknown };
  // Override the POST /verify response (e.g. classificationRequired). Defaults to success.
  verify?: { ok: boolean; body: unknown };
}

/**
 * fetch mock: GET returns the CURRENT submission (mutated by a gst-details POST so a re-fetch
 * reflects persistence). Returns the recorded calls + a handle to read the live submission.
 */
function installFetch(initial: Sub, opts: FetchOpts = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  let current = { ...initial };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { submission: current } }) });
    }
    if (url.includes('/gst-details')) {
      if (opts.gstDetails) {
        return Promise.resolve({ ok: opts.gstDetails.ok, json: () => Promise.resolve(opts.gstDetails!.body) });
      }
      // Default: persist the classification so the subsequent GET seeds it.
      const parsed = JSON.parse((init?.body as string) ?? '{}');
      current = { ...current, entityType: parsed.entityType, gstRegistrationType: parsed.gstRegistrationType };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'ok' }) });
    }
    if (url.includes('/verify') && opts.verify) {
      return Promise.resolve({ ok: opts.verify.ok, json: () => Promise.resolve(opts.verify!.body) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'ok' }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem: () => {}, removeItem: () => {}, clear: () => {} });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

async function renderPage() {
  const params = Promise.resolve({ id: TEST_UUID });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <AdminKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

describe('CL — Gifsy classification + group inheritance', () => {
  it('CL1: no stored classification → empty placeholder (no INDIVIDUAL default), Save + Approve disabled', async () => {
    installFetch(baseSubmission());
    await renderPage();

    const entity = await screen.findByTestId('entity-type-select') as HTMLSelectElement;
    const gst = screen.getByTestId('gst-reg-type-select') as HTMLSelectElement;
    // The prior bug: these defaulted to INDIVIDUAL / UNREGISTERED. They must now be empty.
    expect(entity.value).toBe('');
    expect(gst.value).toBe('');

    expect(screen.getByTestId('save-classification-btn')).toBeDisabled();
    expect(screen.getByTestId('approve-kyc-btn')).toBeDisabled();
    expect(screen.getByTestId('approve-disabled-reason')).toBeInTheDocument();
  });

  it('CL2: pick both + Save POSTs /gst-details and, once persisted, Approve un-gates', async () => {
    const calls = installFetch(baseSubmission());
    await renderPage();

    const entity = await screen.findByTestId('entity-type-select') as HTMLSelectElement;
    const gst = screen.getByTestId('gst-reg-type-select') as HTMLSelectElement;

    fireEvent.change(entity, { target: { value: 'INDIVIDUAL' } });
    fireEvent.change(gst, { target: { value: 'REGULAR' } });

    // Both picked → Save enabled; but still NOT persisted → Approve stays blocked.
    expect(screen.getByTestId('save-classification-btn')).not.toBeDisabled();
    expect(screen.getByTestId('approve-kyc-btn')).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByTestId('save-classification-btn')); });

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes(`/api/kyc/${TEST_UUID}/gst-details`));
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body!)).toEqual({ entityType: 'INDIVIDUAL', gstRegistrationType: 'REGULAR' });
    });
    // After the re-fetch seeds the persisted values, the Approve control un-gates.
    await waitFor(() => expect(screen.getByTestId('approve-kyc-btn')).not.toBeDisabled());
  });

  it('CL3: locked group classification → selects disabled + seeded, lock note shown, no Save button', async () => {
    installFetch(baseSubmission({
      classificationLock: { entityType: 'COMPANY', gstRegistrationType: 'REGULAR', sourcePartnerId: 'parent-1' },
    }));
    await renderPage();

    const entity = await screen.findByTestId('entity-type-select') as HTMLSelectElement;
    const gst = screen.getByTestId('gst-reg-type-select') as HTMLSelectElement;
    expect(entity.value).toBe('COMPANY');
    expect(gst.value).toBe('REGULAR');
    expect(entity).toBeDisabled();
    expect(gst).toBeDisabled();

    expect(screen.getByTestId('classification-lock-note')).toBeInTheDocument();
    expect(screen.queryByTestId('save-classification-btn')).not.toBeInTheDocument();
    // Locked values are authoritative → Approve is not blocked on classification.
    expect(screen.getByTestId('approve-kyc-btn')).not.toBeDisabled();
  });

  it('CL4: a GROUP_INHERITED verification item renders the "Auto-verified from group" badge', async () => {
    installFetch(baseSubmission({
      entityType: 'INDIVIDUAL',
      gstRegistrationType: 'UNREGISTERED',
      verificationItems: [
        { fieldKey: 'PAYMENT', decision: 'APPROVED', source: 'GROUP_INHERITED' },
        { fieldKey: 'ADDRESS', decision: 'PENDING', source: 'PORTAL' },
      ],
    }));
    await renderPage();

    const badges = await screen.findAllByTestId('group-inherited-badge');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/auto-verified from group/i).length).toBeGreaterThanOrEqual(1);
  });

  it('CL5: editing a saved value re-disables Approve; reverting it re-enables (label stays consistent)', async () => {
    installFetch(baseSubmission({ entityType: 'INDIVIDUAL', gstRegistrationType: 'UNREGISTERED' }));
    await renderPage();

    const entity = await screen.findByTestId('entity-type-select') as HTMLSelectElement;
    const save = screen.getByTestId('save-classification-btn');
    // Loaded persisted → Approve enabled, Save reads the ✓-saved label (and is disabled).
    expect(screen.getByTestId('approve-kyc-btn')).not.toBeDisabled();
    expect(save).toHaveTextContent(/classification saved/i);
    expect(save).toBeDisabled();

    // Dirty edit (diverge from persisted) → Approve blocked, Save re-enabled + label drops "✓".
    fireEvent.change(entity, { target: { value: 'COMPANY' } });
    expect(screen.getByTestId('approve-kyc-btn')).toBeDisabled();
    expect(save).toHaveTextContent(/^save classification$/i);
    expect(save).not.toBeDisabled();

    // Revert to the persisted value → Approve re-enabled, label back to ✓-saved (no drift).
    fireEvent.change(entity, { target: { value: 'INDIVIDUAL' } });
    expect(screen.getByTestId('approve-kyc-btn')).not.toBeDisabled();
    expect(save).toHaveTextContent(/classification saved/i);
  });

  it('CL6: a lock-400 save surfaces inline and Approve stays blocked', async () => {
    installFetch(
      baseSubmission(),
      { gstDetails: { ok: false, body: { success: false, error: 'Locked to the group classification (COMPANY).' } } },
    );
    await renderPage();

    fireEvent.change(await screen.findByTestId('entity-type-select'), { target: { value: 'INDIVIDUAL' } });
    fireEvent.change(screen.getByTestId('gst-reg-type-select'), { target: { value: 'REGULAR' } });
    await act(async () => { fireEvent.click(screen.getByTestId('save-classification-btn')); });

    await waitFor(() => {
      expect(screen.getByTestId('classification-error')).toHaveTextContent(/locked to the group classification/i);
    });
    // Save failed → never persisted → Approve stays blocked.
    expect(screen.getByTestId('approve-kyc-btn')).toBeDisabled();
  });

  it('CL7: a verify response with classificationRequired renders the finalize notice, not a per-field error', async () => {
    installFetch(
      baseSubmission(),
      { verify: { ok: true, body: { success: true, data: {
        fieldKey: 'PAYMENT', fieldDecision: 'APPROVED', derivedStatus: 'PENDING_GIFSY', classificationRequired: true,
      } } } },
    );
    await renderPage();

    // Field-verify Approve buttons read exactly "Approve" (the doc-review one reads "Approve KYC").
    const fieldApprove = (await screen.findAllByRole('button', { name: 'Approve' }))[0];
    await act(async () => { fireEvent.click(fieldApprove); });

    await waitFor(() => {
      expect(screen.getByTestId('classification-required-notice')).toBeInTheDocument();
    });
    expect(screen.getByText(/set & save entity type and gst registration type above to finalize/i)).toBeInTheDocument();
  });
});
