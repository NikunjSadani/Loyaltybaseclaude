/// <reference types="vitest/globals" />
/**
 * Shared dashboard Program filter (ProgramFilter + useDashboardProgram).
 *  - PF1: hidden with < 2 programs; shown with 2+; '' = "All programs"
 *  - PF2: the choice persists across mounts (sessionStorage) — Overview → Program Health → KYC
 *  - PF3: a `?program=` in the URL wins over the stored value
 *  - PF4: an unusable program is dropped back to All programs AND the screen says so
 *  - PF5: helpers — withProgramParam / isTenantWideMetric / isProgramUsable
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ProgramFilter } from '../ProgramFilter';
import {
  useDashboardProgram, withProgramParam, isTenantWideMetric, isProgramUsable,
  DASHBOARD_PROGRAM_STORAGE_KEY, type DashboardProgram,
} from '@/lib/dashboard-program';

afterEach(() => {
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
    expect(window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY)).toBe('Silver');
    first.unmount();

    // A fresh mount (another dashboard) restores it.
    window.history.replaceState(null, '', '/admin/dashboards/kyc');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
    expect(((await screen.findByTestId('pf')) as HTMLSelectElement).value).toBe('Silver');
  });

  it('PF2b: choosing All programs clears the stored value', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Gold]'));
    fireEvent.change(await screen.findByTestId('pf'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
    expect(window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('PF3: a ?program= in the URL wins over the stored value (and is then stored)', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    window.history.replaceState(null, '', '/admin/dashboard?program=Silver');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Silver]'));
    expect(window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY)).toBe('Silver');
  });

  it('PF3b: an empty ?program= means All programs even when a value is stored', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    window.history.replaceState(null, '', '/admin/dashboard?program=');
    render(<Harness programs={['Gold', 'Silver']} />);
    expect(await screen.findByTestId('ready')).toHaveTextContent('yes');
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
  });

  it('PF4: reconcile drops an unusable program back to All programs with a visible notice', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Platinum');
    render(<Harness programs={['Gold', 'Silver']} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[Platinum]'));
    let ok = true;
    act(() => { ok = latest!.reconcile('Platinum', ['Gold', 'Silver']); });
    expect(ok).toBe(false);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
    expect(await screen.findByTestId('program-filter-dropped')).toHaveTextContent(
      'Program “Platinum” isn\'t available here — showing all programs.',
    );
    expect(window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY)).toBeNull();
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
