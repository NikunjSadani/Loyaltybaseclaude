/**
 * Task 1.6b-1 — requirePermission helper tests
 *
 * Contract under test:
 *   requirePermission(authUser, permission) → null (allowed) | NextResponse (denied)
 *
 * Two-level flag:
 *   Level 1 — process.env.RBAC_ENFORCEMENT === 'true'   (global master switch)
 *   Level 2 — ClientConfig.features.rbacEnforcement     (per-tenant opt-in)
 *
 * Null means "caller may proceed". A NextResponse means "caller must return it".
 *
 * Mocks:
 *   - '@/lib/rbac/can'                    → can()
 *   - '@/lib/platform/client-config-db'   → getClientConfigFromDb()
 *
 * process.env.RBAC_ENFORCEMENT is set/restored around each test that needs it ON.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// ─── Mock the two server-side dependencies before importing the module ────────

vi.mock('@/lib/rbac/can', () => ({
  can: vi.fn(),
}));

vi.mock('@/lib/platform/client-config-db', () => ({
  getClientConfigFromDb: vi.fn(),
}));

// Import the mocks so we can configure them per-test
import { can } from '@/lib/rbac/can';
import { getClientConfigFromDb } from '@/lib/platform/client-config-db';

// Import the module under test (after mocks are registered)
import { requirePermission } from '../require-permission';

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockCan = vi.mocked(can);
const mockGetClientConfigFromDb = vi.mocked(getClientConfigFromDb);

/** Build a minimal ClientConfig-like object with just the features.rbacEnforcement flag. */
function makeConfig(rbacEnforcement: boolean) {
  return {
    features: { rbacEnforcement },
  } as unknown as Awaited<ReturnType<typeof getClientConfigFromDb>>;
}

const AUTH_USER = { role: 'CLIENT_ADMIN', clientId: 'deoleo' } as const;

// ─── Restore env after each test that mutates it ─────────────────────────────

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.RBAC_ENFORCEMENT;
  // Default to OFF for every test — individual tests that need it ON set it themselves
  delete process.env.RBAC_ENFORCEMENT;
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.RBAC_ENFORCEMENT;
  } else {
    process.env.RBAC_ENFORCEMENT = originalEnv;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. authUser is null → 401 (defensive, checked before the flag)
// ─────────────────────────────────────────────────────────────────────────────

describe('authUser is null', () => {
  it('returns a 401 NextResponse when authUser is null', async () => {
    const result = await requirePermission(null, 'users:read');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('does NOT call getClientConfigFromDb when authUser is null', async () => {
    await requirePermission(null, 'users:read');
    expect(mockGetClientConfigFromDb).not.toHaveBeenCalled();
  });

  it('does NOT call can() when authUser is null', async () => {
    await requirePermission(null, 'users:read');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('401 response body has success:false and an error field', async () => {
    const result = await requirePermission(null, 'users:write');
    const body = await (result as NextResponse).json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Master switch OFF (env unset or not 'true') → null, NO DB read
// ─────────────────────────────────────────────────────────────────────────────

describe('master switch OFF (RBAC_ENFORCEMENT !== "true")', () => {
  it('returns null when env is unset — even if can() would return false', async () => {
    mockCan.mockReturnValue(false);

    const result = await requirePermission(AUTH_USER, 'users:write');

    expect(result).toBeNull();
  });

  it('does NOT call getClientConfigFromDb when master switch is OFF (no DB read)', async () => {
    mockCan.mockReturnValue(false);

    await requirePermission(AUTH_USER, 'tenancy:manage_flags');

    expect(mockGetClientConfigFromDb).not.toHaveBeenCalled();
  });

  it('returns null when env is explicitly set to "false"', async () => {
    process.env.RBAC_ENFORCEMENT = 'false';
    mockCan.mockReturnValue(false);

    const result = await requirePermission(AUTH_USER, 'users:read');

    expect(result).toBeNull();
  });

  it('returns null when env is "TRUE" (case-sensitive — must be exactly "true")', async () => {
    process.env.RBAC_ENFORCEMENT = 'TRUE';
    mockCan.mockReturnValue(false);

    const result = await requirePermission(AUTH_USER, 'users:read');

    expect(result).toBeNull();
    expect(mockGetClientConfigFromDb).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Master ON + tenant rbacEnforcement false → null (allow)
// ─────────────────────────────────────────────────────────────────────────────

describe('master ON + tenant rbacEnforcement: false', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCEMENT = 'true';
  });

  it('returns null when tenant has rbacEnforcement: false — even if can() would return false', async () => {
    mockGetClientConfigFromDb.mockResolvedValue(makeConfig(false));
    mockCan.mockReturnValue(false);

    const result = await requirePermission(AUTH_USER, 'users:write');

    expect(result).toBeNull();
  });

  it('calls getClientConfigFromDb with the authUser.clientId', async () => {
    mockGetClientConfigFromDb.mockResolvedValue(makeConfig(false));

    await requirePermission(AUTH_USER, 'users:read');

    expect(mockGetClientConfigFromDb).toHaveBeenCalledWith(AUTH_USER.clientId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Master ON + tenant rbacEnforcement true + can() true → null (allow)
// ─────────────────────────────────────────────────────────────────────────────

describe('master ON + tenant rbacEnforcement: true + can() true', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCEMENT = 'true';
    mockGetClientConfigFromDb.mockResolvedValue(makeConfig(true));
  });

  it('returns null when can() returns true', async () => {
    mockCan.mockReturnValue(true);

    const result = await requirePermission(AUTH_USER, 'users:read');

    expect(result).toBeNull();
  });

  it('calls can() with the authUser.role and the requested permission', async () => {
    mockCan.mockReturnValue(true);

    await requirePermission(AUTH_USER, 'reports:export');

    expect(mockCan).toHaveBeenCalledWith(AUTH_USER.role, 'reports:export');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Master ON + tenant rbacEnforcement true + can() false → 403
// ─────────────────────────────────────────────────────────────────────────────

describe('master ON + tenant rbacEnforcement: true + can() false', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCEMENT = 'true';
    mockGetClientConfigFromDb.mockResolvedValue(makeConfig(true));
    mockCan.mockReturnValue(false);
  });

  it('returns a 403 NextResponse', async () => {
    const result = await requirePermission(AUTH_USER, 'tenancy:manage_flags');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it('403 response body has success: false', async () => {
    const result = await requirePermission(AUTH_USER, 'tenancy:manage_flags');
    const body = await (result as NextResponse).json();
    expect(body.success).toBe(false);
  });

  it('403 response body error message mentions the permission', async () => {
    const result = await requirePermission(AUTH_USER, 'tenancy:manage_flags');
    const body = await (result as NextResponse).json();
    expect(body.error).toContain('tenancy:manage_flags');
  });

  it('403 when MIS_USER tries a write permission', async () => {
    const misUser = { role: 'MIS_USER', clientId: 'deoleo' };
    const result = await requirePermission(misUser, 'credits:upload');

    expect((result as NextResponse).status).toBe(403);

    const body = await (result as NextResponse).json();
    expect(body.error).toContain('credits:upload');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Master ON + getClientConfigFromDb returns null (unknown tenant) → null (fail-open)
// ─────────────────────────────────────────────────────────────────────────────

describe('master ON + getClientConfigFromDb returns null (unknown tenant)', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCEMENT = 'true';
    // Simulate an unknown tenant or DB down — getClientConfigFromDb returns null
    mockGetClientConfigFromDb.mockResolvedValue(null);
    // Even if can() would deny, fail-open means we return null
    mockCan.mockReturnValue(false);
  });

  it('returns null (fail-open) when the DB returns no config for the tenant', async () => {
    const result = await requirePermission(AUTH_USER, 'users:delete');

    // Fail-open: the old inline role checks still gate; RBAC enforcement requires
    // a tenant row to opt in — without one we cannot assume enforcement is active.
    expect(result).toBeNull();
  });

  it('does NOT call can() when config is null (no tenant row = not enforcing)', async () => {
    await requirePermission(AUTH_USER, 'users:delete');
    expect(mockCan).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Master ON + config exists but rbacEnforcement missing/undefined → null
// ─────────────────────────────────────────────────────────────────────────────

describe('master ON + rbacEnforcement missing from config', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCEMENT = 'true';
    // Config exists but the rbacEnforcement flag is not set (pre-migration rows)
    mockGetClientConfigFromDb.mockResolvedValue({
      features: {},
    } as unknown as Awaited<ReturnType<typeof getClientConfigFromDb>>);
    mockCan.mockReturnValue(false);
  });

  it('returns null (falsy feature flag = not enforcing)', async () => {
    const result = await requirePermission(AUTH_USER, 'users:write');
    expect(result).toBeNull();
  });
});
