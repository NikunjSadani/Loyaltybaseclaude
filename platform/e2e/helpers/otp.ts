/**
 * OTP source — resolves the 6-digit code to type into the login form, per the active env (env.ts).
 *
 * Two strategies, selected by E2E_OTP_STRATEGY (or the env default):
 *   'fixed' — return the known constant (E2E_OTP / FIXED_OTP). This is the LOCAL path and is also
 *             valid on a staging deploy that runs with FIXED_OTP set. No network, deterministic —
 *             identical to the harness's original behavior.
 *   'fetch' — staging with REAL MSG91: the OTP is random and SMS-delivered, so the harness cannot
 *             know it a priori. It fetches the just-sent code from a TEST-ONLY backend endpoint
 *             (E2E_OTP_FETCH_URL). This endpoint is the required staging-side support (see README):
 *             it must be gated to non-prod (e.g. only mounted when a STAGING/E2E flag is set and
 *             guarded by E2E_OTP_FETCH_TOKEN) and must NEVER exist in production. It is an
 *             OBSERVABILITY seam (read the OTP the backend already generated), NOT an auth bypass:
 *             the real verify-otp path is unchanged, so prod is not weakened.
 *
 * Called AFTER "Send OTP" so the code exists to be read (fetch waits/retries briefly for delivery).
 */
import { resolveEnv } from '../fixtures/env';
import type { RoleDef } from '../fixtures/roles';

export async function resolveOtp(role: RoleDef): Promise<string> {
  const env = resolveEnv();

  if (env.otpStrategy === 'fixed') {
    return env.fixedOtp;
  }

  // 'fetch' — pull the just-generated OTP for this phone from the test-only hook.
  const url = env.otpFetchUrl!
    .replace('{phone}', encodeURIComponent(role.phone))
    .replace('{clientId}', encodeURIComponent(role.clientId));

  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.otpFetchToken) headers['x-e2e-otp-token'] = env.otpFetchToken;

  // MSG91 delivery + DB write can lag the send call by a moment — retry a few times before giving up.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const body = (await res.json()) as { otp?: string; code?: string };
        const code = body.otp ?? body.code;
        if (code && /^\d{6}$/.test(code)) return code;
      }
      lastErr = new Error(`OTP-fetch returned HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `Could not fetch staging OTP for ${role.key} (${role.phone}) from ${env.otpFetchUrl}: ${String(lastErr)}. ` +
      'Confirm the test-only OTP-fetch endpoint is deployed + E2E_OTP_FETCH_TOKEN matches (see README).',
  );
}
