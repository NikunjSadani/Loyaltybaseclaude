'use client';

/**
 * Admin Session
 *
 * In production: role comes from the decoded JWT (set by the API auth middleware).
 * For the demo: a localStorage key lets you switch between GIFSY_ADMIN and CLIENT_ADMIN.
 *
 * Multi-tenant rules:
 *  - GIFSY_ADMIN  — platform-wide; can access scheme management for any tenant
 *  - CLIENT_ADMIN — tenant-scoped; cannot access scheme management
 *  - All other roles — no admin access
 */

import { useState, useEffect } from 'react';
import { getStoredUser } from './auth-client';

export type AdminRole = 'GIFSY_ADMIN' | 'CLIENT_ADMIN' | 'MIS_USER' | 'GIFSY_STAFF';

const ADMIN_ROLES: readonly AdminRole[] = ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_STAFF'];

/** Human-readable role label for the admin shell header. */
export function adminRoleLabel(role: AdminRole): string {
  switch (role) {
    case 'GIFSY_ADMIN':  return 'Gifsy Admin';
    case 'GIFSY_STAFF':  return 'Gifsy Staff';
    case 'MIS_USER':     return 'MIS User';
    case 'CLIENT_ADMIN': return 'Client Admin';
    default:             return 'Client Admin';
  }
}

export interface AdminSession {
  role:              AdminRole;
  /** The tenant this admin belongs to. GIFSY_ADMIN has clientId = 'gifsy'. */
  clientId:          string;
  name:              string;
  /** The signed-in user's own id (from the stored JWT user). Empty before hydration
   *  or when no real user is present. Drives self-deactivate button-hiding only —
   *  the backend guard is the real protection. */
  userId:            string;
  /** Derived: true only for GIFSY_ADMIN. */
  canManageSchemes:  boolean;
}

// ─── Pure access-control helpers ─────────────────────────────────────────────

/**
 * Scheme management is a platform-OPERATOR capability. GIFSY_ADMIN (owner) and, RBAC Option-X
 * (P5), GIFSY_STAFF (a limited operator, who reaches the admin shell only while ASSUMED into a
 * granted brand) both qualify — the seed Ops/PM roles carry scheme permissions. CLIENT_ADMIN
 * (tenant admin) is intentionally excluded. NOTE: this gates the OPERATOR nav profile; per-item
 * permission-aware hiding for staff (so a staff sees only the operator surfaces their role can
 * use, rather than the full set with unpermitted items returning a backend 403) is the tracked
 * follow-up — the same "refine once roles are wired" posture the rest of this nav already carries.
 */
export function canManageSchemes(role: AdminRole | string | null): boolean {
  return role === 'GIFSY_ADMIN' || role === 'GIFSY_STAFF';
}

// ─── Demo sessions ───────────────────────────────────────────────────────────

const DEMO_SESSIONS: Record<AdminRole, AdminSession> = {
  GIFSY_ADMIN: {
    role:             'GIFSY_ADMIN',
    clientId:         'gifsy',
    name:             'Gifsy Platform Admin',
    userId:           '',
    canManageSchemes: true,
  },
  CLIENT_ADMIN: {
    role:             'CLIENT_ADMIN',
    clientId:         'deoleo',
    name:             'Rahul Agarwal',
    userId:           '',
    canManageSchemes: false,
  },
  MIS_USER: {
    role:             'MIS_USER',
    clientId:         'deoleo',
    name:             'MIS User',
    userId:           '',
    canManageSchemes: false,
  },
  // RBAC Option-X (P5): a Gifsy operator BELOW the owner. Real identity comes from the stored
  // JWT user (this is only the pre-hydration / not-logged-in placeholder, never a live persona).
  GIFSY_STAFF: {
    role:             'GIFSY_STAFF',
    clientId:         'gifsy',
    name:             'Gifsy Staff',
    userId:           '',
    canManageSchemes: true,
  },
};

const ADMIN_SESSION_KEY = 'admin_role_demo';

// Neutral pre-hydration placeholder — carries NO demo name, so the SSR HTML and the first client
// paint never contain a fabricated identity (#40). Identical on server and client (no hydration
// mismatch); the real user is filled in on mount by useAdminSession's effect.
const LOADING_SESSION: AdminSession = {
  role:             'CLIENT_ADMIN',
  clientId:         'deoleo',
  name:             '',
  userId:           '',
  canManageSchemes: false,
};

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function getAdminSession(): AdminSession {
  if (typeof window === 'undefined') return LOADING_SESSION;

  // REAL identity first: a logged-in admin's name + role come from the JWT user
  // (stored at login). This replaces the demo persona ("Rahul Agarwal") so the
  // shell header shows the actual signed-in user — never a fabricated name (#40).
  const user = getStoredUser();
  if (user && (ADMIN_ROLES as readonly string[]).includes(user.role)) {
    const role = user.role as AdminRole;
    return {
      role,
      // clientId is not carried on the JWT user; GIFSY operates platform-wide,
      // every other admin is tenant-scoped (the real brand resolves via the
      // client-config/brand context, not from here). Display uses name + role.
      clientId: role === 'GIFSY_ADMIN' ? 'gifsy' : DEMO_SESSIONS[role].clientId,
      name: user.name,
      // The stored JWT user carries a real `id` (StoredUser.id from auth-client);
      // fall back to `sub` then '' so the field is never a fabricated value.
      userId: (user as { id?: string; sub?: string }).id ?? (user as { sub?: string }).sub ?? '',
      canManageSchemes: canManageSchemes(role),
    };
  }

  // Fallback (not logged in / non-admin role): keep the dev demo switch.
  const stored = localStorage.getItem(ADMIN_SESSION_KEY) as AdminRole | null;
  const role: AdminRole =
    stored && stored in DEMO_SESSIONS ? stored : 'CLIENT_ADMIN';
  return {
    ...DEMO_SESSIONS[role],
    canManageSchemes: canManageSchemes(role),
  };
}

export function setDemoAdminRole(role: AdminRole): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(ADMIN_SESSION_KEY, role);
    window.dispatchEvent(new Event('admin-session-change'));
  }
}

// ─── React hook ──────────────────────────────────────────────────────────────

export function useAdminSession(): AdminSession {
  // Start from the neutral placeholder (no demo name) — matches the SSR output so there is no
  // hydration mismatch and no flash of a fabricated identity; the effect swaps in the real user.
  const [session, setSession] = useState<AdminSession>(LOADING_SESSION);

  useEffect(() => {
    setSession(getAdminSession());
    const handler = () => setSession(getAdminSession());
    window.addEventListener('admin-session-change', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('admin-session-change', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  return session;
}
