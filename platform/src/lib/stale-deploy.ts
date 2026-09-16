/**
 * Self-healing for the Next.js "Failed to find Server Action" error.
 *
 * Server-action IDs are content-hashed PER BUILD. A browser tab left open across a deploy
 * still runs the OLD client bundle, so any server action it fires POSTs an action ID the
 * NEW server no longer knows → Next rejects with "Failed to find Server Action …" (older
 * wording: "Server Action … was not found on the server"). The only real fix is to reload
 * the tab so it pulls the current bundle. This module detects that specific error and
 * triggers a guarded one-shot reload.
 *
 * Scope on purpose: match ONLY the deploy-skew action error — never a generic failure — so
 * a normal error is still surfaced to the user, not silently swallowed by a reload.
 */

// Deploy-skew action errors, across Next versions/wordings. Kept deliberately specific so a
// generic error (e.g. "Server Action failed: outlet not found") can NEVER match and trigger a
// spurious reload — pattern 2 requires the exact "was not found" phrasing, not a bare "not found".
const STALE_DEPLOY_PATTERNS: RegExp[] = [
  /failed to find server action/i,
  /server action\b.*\bwas not found/i, // "Server Action \"<id>\" was not found on the server"
  /from an older or newer deployment/i,
];

/** True only for the Next server-action deploy-skew error (string, Error, or {message}). */
export function isStaleDeploymentError(err: unknown): boolean {
  let msg = '';
  if (typeof err === 'string') msg = err;
  else if (err instanceof Error) msg = err.message;
  else if (err && typeof err === 'object' && 'message' in err) {
    msg = String((err as { message: unknown }).message ?? '');
  }
  if (!msg) return false;
  return STALE_DEPLOY_PATTERNS.some((re) => re.test(msg));
}

// Auto-reload AT MOST ONCE PER SESSION (absolute, not time-windowed). A real deploy skew is
// healed by that one reload; a FALSE-POSITIVE persistent match therefore can never loop or mask
// the underlying error — after the single reload the guard declines and the error surfaces. (A
// second genuine skew later in a long-lived session is rare; a manual reload covers it.)
const RECOVERY_KEY = 'staleDeployReloaded';

/**
 * Hard-reload the tab once to pick up the current client bundle. Returns true if it initiated a
 * reload (caller should stop and let the navigation happen); false if it declined — already
 * reloaded this session, sessionStorage unavailable, or SSR — so the caller falls back to showing
 * the error normally.
 *
 * A hard `location.reload()` (not router.refresh) is required: the STALE artifact is the client
 * JS bundle, which only a full document reload re-downloads.
 */
export function recoverFromStaleDeployment(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(RECOVERY_KEY)) return false; // already reloaded once this session
    window.sessionStorage.setItem(RECOVERY_KEY, '1');
  } catch {
    // sessionStorage blocked (private mode / disabled) → we cannot loop-protect, so do NOT
    // auto-reload; surface the error instead of risking a reload loop.
    return false;
  }
  window.location.reload();
  return true;
}
