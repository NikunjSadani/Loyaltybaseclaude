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

export type AdminRole = 'GIFSY_ADMIN' | 'CLIENT_ADMIN' | 'MIS_USER';

const ADMIN_ROLES: readonly AdminRole[] = ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'];

/** Human-readable role label for the admin shell header. */
export function adminRoleLabel(role: AdminRole): string {
  switch (role) {
    case 'GIFSY_ADMIN':  return 'Gifsy Admin';
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
  /** Derived: true only for GIFSY_ADMIN. */
  canManageSchemes:  boolean;
}

// ─── Pure access-control helpers ─────────────────────────────────────────────

/**
 * Scheme management is a platform-level capability reserved for GIFSY_ADMIN.
 * CLIENT_ADMIN (tenant admin) is intentionally excluded — schemes are created
 * by the platform operator (Gifsy), not by individual tenants.
 */
export function canManageSchemes(role: AdminRole | string | null): boolean {
  return role === 'GIFSY_ADMIN';
}

// ─── Demo sessions ───────────────────────────────────────────────────────────

const DEMO_SESSIONS: Record<AdminRole, AdminSession> = {
  GIFSY_ADMIN: {
    role:             'GIFSY_ADMIN',
    clientId:         'gifsy',
    name:             'Gifsy Platform Admin',
    canManageSchemes: true,
  },
  CLIENT_ADMIN: {
    role:             'CLIENT_ADMIN',
    clientId:         'deoleo',
    name:             'Rahul Agarwal',
    canManageSchemes: false,
  },
  MIS_USER: {
    role:             'MIS_USER',
    clientId:         'deoleo',
    name:             'MIS User',
    canManageSchemes: false,
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
