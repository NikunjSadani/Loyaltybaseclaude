/// <reference types="vitest/globals" />
/**
 * ReversalEngineAttentionBanner — policy round A call-outs ("no silent pass-throughs"): approvals paused, wallets
 * needing Gifsy attention, unmapped credits, historical clawbacks "recovered X, owed Y".
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ReversalEngineAttentionBanner, { type ReversalAttention, untrackedWallets } from '../ReversalEngineAttentionBanner';

const ATTENTION = '/api/admin/credits/reversal-engine/attention';
const PAUSE = '/api/admin/credits/reversal-engine/pause';

const base = (over: Partial<ReversalAttention> = {}): ReversalAttention => ({
  mode: 'V2',
  modeError: null,
  pause: { paused: false, since: null, by: null, reason: null },
  wallets: [],
  walletsTotal: 0,
  unmappedCredits: [],
  unmappedTotal: 0,
  owedClawbacks: [],
  owedTotal: 0,
  ...over,
});

function mockFetch(responses: ReversalAttention[], onPause?: (body: unknown) => void) {
  let i = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === ATTENTION) {
      const data = responses[Math.min(i++, responses.length - 1)];
      return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    }
    if (url === PAUSE && init?.method === 'POST') {
      onPause?.(JSON.parse(String(init.body)));
      return { ok: true, status: 201, json: async () => ({ success: true, data: { paused: false } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe('ReversalEngineAttentionBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when nothing needs attention', async () => {
    mockFetch([base()]);
    const { container } = render(<ReversalEngineAttentionBanner />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the counts and, expanded, every wallet / credit / owed clawback with its reason', async () => {
    mockFetch([
      base({
        wallets: [
          { walletId: 'w1', partnerName: 'Shop A', outletCodes: ['O1'], status: 'BLOCKED', reason: 'CHAIN_BROKEN: no row continues' },
          { walletId: 'w2', partnerName: null, outletCodes: [], status: 'NOT_BACKFILLED', reason: 'not yet prepared by the wallet backfill' },
        ],
        walletsTotal: 2,
        unmappedCredits: [{ positionId: 'u1', batchId: 'B1', amount: 50, reason: 'a credit of 50 pts in batch B1 could not be matched to an outlet and field' }],
        unmappedTotal: 1,
        owedClawbacks: [{ creditReversalId: 'R9', outletCode: 'OQ', label: 'recovered 100, owed 200' }],
        owedTotal: 1,
      }),
    ]);
    render(<ReversalEngineAttentionBanner />);
    expect(await screen.findByText('2 wallets need Gifsy attention · 1 credit unmapped · 1 historical clawback with points owed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/Blocked — CHAIN_BROKEN: no row continues/)).toBeInTheDocument();
    expect(screen.getByText(/Not yet prepared — not yet prepared by the wallet backfill/)).toBeInTheDocument();
    expect(screen.getByText(/50 pts · batch B1 — a credit of 50 pts/)).toBeInTheDocument();
    expect(screen.getByText(/Reversal R9 · outlet OQ — recovered 100, owed 200/)).toBeInTheDocument();
  });

  it('approvals paused: owner wording + start time; only GIFSY can resume, which posts paused:false and reloads', async () => {
    const SINCE = '2026-11-16T03:00:00.000Z';
    const posted: unknown[] = [];
    mockFetch([base({ pause: { paused: true, since: SINCE, by: 'wallet-backfill', reason: 'x' } }), base()], (b) => posted.push(b));
    const { rerender } = render(<ReversalEngineAttentionBanner />);
    expect(await screen.findByText(/^Points reversal approvals are paused — wallet maintenance in progress \(started /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume approvals/i })).toBeNull();
    rerender(<ReversalEngineAttentionBanner canLiftPause />);
    fireEvent.click(screen.getByRole('button', { name: /resume approvals/i }));
    await waitFor(() => expect(posted).toEqual([{ paused: false, reason: 'lifted from the credits reversal screen' }]));
    await waitFor(() => expect(screen.queryByText(/approvals are paused/)).toBeNull());
  });

  // ── Wallet Reversal Engine fix round A ──
  it('M1: a malformed engine setting is shown LOUDLY up front (no expand needed), even with nothing else to report', async () => {
    const warning =
      'reversalEngine setting is invalid: "v2" — treated as LEGACY; fix in settings. Earning, redeeming, expiry and batch confirms run on today\'s (LEGACY) rules';
    mockFetch([base({ mode: 'INVALID', modeError: 'Invalid reversalEngine setting', modeWarning: warning, effectiveMode: 'LEGACY' })]);
    render(<ReversalEngineAttentionBanner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('reversalEngine setting is invalid: "v2" — treated as LEGACY; fix in settings');
    expect(screen.queryByText('reversal engine setting unreadable')).toBeNull(); // not duplicated
  });

  it('M1 / M3: expiry failures and Gifsy-must-act reversal refusals are counted and, expanded, listed with their reasons', async () => {
    const at = '2026-11-16T05:00:00.000Z';
    mockFetch([
      base({
        expiryFailures: [{ at, lotId: 'L1', walletId: 'w1', error: 'deadlock detected' }],
        expiryFailuresTotal: 1,
        refusals: [
          {
            at, entityId: 'rev1', phase: 'APPROVE', code: 'CREDIT_UNMAPPED', outletCode: 'O1',
            message: "Can't reverse: the original credit for outlet O1 in this batch couldn't be identified — Gifsy must map it first.",
            reason: 'sequenced wallet: no credit position records this credit',
          },
        ],
        refusalsTotal: 1,
      }),
    ]);
    render(<ReversalEngineAttentionBanner />);
    expect(
      await screen.findByText('1 points-expiry failure (last 30 days) · 1 points reversal refused — Gifsy must act (last 30 days)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/lot L1 \(wallet w1\) — deadlock detected/)).toBeInTheDocument();
    expect(screen.getByText(/outlet O1 · approval refused — Can't reverse: the original credit for outlet O1/)).toBeInTheDocument();
    expect(screen.getByText(/\(sequenced wallet: no credit position records this credit\)/)).toBeInTheDocument();
  });

  it('round 6 item 5: an untracked-expiry reversal lists EVERY affected wallet, not only the first', async () => {
    const at = '2026-11-19T05:00:00.000Z';
    mockFetch([
      base({
        expiryUntracked: [
          { at, creditReversalId: 'REVU', walletId: 'w2', walletIds: ['w1', 'w2'], outletCode: 'O2', owed: 30, recovered: 10, action: 'check it' },
        ],
        expiryUntrackedTotal: 1,
      }),
    ]);
    render(<ReversalEngineAttentionBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /show details/i }));
    expect(screen.getByText(/reversal REVU · outlet O2 · 2 wallets: w1, w2 · 10 pts taken · 30 pts booked as debt/)).toBeInTheDocument();
    // older payloads (no walletIds) still name their one wallet
    expect(untrackedWallets({ walletId: 'w9' })).toBe(' · wallet w9');
    expect(untrackedWallets({ walletId: null, walletIds: [] })).toBe('');
  });

  it('L6: "Resume approvals" names the program the call-outs are about (never the Gifsy home tenant by default)', async () => {
    const posted: unknown[] = [];
    mockFetch([base({ clientId: 'bajaj', pause: { paused: true, since: '2026-11-16T03:00:00.000Z', by: 'x', reason: 'y' } }), base({ clientId: 'bajaj' })], (b) =>
      posted.push(b),
    );
    render(<ReversalEngineAttentionBanner canLiftPause />);
    fireEvent.click(await screen.findByRole('button', { name: /resume approvals/i }));
    await waitFor(() =>
      expect(posted).toEqual([{ paused: false, reason: 'lifted from the credits reversal screen', clientId: 'bajaj' }]),
    );
  });

  it('a failed call-out read is itself shown (never silent)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) })) as unknown as typeof fetch;
    render(<ReversalEngineAttentionBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
