/// <reference types="vitest/globals" />
/**
 * TDD — OTP/JWT auth path wiring (Task 1.1)
 *
 * Covers:
 *   A — verify-otp uses generateToken (not deprecated signToken) → token decodes to {userId, role}
 *   B — OTP lookup in verify-otp is tenant-scoped (filters by user.clientId)
 *   C — send-otp imports sendOtp from @/lib/msg91 (not @/lib/notifications)
 *   D — send-otp does NOT import sendOTP from @/lib/notifications
 *
 * Run: npx vitest run src/app/api/auth/__tests__/otp-auth-wiring.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { generateToken, verifyToken } from '@/lib/auth';

const ROOT = resolve(__dirname, '../../../..');

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

// ─── A — generateToken produces a decodable {userId, role} token ─────────────

describe('A — generateToken JWT contract', () => {
  it('A1: token issued by generateToken decodes to the supplied userId and role', () => {
    const token = generateToken('user-abc', 'CLIENT_ADMIN');
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('user-abc');
    expect(payload!.role).toBe('CLIENT_ADMIN');
  });

  it('A2: token issued by generateToken with optional partnerId preserves partnerId', () => {
    const token = generateToken('user-xyz', 'SSS', 'partner-99');
    const payload = verifyToken(token);
    expect(payload!.partnerId).toBe('partner-99');
  });

  it('A3: verify-otp route issues token using generateToken, not the deprecated signToken', () => {
    const code = src('app/api/auth/verify-otp/route.ts');
    // Must call generateToken
    expect(code).toMatch(/generateToken\s*\(/);
    // Must NOT call signToken directly for token issuance
    // (signToken may still be imported for backward-compat but must not be called)
    expect(code).not.toMatch(/=\s*signToken\s*\(/);
  });
});

// ─── B — OTP lookup is tenant-scoped ─────────────────────────────────────────

describe('B — verify-otp OTP lookup is tenant-scoped', () => {
  it('B1: verify-otp OtpCode query filters by user clientId relation', () => {
    const code = src('app/api/auth/verify-otp/route.ts');
    // The where clause must include a nested user relation with clientId
    expect(code).toMatch(/user\s*:\s*\{[^}]*clientId/);
  });

  it('B2: verify-otp does NOT do a bare phone-only OtpCode lookup (without user scope)', () => {
    const code = src('app/api/auth/verify-otp/route.ts');
    // A bare lookup would have `where: { phone` with no user scope immediately after
    // We check that any otpCode.findFirst includes a user: { clientId } filter
    // Specifically: no findFirst({ where: { phone: mobile, verifiedAt ... } }) without user scope
    expect(code).not.toMatch(
      /otpCode\.findFirst\(\s*\{[^}]*where\s*:\s*\{[^{}]*phone[^{}]*verifiedAt[^{}]*expiresAt[^{}]*\}\s*,/
    );
  });

  it('B3: clientId variable is referenced before the OtpCode lookup', () => {
    const code = src('app/api/auth/verify-otp/route.ts');
    // clientId must be used in the tenant-scoped OTP lookup
    const otpLookupBlock = code.slice(
      code.indexOf('otpCode.findFirst'),
      code.indexOf('otpCode.findFirst') + 400,
    );
    expect(otpLookupBlock).toMatch(/clientId/);
  });
});

// ─── C — send-otp is wired to msg91.ts, not notifications.ts ─────────────────

describe('C — send-otp messaging provider wiring', () => {
  it('C1: send-otp imports sendOtp from @/lib/msg91', () => {
    const code = src('app/api/auth/send-otp/route.ts');
    expect(code).toMatch(/from\s+['"]@\/lib\/msg91['"]/);
  });

  it('C2: send-otp does NOT import from @/lib/notifications', () => {
    const code = src('app/api/auth/send-otp/route.ts');
    expect(code).not.toMatch(/from\s+['"]@\/lib\/notifications['"]/);
  });

  it('C3: send-otp calls sendOtp (the msg91 canonical function)', () => {
    const code = src('app/api/auth/send-otp/route.ts');
    expect(code).toMatch(/sendOtp\s*\(/);
  });
});
