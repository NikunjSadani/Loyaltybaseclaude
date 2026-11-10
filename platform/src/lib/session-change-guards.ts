/**
 * Session-change guards — a dependency-free registry that lets a feature veto or clean up before the browser's
 * session changes (logout, switching the assumed brand).
 *
 * A guard is registered by the feature module itself when it loads (e.g. the Sales Import upload store), so code
 * that never loaded such a feature runs no guard at all: logout / brand switching behave exactly as before for every
 * tenant and page that has nothing in flight. A guard returns false to cancel the session change (the user chose to
 * stay); it may await clean-up (e.g. cancel an upload with the CURRENT session) before returning true.
 */

export type SessionChangeKind = 'logout' | 'switch-brand';
export type SessionChangeGuard = (kind: SessionChangeKind) => Promise<boolean> | boolean;

const guards = new Set<SessionChangeGuard>();

export function registerSessionChangeGuard(g: SessionChangeGuard): () => void {
  guards.add(g);
  return () => { guards.delete(g); };
}

/** Runs every guard in turn; false as soon as one vetoes. A throwing guard never blocks the change. */
export async function runSessionChangeGuards(kind: SessionChangeKind): Promise<boolean> {
  for (const g of [...guards]) {
    try {
      if (!(await g(kind))) return false;
    } catch {
      /* a broken guard must never trap the user in a session */
    }
  }
  return true;
}

/** Test-only. */
export function __resetSessionChangeGuardsForTests(): void {
  guards.clear();
}
