/**
 * session.ts — Server-side session lifecycle for UserSession rows.
 *
 * DECOUPLED from the JWT mechanism: the caller supplies the raw token string.
 * How the JWT maps to a session token is the concern of the login layer (S3).
 * Do NOT import jsonwebtoken or generate JWTs here.
 *
 * Idle window: 365 days, sliding. `expiresAt` is bumped to `now + 365d` on
 * every successful validateSession call, so a device stays logged in
 * indefinitely as long as it is used at least once per year.
 */

import { prisma } from '@/lib/prisma';
import type { UserSession } from '@prisma/client';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Sliding idle window in days. A session expires after this many days of no use. */
export const SESSION_IDLE_DAYS = 365;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Return a Date that is SESSION_IDLE_DAYS from now.
 * This is used both at session creation and on every bump.
 */
export function slidingExpiry(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + SESSION_IDLE_DAYS);
  return d;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** The shape of a UserSession row as returned from Prisma. */
export type UserSessionRow = UserSession;

/** Input required to create a new session. */
export interface CreateSessionInput {
  userId: string;
  clientId: string;
  token: string;
  deviceId?: string | null;
  deviceName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ─── Lifecycle Functions ───────────────────────────────────────────────────────

/**
 * Create a new UserSession row.
 *
 * Sets `expiresAt` to `now + SESSION_IDLE_DAYS` (the start of the sliding window)
 * and `lastSeenAt` to now.
 *
 * @returns The created row.
 */
export async function createSession(
  input: CreateSessionInput,
): Promise<UserSessionRow> {
  const now = new Date();
  return prisma.userSession.create({
    data: {
      userId: input.userId,
      clientId: input.clientId,
      token: input.token,
      deviceId: input.deviceId ?? null,
      deviceName: input.deviceName ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: slidingExpiry(now),
      lastSeenAt: now,
    },
  });
}

/**
 * Validate a session by its token.
 *
 * Returns null if:
 *   1. The token is not found.
 *   2. The session has been revoked (`revokedAt != null`).
 *   3. The session's idle window has elapsed (`expiresAt <= now`).
 *
 * On success, BUMPS the sliding window:
 *   - `expiresAt` ← `now + SESSION_IDLE_DAYS` (keeps the device logged in)
 *   - `lastSeenAt` ← `now`
 *
 * @returns `{ userId, clientId }` for a live session, or `null`.
 */
export async function validateSession(
  token: string,
): Promise<{ userId: string; clientId: string } | null> {
  const session = await prisma.userSession.findUnique({ where: { token } });

  if (!session) return null;                         // (1) not found
  if (session.revokedAt != null) return null;        // (2) revoked
  const now = new Date();
  if (session.expiresAt <= now) return null;         // (3) idle-expired

  // Live session — bump the sliding window
  await prisma.userSession.update({
    where: { token },
    data: {
      expiresAt: slidingExpiry(now),
      lastSeenAt: now,
    },
  });

  return { userId: session.userId, clientId: session.clientId };
}

/**
 * Revoke a session by token.
 *
 * Idempotent: if the session is already revoked or absent, this is a no-op
 * (Prisma's updateMany silently skips unmatched rows).
 */
export async function revokeSession(token: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: {
      token,
      revokedAt: null,   // only touch rows not already revoked
    },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke all non-revoked sessions for a user.
 *
 * Used by:
 *   - "Log out all devices" action.
 *   - Phone-number change hook (security: force re-auth on all devices).
 *
 * @returns The number of sessions revoked.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
