import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { validateSession } from './session';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  userId: string;
  role: string;
  partnerId?: string;
  /** Tenant identifier — present on tokens minted by generateAccessToken (S3+). */
  clientId?: string;
  /** Stable session id — the UserSession.token value the JWT is a signed envelope for. */
  sid?: string;
  iat?: number;
  exp?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

/**
 * Lazy getter for JWT secret — validated at request time, not build time.
 * This prevents next build from crashing when the env var is absent during
 * static page-data collection (Next.js internally sets NODE_ENV=production
 * during the build, so a module-level check would throw in the Docker builder).
 */
function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is not set. Refusing to start.');
    }
    return 'dev-only-insecure-secret-do-not-use-in-production';
  }
  return secret;
}
const BCRYPT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 10;

// ─── OTP Utilities ────────────────────────────────────────────────────────────

/**
 * Generate a random 6-digit OTP string.
 */
export function generateOTP(): string {
  const otp = Math.floor(100000 + Math.random() * 900000);
  return otp.toString();
}

/**
 * Verify an OTP for a given phone and purpose. Marks it as verified on success.
 */
export async function verifyOTP(
  phone: string,
  otp: string,
  purpose: string
): Promise<boolean> {
  const record = await prisma.otpCode.findFirst({
    where: {
      phone,
      purpose: purpose as any,
      code: otp,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!record) return false;

  await prisma.otpCode.update({
    where: { id: record.id },
    data: { verifiedAt: new Date() },
  });

  return true;
}

/**
 * Persist a new OTP record to the database (call after generateOTP).
 */
export async function storeOTP(
  phone: string,
  otp: string,
  purpose: string,
  userId?: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
  await prisma.otpCode.create({
    data: { phone, code: otp, purpose: purpose as any, expiresAt, userId: userId ?? null },
  });
}

// ─── JWT Utilities ────────────────────────────────────────────────────────────

/**
 * Create a signed JWT for the given user.
 */
export function generateToken(
  userId: string,
  role: string,
  partnerId?: string
): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = { userId, role };
  if (partnerId) payload.partnerId = partnerId;

  return jwt.sign(payload, getJWTSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Create a signed JWT for a fully-authenticated session (S3+).
 *
 * Carries four claims beyond the legacy token:
 *   - `clientId`  — the tenant this session belongs to (bound at login from the subdomain).
 *   - `sid`       — a stable session identifier equal to `UserSession.token`.
 *                   The JWT is a signed envelope around the sid; the sid is the stable key
 *                   used to look up and validate the session server-side. This lets the JWT
 *                   be re-minted (e.g. S4 sliding) without breaking the session row.
 *
 * Expiry: '365d' — matches the SESSION_IDLE_DAYS sliding window in lib/session.ts.
 * Server-side idle enforcement (validateSession) is the real gate; the JWT expiry is
 * set long so it never expires client-side before the server-side session does.
 * (The legacy JWT_EXPIRES_IN default is '7d', which is shorter than the 365-day session
 * window, so we pass an explicit '365d' here rather than reusing it.)
 */
export function generateAccessToken(input: {
  userId: string;
  role: string;
  clientId: string;
  sid: string;
  partnerId?: string;
}): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    userId: input.userId,
    role: input.role,
    clientId: input.clientId,
    sid: input.sid,
  };
  if (input.partnerId) payload.partnerId = input.partnerId;

  return jwt.sign(payload, getJWTSecret(), {
    expiresIn: '365d',
  } as jwt.SignOptions);
}

/**
 * Verify and decode a JWT. Returns the payload or null on invalid/expired.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJWTSecret());
    return decoded as TokenPayload;
  } catch {
    return null;
  }
}

// ─── Hashing Utilities ────────────────────────────────────────────────────────

/**
 * Bcrypt-hash arbitrary string data.
 */
export async function hashData(data: string): Promise<string> {
  return bcrypt.hash(data, BCRYPT_ROUNDS);
}

/**
 * Compare plain-text data against a bcrypt hash.
 */
export async function compareHash(
  data: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(data, hash);
}

// ─── Request Helper ───────────────────────────────────────────────────────────

/**
 * Extract and validate the authenticated user from a request.
 *
 * Logic (in order):
 *  1. DEMO_MODE: if x-user-id and x-user-role headers are present (injected
 *     by the proxy in DEMO_MODE=true), return a demo identity immediately.
 *     Demo requests carry no real session, so validateSession is NOT called.
 *  2. Real path:
 *     a. Read the token from Authorization: Bearer <t> (case-insensitive) or
 *        from the `token` cookie parsed out of the raw Cookie header. The raw
 *        cookie approach is used so that callers passing a minimal
 *        `{ headers: { get } }` object (without a .cookies property) work
 *        correctly — which is the pattern used throughout the codebase.
 *     b. verifyToken() — if null, or payload has no sid, reject (non-session
 *        legacy tokens are not accepted on the authenticated path).
 *     c. validateSession(payload.sid) — checks revoked/idle-expired and bumps
 *        the sliding window. Returns null → reject.
 *     d. Return { userId, role, clientId } from the session (clientId is the
 *        tenant bound at login — 1.8 binding). Include partnerId if present.
 *
 * Returns null if no valid, live session is found.
 */
export async function getAuthUser(
  req: { headers: { get: (key: string) => string | null } },
): Promise<TokenPayload | null> {
  // 1. DEMO_MODE — proxy injects x-user-id/x-user-role; no session exists.
  if (process.env.DEMO_MODE === 'true') {
    const userId = req.headers.get('x-user-id');
    const role   = req.headers.get('x-user-role');
    if (userId && role) {
      const tenantSlug = req.headers.get('x-tenant-slug');
      return { userId, role, clientId: tenantSlug ?? 'deoleo' } as TokenPayload;
    }
    // DEMO_MODE but no injected headers — fall through to null (should not happen in practice).
    return null;
  }

  // 2. Real path — read the raw token.
  let token: string | null = null;

  // 2a. Authorization: Bearer <token> (case-insensitive header name)
  const authHeader =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2a (alt). Cookie: token=<value> — parse the raw Cookie header so callers
  //           that pass a minimal { headers: { get } } object still work.
  if (!token) {
    const cookieHeader = req.headers.get('cookie') ?? req.headers.get('Cookie');
    if (cookieHeader) {
      // Find `token=<value>` in a semicolon-separated list of name=value pairs.
      const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1].trim());
    }
  }

  if (!token) return null;

  // 2b. Verify JWT signature/expiry and extract claims.
  const payload = verifyToken(token);
  if (!payload || !payload.sid) return null; // non-session / legacy tokens rejected

  // 2c. Validate the server-side session (revoked? idle-expired? bumps window).
  const session = await validateSession(payload.sid);
  if (!session) return null;

  // 2d. Return the merged identity: userId+clientId from the session (authoritative),
  //     role+partnerId from the JWT claims.
  const result: TokenPayload = {
    userId: session.userId,
    role: payload.role,
    clientId: session.clientId,
  };
  if (payload.partnerId) result.partnerId = payload.partnerId;
  return result;
}

// ─── Legacy exports for backward compatibility ────────────────────────────────

/** @deprecated Use generateToken instead */
export function signToken(payload: { userId: string; role: string; mobile?: string }): string {
  return generateToken(payload.userId, payload.role);
}
