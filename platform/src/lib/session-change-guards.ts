/**
 * Session-change guards — a dependency-free registry that lets a feature veto or clean up before the browser's
 * session changes (logout, switching / exiting the assumed brand).
 *
 * A guard is registered by the feature module itself when it loads (e.g. the Sales Import upload store), so code
 * that never loaded such a feature runs no guard at all: with nothing registered `runSessionChangeGuards` resolves
 * true at once, and logout / brand switching behave exactly as before. A guard returns false to cancel the change
 * (the user chose to stay); it may await clean-up (e.g. cancel an upload with the CURRENT session) before returning
 * true.
 *
 * `force` (e.g. "log out of all devices" — the session is already revoked server-side): guards must not ask and must
 * not veto; they still clean up best-effort. Every guard is bounded by GUARD_TIMEOUT_MS so a slow clean-up can never
 * hang a logout or a brand switch (on timeout the change proceeds).
 */

export type SessionChangeKind = 'logout' | 'switch-brand';
export interface SessionChangeOptions {
  /** Do not prompt; the change must happen (clean-up is best-effort). A guard's veto is ignored. */
  force?: boolean;
}
export type SessionChangeGuard = (kind: SessionChangeKind, opts: SessionChangeOptions) => Promise<boolean> | boolean;

export const GUARD_TIMEOUT_MS = 5000;

const guards = new Set<SessionChangeGuard>();

export function registerSessionChangeGuard(g: SessionChangeGuard): () => void {
  guards.add(g);
  return () => { guards.delete(g); };
}

function withTimeout(p: Promise<boolean> | boolean, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(true), ms); // a hung clean-up never blocks the change
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(true); }, // a broken guard must never trap the user in a session
    );
  });
}

/** Runs every guard in turn; false as soon as one vetoes (never when `force`). */
export async function runSessionChangeGuards(kind: SessionChangeKind, opts: SessionChangeOptions = {}): Promise<boolean> {
  for (const g of [...guards]) {
    let r: Promise<boolean> | boolean;
    try {
      r = g(kind, opts);
    } catch {
      continue;
    }
    const ok = await withTimeout(r, GUARD_TIMEOUT_MS);
    if (!ok && !opts.force) return false;
  }
  return true;
}

/** Test-only. */
export function __resetSessionChangeGuardsForTests(): void {
  guards.clear();
}
