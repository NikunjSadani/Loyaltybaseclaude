/**
 * Auth enforcement constants — the SINGLE SOURCE OF TRUTH for the platform-global
 * security parameters that auth.service.ts enforces at runtime.
 *
 * These were previously magic literals scattered through auth.service.ts (OTP expiry,
 * attempt caps, resend window, refresh/assumed session TTLs). Centralising them here
 * lets the read-only "Security & Platform Config" admin surface (getSettings) display
 * the EXACT values the code enforces, with no risk of the display drifting from the
 * enforced behaviour.
 *
 * These are deployment-global (NOT per-tenant) and are intentionally NOT editable via
 * the admin API — they are changed by editing this file / the deployment, never at
 * runtime. The JWT access-token TTL is the one exception: it stays env-driven
 * (JWT_EXPIRES_IN, default '7d') and is read from process.env where needed.
 */

/** Minutes an issued login OTP remains valid before it expires. */
export const OTP_EXPIRY_MINUTES = 10;

/** Wrong-code attempts allowed against a single OTP before it is locked. */
export const OTP_MAX_ATTEMPTS = 3;

/** Rolling window (hours) over which per-phone OTP sends are counted for the anti-abuse cap. */
export const OTP_RESEND_WINDOW_HOURS = 1;

/** Max OTP sends permitted to a single phone within OTP_RESEND_WINDOW_HOURS. */
export const OTP_MAX_RESENDS_PER_WINDOW = 5;

/** Lifetime (days) of a normal (non-assumed) refresh token / session. */
export const REFRESH_TTL_DAYS = 30;

/** Lifetime (hours) of a GIFSY operator's assumed-tenant (A2) session — short-lived by design. */
export const ASSUMED_SESSION_TTL_HOURS = 8;
