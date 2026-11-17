'use client';

/**
 * useDashboardProgram — the ONE program selection shared by the admin Overview, Program Health and KYC
 * dashboards (and the Overview's Monthly billing progress card).
 *
 *  - '' (ALL_PROGRAMS) = All programs = no filter. Real Outlet.programName values are never blank.
 *  - The choice PERSISTS across those dashboards for the browser session (sessionStorage, every access
 *    wrapped in try/catch — private windows / blocked storage just fall back to All programs). The key is
 *    scoped to the TENANT clientId AND the user id, so a program never leaks into another tenant or another
 *    person on the same browser. The access token is an httpOnly cookie (AF-6) — JS can't decode it, and the
 *    client deliberately keeps no clientId — so the key comes from GET /api/auth/me. That lookup NEVER blocks:
 *    pages fetch at once (URL program or All programs) and a stored program is applied when the session
 *    resolves; the lookup is hard-capped at 2 s; and it is skipped entirely when nothing is stored and no
 *    program is chosen (an unfiltered tenant makes no extra round-trip). Session unknown → nothing restored
 *    or stored.
 *  - `reconcile()` failing on ONE page shows the notice and resets that page, but never overwrites the stored
 *    choice (another dashboard may well have that program).
 *  - A program restored from storage is written into `?program=` on mount, so the address bar always says
 *    what the screen is filtered by (and a copied link reproduces it).
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredUser } from './auth-client';

export const ALL_PROGRAMS = '';
export const PROGRAM_URL_PARAM = 'program';
/** Prefix only — the real key is per tenant + user (`dashboardProgramStorageKey`). */
export const DASHBOARD_PROGRAM_STORAGE_KEY = 'gifsy.adminDashboards.program';
export const AUTH_ME_URL = '/api/auth/me';

/** sessionStorage key for one tenant + one user. */
export function dashboardProgramStorageKey(clientId: string, userId: string): string {
  return `${DASHBOARD_PROGRAM_STORAGE_KEY}:${clientId}:${userId}`;
}

/** Hard cap on the session lookup. */
export const SESSION_LOOKUP_TIMEOUT_MS = 2000;

/** True when ANY dashboard program is stored in this browser session (otherwise nothing can be restored). */
function hasStoredPrograms(): boolean {
  try {
    const s = window.sessionStorage;
    for (let i = 0; i < s.length; i++) if ((s.key(i) ?? '').startsWith(`${DASHBOARD_PROGRAM_STORAGE_KEY}:`)) return true;
  } catch { /* storage unavailable */ }
  return false;
}

/**
 * Resolve the storage key from the authoritative session (GET /api/auth/me → `{ id, clientId }`, the same call
 * `useAuthClientId` makes; user id falls back to the stored login user). null when it can't be resolved or the
 * lookup exceeds `timeoutMs` (hard cap — it never holds a page up).
 */
export function resolveDashboardProgramKey(timeoutMs = SESSION_LOOKUP_TIMEOUT_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { ctrl?.abort(); resolve(null); }, timeoutMs);
  });
  return Promise.race([fetchStorageKey(ctrl?.signal), timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function fetchStorageKey(signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(AUTH_ME_URL, { credentials: 'include', ...(signal ? { signal } : {}) });
    if (!r || !r.ok) return null;
    const j = (await r.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const d = (j && typeof j === 'object' && j.data && typeof j.data === 'object' ? j.data : j) as Record<string, unknown>;
    const clientId = typeof d?.clientId === 'string' ? d.clientId : '';
    const nested = d?.user && typeof d.user === 'object' ? (d.user as { id?: unknown }).id : undefined;
    const userId = String((typeof d?.id === 'string' && d.id) || (typeof nested === 'string' && nested) || getStoredUser()?.id || '');
    return clientId && userId ? dashboardProgramStorageKey(clientId, userId) : null;
  } catch {
    return null;
  }
}
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

function readStoredProgram(key: string | null): string {
  if (!key) return ALL_PROGRAMS;
  try {
    return (window.sessionStorage.getItem(key) ?? '').trim();
  } catch {
    return ALL_PROGRAMS;
  }
}

function storeProgram(key: string | null, p: string): void {
  if (!key) return; // session unknown → never write under a guessed key
  try {
    if (p) window.sessionStorage.setItem(key, p);
    else window.sessionStorage.removeItem(key);
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

/**
 * The selection is usable against a response's program list: '' always is; a name only when listed AND the page's
 * dropdown shows (`minPrograms` — Overview / Program Health use 2; the KYC dashboard uses 1).
 */
export function isProgramUsable(
  program: string,
  available: readonly string[] | null | undefined,
  minPrograms: number = MIN_PROGRAMS_FOR_FILTER,
): boolean {
  if (!program) return true;
  const list = available ?? [];
  return list.length >= Math.max(1, minPrograms) && list.includes(program);
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
  reconcile: (requested: string, available: readonly string[] | null | undefined, minPrograms?: number) => boolean;
  /** A program that was dropped because it isn't available here (shown as a notice); null otherwise. */
  droppedProgram: string | null;
  dismissDropped: () => void;
}

export function useDashboardProgram(): DashboardProgram {
  const [program, setProgramState] = useState<string>(ALL_PROGRAMS);
  const [ready, setReady] = useState(false);
  const [droppedProgram, setDroppedProgram] = useState<string | null>(null);
  // Per tenant + user storage key (null until /auth/me resolves, or when it can't).
  const keyRef = useRef<string | null>(null);
  const keyPromiseRef = useRef<Promise<string | null> | null>(null);
  // The latest selection, so a late-resolving session stores what the person has picked meanwhile.
  const programRef = useRef<string>(ALL_PROGRAMS);
  const touchedRef = useRef(false);
  const aliveRef = useRef(true);

  /** Start (once) the capped session lookup. */
  const lookupKey = useCallback((): Promise<string | null> => {
    if (!keyPromiseRef.current) {
      keyPromiseRef.current = resolveDashboardProgramKey().then((key) => {
        keyRef.current = key;
        return key;
      });
    }
    return keyPromiseRef.current;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const fromUrl = readUrlProgram();
    if (fromUrl !== null) {
      programRef.current = fromUrl;
      setProgramState(fromUrl);
    }
    // NEVER wait for the session: pages fetch now (URL program or All programs).
    setReady(true);
    // Look the session up only when it can matter: a link to persist, or something stored to restore.
    if (fromUrl === null && !hasStoredPrograms()) return () => { aliveRef.current = false; };
    void lookupKey().then((key) => {
      if (!aliveRef.current) return;
      if (fromUrl !== null || touchedRef.current) {
        storeProgram(key, programRef.current);
        return;
      }
      const restored = readStoredProgram(key);
      if (!restored) return;
      programRef.current = restored;
      setProgramState(restored); // the page refetches with it
      writeUrlProgram(restored); // the address bar says what the screen is filtered by
    });
    return () => { aliveRef.current = false; };
  }, [lookupKey]);

  const setProgram = useCallback((p: string) => {
    const next = (p ?? '').trim();
    touchedRef.current = true;
    programRef.current = next;
    setDroppedProgram(null);
    setProgramState(next);
    writeUrlProgram(next);
    if (keyPromiseRef.current) {
      // Known (or resolving) session → store the LATEST choice once it is known.
      void keyPromiseRef.current.then((key) => storeProgram(key, programRef.current));
    } else {
      void lookupKey().then((key) => storeProgram(key, programRef.current));
    }
  }, [lookupKey]);

  const reconcile = useCallback<DashboardProgram['reconcile']>((requested, available, minPrograms) => {
    if (isProgramUsable(requested, available, minPrograms)) return true;
    setDroppedProgram(requested);
    // Only reset if the person hasn't already moved on to another choice. The STORED choice is left alone —
    // this page can't use it, another dashboard may.
    setProgramState((cur) => {
      if (cur !== requested) return cur;
      programRef.current = ALL_PROGRAMS;
      writeUrlProgram(ALL_PROGRAMS);
      return ALL_PROGRAMS;
    });
    return false;
  }, []);

  const dismissDropped = useCallback(() => setDroppedProgram(null), []);

  return { program, ready, setProgram, reconcile, droppedProgram, dismissDropped };
}
