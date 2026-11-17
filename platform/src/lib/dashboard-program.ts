'use client';

/**
 * useDashboardProgram — the ONE program selection shared by the admin Overview, Program Health and KYC
 * dashboards (and the Overview's Monthly billing progress card).
 *
 *  - '' (ALL_PROGRAMS) = All programs = no filter. Real Outlet.programName values are never blank.
 *  - The choice PERSISTS across those dashboards for the browser session (sessionStorage, every access
 *    wrapped in try/catch — private windows / blocked storage just fall back to All programs).
 *  - A `?program=` in the URL WINS over the stored value when present (shareable links). Changing the
 *    program rewrites that param in place (history.replaceState — Next's router stays in sync), so a
 *    reload keeps showing what the person last picked.
 *  - The selection is resolved on mount (`ready`), so pages wait for it before their first fetch —
 *    no wasted unfiltered request followed by a filtered one, and no hydration mismatch.
 *  - `reconcile()` is called with each response's `availablePrograms`: a selection that this tenant
 *    can't use (unknown program, a stale value from another tenant the staff user assumed, or a tenant
 *    with fewer than 2 programs — where the dropdown is hidden) is dropped back to All programs and
 *    recorded in `droppedProgram` so the screen says so out loud (never a silent zero dashboard).
 */
import { useCallback, useEffect, useState } from 'react';

export const ALL_PROGRAMS = '';
export const PROGRAM_URL_PARAM = 'program';
export const DASHBOARD_PROGRAM_STORAGE_KEY = 'gifsy.adminDashboards.program';
/** The dropdown is only worth showing when there is a real choice to make. */
export const MIN_PROGRAMS_FOR_FILTER = 2;

function readUrlProgram(): string | null {
  try {
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has(PROGRAM_URL_PARAM)) return null;
    return (sp.get(PROGRAM_URL_PARAM) ?? '').trim();
  } catch {
    return null;
  }
}

function readStoredProgram(): string {
  try {
    return (window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY) ?? '').trim();
  } catch {
    return ALL_PROGRAMS;
  }
}

function storeProgram(p: string): void {
  try {
    if (p) window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, p);
    else window.sessionStorage.removeItem(DASHBOARD_PROGRAM_STORAGE_KEY);
  } catch {
    /* storage unavailable — the choice just won't persist */
  }
}

/** Keep `?program=` in step with the selection (only touches the URL when it would actually change). */
function writeUrlProgram(p: string): void {
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.has(PROGRAM_URL_PARAM) ? url.searchParams.get(PROGRAM_URL_PARAM) ?? '' : null;
    if (p) {
      if (current === p) return;
      url.searchParams.set(PROGRAM_URL_PARAM, p);
    } else {
      if (current === null) return;
      url.searchParams.delete(PROGRAM_URL_PARAM);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* non-browser / locked-down history — selection still works in memory */
  }
}

/** The selection is usable against a response's program list: '' always is; a name only when listed AND the dropdown shows. */
export function isProgramUsable(program: string, available: readonly string[] | null | undefined): boolean {
  if (!program) return true;
  const list = available ?? [];
  return list.length >= MIN_PROGRAMS_FOR_FILTER && list.includes(program);
}

/** Append `?<param>=<program>` only for a real selection ('' = All programs = no param, byte-identical URL). */
export function withProgramParam(base: string, program: string, param = PROGRAM_URL_PARAM): string {
  if (!program) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${param}=${encodeURIComponent(program)}`;
}

/**
 * True when a program is selected and the response says this metric stays tenant-wide.
 * Matches the exact key ("pointsEconomy.issued") or its section ("pointsEconomy").
 */
export function isTenantWideMetric(
  program: string,
  notProgramScoped: readonly string[] | null | undefined,
  key: string,
): boolean {
  if (!program || !notProgramScoped || notProgramScoped.length === 0) return false;
  if (notProgramScoped.includes(key)) return true;
  const section = key.split('.')[0];
  return section !== key && notProgramScoped.includes(section);
}

export interface DashboardProgram {
  /** '' = All programs. */
  program: string;
  /** false until the URL / session value has been read (pages wait for it before fetching). */
  ready: boolean;
  setProgram: (p: string) => void;
  /**
   * Check a response (requested with `requested`) against its `availablePrograms`. Returns true when the
   * response may be shown. Returns false — and resets the selection to All programs, recording
   * `droppedProgram` — when the requested program isn't usable; the caller should discard that response
   * (the reset triggers a fresh All-programs fetch).
   */
  reconcile: (requested: string, available: readonly string[] | null | undefined) => boolean;
  /** A program that was dropped because it isn't available here (shown as a notice); null otherwise. */
  droppedProgram: string | null;
  dismissDropped: () => void;
}

export function useDashboardProgram(): DashboardProgram {
  const [program, setProgramState] = useState<string>(ALL_PROGRAMS);
  const [ready, setReady] = useState(false);
  const [droppedProgram, setDroppedProgram] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = readUrlProgram();
    const initial = fromUrl !== null ? fromUrl : readStoredProgram();
    if (fromUrl !== null) storeProgram(fromUrl);
    setProgramState(initial);
    setReady(true);
  }, []);

  const setProgram = useCallback((p: string) => {
    const next = (p ?? '').trim();
    setDroppedProgram(null);
    setProgramState(next);
    storeProgram(next);
    writeUrlProgram(next);
  }, []);

  const reconcile = useCallback<DashboardProgram['reconcile']>((requested, available) => {
    if (isProgramUsable(requested, available)) return true;
    setDroppedProgram(requested);
    // Only reset if the person hasn't already moved on to another choice.
    setProgramState((cur) => {
      if (cur !== requested) return cur;
      storeProgram(ALL_PROGRAMS);
      writeUrlProgram(ALL_PROGRAMS);
      return ALL_PROGRAMS;
    });
    return false;
  }, []);

  const dismissDropped = useCallback(() => setDroppedProgram(null), []);

  return { program, ready, setProgram, reconcile, droppedProgram, dismissDropped };
}
