/// <reference types="vitest/globals" />
/**
 * Shared dashboard Program filter (ProgramFilter + useDashboardProgram).
 *  - PF1: hidden with < 2 programs; shown with 2+; '' = "All programs"
 *  - PF2: the choice persists across mounts (sessionStorage) — Overview → Program Health → KYC
 *  - PF3: a `?program=` in the URL wins over the stored value
 *  - PF4: an unusable program is dropped back to All programs AND the screen says so
 *  - PF5: helpers — withProgramParam / isTenantWideMetric / isProgramUsable
 *  - PF6 (F6): storage is keyed by tenant clientId AND user id (from /api/auth/me); another tenant / user
 *    never inherits the choice; unknown session → nothing restored or stored
 *  - PF7 (F6): a program restored from storage is written into ?program= on mount
 *  - PF8 (F1): the select stays visible while a program is active, even with no program list (e.g. /kpis failed)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ProgramFilter } from '../ProgramFilter';
import {
  useDashboardProgram, withProgramParam, isTenantWideMetric, isProgramUsable,
  dashboardProgramStorageKey, resolveDashboardProgramKey, type DashboardProgram,
} from '@/lib/dashboard-program';

/** /api/auth/me for the signed-in session (tenant + user drive the storage key). */
function mockSession(me: { clientId?: string; id?: string } | 'fail' = { clientId: 'bajaj', id: 'u1' }) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/auth/me')) {
      if (me === 'fail') return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: me }) };
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const KEY = dashboardProgramStorageKey('bajaj', 'u1');

beforeEach(() => { mockSession(); });

afterEach(() => {
  vi.unstubAllGlobals();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  window.history.replaceState(null, '', '/');
});

let latest: DashboardProgram | null = null;

function Harness({ programs }: { programs: string[] }) {
  const p = useDashboardProgram();
  latest = p;
  return (
    <div>
      <span data-testid="ready">{p.ready ? 'yes' : 'no'}</span>
      <span data-testid="value">[{p.program}]</span>
      <ProgramFilter
        id="pf"
        testId="pf"
        programs={programs}
        value={p.program}
        onChange={p.setProgram}
        droppedProgram={p.droppedProgram}
        onDismissDropped={p.dismissDropped}
      />
    </div>
  );
}

describe('ProgramFilter', () => {
  it('PF1: hidden with fewer than 2 programs, shown with 2+, "" = All programs', async () => {
    const { rerender } = render(<Harness programs={[]} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    expect(screen.queryByTestId('pf')).not.toBeInTheDocument();

    rerender(<Harness programs={['Only One']} />);
    expect(screen.queryByTestId('pf')).not.toBeInTheDocument();

    rerender(<Harness programs={['Gold', 'Silver']} />);
    const select = (await screen.findByTestId('pf')) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(await screen.findByRole('option', { name: 'All programs' })).toHaveValue('');
    expect(await screen.findByRole('option', { name: 'Gold' })).toBeInTheDocument();
  });

  it('PF2: the selection persists across mounts within the session', async () => {
    const first = render(<Harness programs={['Gold', 'Silver']} />);
    const select = (await screen.findByTestId('pf')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Silver' } });
    expect(await screen.findByTestId('value')).toHaveTextContent('[Silver]');
    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBe('Silver')); // stored once the session resolves
    first.unmount();

    // A fresh mount (another dashboard) restores it.
    window.history.replaceState(null, '', '/admin/dashboards/kyc');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
    expect(((await screen.findByTestId('pf')) as HTMLSelectElement).value).toBe('Silver');
  });

  it('PF2b: choosing All programs clears the stored value', async () => {
    window.sessionStorage.setItem(KEY, 'Gold');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Gold]'));
    fireEvent.change(await screen.findByTestId('pf'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBeNull());
    expect(window.location.search).toBe('');
  });

  it('PF3: a ?program= in the URL wins over the stored value (and is then stored)', async () => {
    window.sessionStorage.setItem(KEY, 'Gold');
    window.history.replaceState(null, '', '/admin/dashboard?program=Silver');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBe('Silver'));
  });

  it('PF3b: an empty ?program= means All programs even when a value is stored', async () => {
    window.sessionStorage.setItem(KEY, 'Gold');
    window.history.replaceState(null, '', '/admin/dashboard?program=');
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
  });

  it('PF4: reconcile drops an unusable program back to All programs with a visible notice', async () => {
    window.sessionStorage.setItem(KEY, 'Platinum');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Platinum]'));
    let ok = true;
    act(() => { ok = latest!.reconcile('Platinum', ['Gold', 'Silver']); });
    expect(ok).toBe(false);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
    expect(await screen.findByTestId('program-filter-dropped')).toHaveTextContent(
      'Program “Platinum” isn\'t available here — showing all programs.',
    );
    // D2: a page that can't use the program shows the notice but NEVER wipes the stored choice.
    expect(window.sessionStorage.getItem(KEY)).toBe('Platinum');
  });

  it('PF6: storage is keyed per tenant AND user — another tenant / user never inherits the choice', async () => {
    expect(dashboardProgramStorageKey('bajaj', 'u1')).not.toBe(dashboardProgramStorageKey('deoleo', 'u1'));
    expect(dashboardProgramStorageKey('bajaj', 'u1')).not.toBe(dashboardProgramStorageKey('bajaj', 'u2'));
    window.sessionStorage.setItem(dashboardProgramStorageKey('deoleo', 'u1'), 'Gold'); // same person, other tenant
    window.sessionStorage.setItem(dashboardProgramStorageKey('bajaj', 'u2'), 'Gold'); // same tenant, other person
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
    fireEvent.change(await screen.findByTestId('pf'), { target: { value: 'Silver' } });
    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBe('Silver'));
    expect(window.sessionStorage.getItem(dashboardProgramStorageKey('deoleo', 'u1'))).toBe('Gold'); // untouched
  });

  it('PF6b: session unknown (/auth/me fails) → nothing restored and nothing stored', async () => {
    mockSession('fail');
    window.sessionStorage.setItem(KEY, 'Gold');
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
    fireEvent.change(await screen.findByTestId('pf'), { target: { value: 'Silver' } });
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
    expect(window.sessionStorage.getItem(KEY)).toBe('Gold'); // not overwritten under a guessed key
    expect(window.location.search).toBe('?program=Silver'); // the URL still carries it
  });

  it('PF7: a program restored from storage is written into ?program= on mount', async () => {
    window.sessionStorage.setItem(KEY, 'Gold');
    window.history.replaceState(null, '', '/admin/dashboard');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Gold]'));
    await waitFor(() => expect(window.location.search).toBe('?program=Gold'));
  });

  it('D5: minPrograms={0} always shows the select (the KYC dashboard’s original rule)', async () => {
    render(<ProgramFilter id="k" testId="pfk" programs={[]} value="" onChange={() => {}} minPrograms={0} />);
    expect(await screen.findByTestId('pfk')).toBeInTheDocument();
  });

  it('PF8: with a program active the select stays visible even when no program list is known', async () => {
    render(<ProgramFilter id="x" testId="pfx" programs={[]} value="Gold" onChange={() => {}} />);
    const select = (await screen.findByTestId('pfx')) as HTMLSelectElement;
    expect(select.value).toBe('Gold');
    expect(await screen.findByRole('option', { name: 'All programs' })).toBeInTheDocument();
  });


  it('D1: ready immediately — never waits on /api/auth/me (pending forever)', async () => {
    window.sessionStorage.setItem(KEY, 'Gold');
    const fn = vi.fn(() => new Promise(() => {})); // /auth/me never answers
    vi.stubGlobal('fetch', fn);
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(screen.getByTestId('ready')).toHaveTextContent('yes'); // synchronous after mount effects
    expect(screen.getByTestId('value')).toHaveTextContent('[]'); // All programs until the session is known
  });

  it('D1: nothing stored + no ?program= → NO /api/auth/me call at all (unfiltered tenants: zero extra round-trips)', async () => {
    const fn = mockSession();
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).not.toHaveBeenCalled();
  });

  it('D1: the session lookup is hard-capped (2 s default) → null on timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    // Fake clock, not a wall-clock budget (flaky under load): the cap must fire AT its timeout, not before.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const p = resolveDashboardProgramKey(30).then((v) => { settled = true; return v; });
      await vi.advanceTimersByTimeAsync(29);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D1: a stored program is applied once the session resolves', async () => {
    window.sessionStorage.setItem(KEY, 'Silver');
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
  });

  it('D5: reconcile honours a page-specific minimum (KYC: 1 program is enough)', async () => {
    window.history.replaceState(null, '', '/admin/dashboards/kyc?program=Only');
    render(<Harness programs={['Only']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Only]'));
    let ok = false;
    act(() => { ok = latest!.reconcile('Only', ['Only'], 1); });
    expect(ok).toBe(true);
    expect(isProgramUsable('Only', ['Only'], 1)).toBe(true);
    expect(isProgramUsable('Only', ['Only'])).toBe(false);
  });

  it('PF5: helpers', () => {
    expect(withProgramParam('/api/x', '')).toBe('/api/x');
    expect(withProgramParam('/api/x', 'A & B')).toBe('/api/x?program=A%20%26%20B');
    expect(withProgramParam('/api/x?a=1', 'P', 'programName')).toBe('/api/x?a=1&programName=P');
    expect(isTenantWideMetric('', ['pointsEconomy'], 'pointsEconomy.issued')).toBe(false);
    expect(isTenantWideMetric('P', ['pointsEconomy'], 'pointsEconomy.issued')).toBe(true);
    expect(isTenantWideMetric('P', ['pendingKyc'], 'pendingKyc')).toBe(true);
    expect(isTenantWideMetric('P', undefined, 'pendingKyc')).toBe(false);
    expect(isProgramUsable('', [])).toBe(true);
    expect(isProgramUsable('Gold', ['Gold'])).toBe(false); // single program → dropdown hidden → not usable
    expect(isProgramUsable('Gold', ['Gold', 'Silver'])).toBe(true);
  });
});
