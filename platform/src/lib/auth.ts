import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  userId: string;
  role: string;
  partnerId?: string;
  iat?: number;
  exp?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'loyalty-platform-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';
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

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Verify and decode a JWT. Returns the payload or null on invalid/expired.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
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
 * Extract and verify the JWT from an Authorization: Bearer <token> header.
 * Returns the payload or null if missing/invalid.
 */
export function getAuthUser(req: { headers: { get: (key: string) => string | null } }): TokenPayload | null {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}

// ─── Legacy exports for backward compatibility ────────────────────────────────

/** @deprecated Use generateToken instead */
export function signToken(payload: { userId: string; role: string; mobile?: string }): string {
  return generateToken(payload.userId, payload.role);
}

export const ROLES = {
  GIFSY_ADMIN: 'GIFSY_ADMIN',
  CLIENT_ADMIN: 'CLIENT_ADMIN',
  MIS_USER: 'MIS_USER',
  SALES_MANAGER: 'SALES_MANAGER',
  AREA_SALES_MANAGER: 'AREA_SALES_MANAGER',
  TERRITORY_SALES_OFFICER: 'TERRITORY_SALES_OFFICER',
  SALES_EXECUTIVE: 'SALES_EXECUTIVE',
  RETAILER: 'RETAILER',
  WHOLESALER: 'WHOLESALER',
  SUB_STOCKIST: 'SUB_STOCKIST',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
