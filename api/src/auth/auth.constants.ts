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
 * runtime. The JWT access-token TTL is env-driven (JWT_EXPIRES_IN) but now DECOUPLED
 * from the session/refresh window: it defaults to ACCESS_TTL (60m) so the rolling
 * session actually rolls — a short access token forces frequent refreshes, each of
 * which slides the 7-day session (SESSION_TTL_DAYS) and re-mints a fresh access token.
 */

/**
 * SHORT access-token lifetime — the single source of truth for the JWT access-token
 * `expiresIn` on BOTH the normal and the assumed-tenant (A2) sign paths. Deliberately
 * short (60 minutes) so ordinary activity triggers a refresh roughly hourly; each
 * refresh slides the 7-day session row (SESSION_TTL_DAYS) and re-mints the access
 * token, which is what makes the rolling session non-inert. Env JWT_EXPIRES_IN may
 * override it in a deployment (set to 60m everywhere), but the CODE default is this.
 */
export const ACCESS_TTL = '60m';

/** Numeric minutes form of ACCESS_TTL, for any consumer that needs the number. */
export const ACCESS_TTL_MINUTES = 60;

/** Minutes an issued login OTP remains valid before it expires. */
export const OTP_EXPIRY_MINUTES = 10;

/** Wrong-code attempts allowed against a single OTP before it is locked. */
export const OTP_MAX_ATTEMPTS = 3;

/** Rolling window (hours) over which per-phone OTP sends are counted for the anti-abuse cap. */
export const OTP_RESEND_WINDOW_HOURS = 1;

/** Max OTP sends permitted to a single phone within OTP_RESEND_WINDOW_HOURS. */
export const OTP_MAX_RESENDS_PER_WINDOW = 5;

/**
 * Sliding-session idle window (days). A session/refresh token stays valid for this many
 * days of INACTIVITY: every valid access (jwt.strategy guard) and every refresh
 * (auth.service.generateTokens) re-mints `UserSession.expiresAt = now + SESSION_TTL_DAYS`,
 * so an actively-used session never expires while an idle one lapses after 7 days.
 * This is the single source of truth for that window — used by the guard slide, the
 * normal-session refresh TTL, and the read-only security display (getSettings).
 */
export const SESSION_TTL_DAYS = 7;

/** Lifetime (days) of a normal (non-assumed) refresh token / session. Points at the
 *  sliding-session window (SESSION_TTL_DAYS) so the refresh idle window and the guard
 *  slide share one value; also drives the read-only security display (getSettings). */
export const REFRESH_TTL_DAYS = SESSION_TTL_DAYS;

/** Lifetime (hours) of a GIFSY operator's assumed-tenant (A2) SESSION row — 168h == 7d,
 *  i.e. the SAME window as the sliding home session (SESSION_TTL_DAYS). An assumed session
 *  slides identically via the guard/refresh (each valid request re-mints expiresAt = now+7d),
 *  so an operator working inside a tenant isn't logged out mid-task. This now describes the
 *  assumed SESSION/refresh window ONLY — the assumed ACCESS token uses the short ACCESS_TTL
 *  (60m) like the normal path (decoupled from the session window). Also drives the read-only
 *  security display (assumedSessionTtlHours). */
export const ASSUMED_SESSION_TTL_HOURS = 168;
