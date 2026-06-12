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

export type AdminRole = 'GIFSY_ADMIN' | 'CLIENT_ADMIN' | 'MIS_USER';

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

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function getAdminSession(): AdminSession {
  if (typeof window === 'undefined') return DEMO_SESSIONS['CLIENT_ADMIN'];
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
  const [session, setSession] = useState<AdminSession>(DEMO_SESSIONS['CLIENT_ADMIN']);

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
