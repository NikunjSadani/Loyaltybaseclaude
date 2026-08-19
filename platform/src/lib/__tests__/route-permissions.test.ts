/// <reference types="vitest/globals" />
/**
 * RBAC Option-X P6 — admin route → permission resolver.
 * Most-specific (longest '/'-boundary prefix) wins; ungated routes return null.
 */

import { describe, it, expect } from 'vitest';
import { requiredPermissionForPath } from '@/lib/rbac/route-permissions';

describe('requiredPermissionForPath()', () => {
  it('maps top-level admin routes to their natural permission', () => {
    expect(requiredPermissionForPath('/admin/schemes')).toBe('schemes:read');
    expect(requiredPermissionForPath('/admin/payouts')).toBe('payouts:read');
    expect(requiredPermissionForPath('/admin/tickets')).toBe('support:read');
    expect(requiredPermissionForPath('/admin/gifts')).toBe('rewards:read');
    expect(requiredPermissionForPath('/admin/visibility')).toBe('visibility:read');
    expect(requiredPermissionForPath('/admin/credits-payouts')).toBe('credits:read');
  });

  it('prefers the MORE-specific child over the parent prefix', () => {
    // /admin/users → users:read, but /admin/users/outlets → partners:read
    expect(requiredPermissionForPath('/admin/users')).toBe('users:read');
    expect(requiredPermissionForPath('/admin/users/outlets')).toBe('partners:read');
    expect(requiredPermissionForPath('/admin/users/parents')).toBe('partners:read');
    // KYC dashboard is a read of KYC, siblings are reporting reads
    expect(requiredPermissionForPath('/admin/dashboards/kyc')).toBe('kyc:read');
    expect(requiredPermissionForPath('/admin/dashboards/finance')).toBe('reports:read');
  });

  it('does NOT fold sibling paths that share a stem but no slash boundary', () => {
    // /admin/tds-config must NOT match the '/admin/tds' key (no '/' between)
    expect(requiredPermissionForPath('/admin/tds')).toBe('payouts:view_tds');
    expect(requiredPermissionForPath('/admin/tds-config')).toBe('payouts:view_tds');
    expect(requiredPermissionForPath('/admin/tds-recovery')).toBe('payouts:view_tds');
  });

  it('inherits the section permission for deep sub-paths', () => {
    expect(requiredPermissionForPath('/admin/users/123/edit')).toBe('users:read');
    expect(requiredPermissionForPath('/admin/credits-payouts/upload')).toBe('credits:read');
  });

  it('returns null for intentionally ungated / unknown routes', () => {
    expect(requiredPermissionForPath('/admin/dashboard')).toBeNull(); // Overview
    expect(requiredPermissionForPath('/admin/sales')).toBeNull(); // Sales Data
    expect(requiredPermissionForPath('/admin/does-not-exist')).toBeNull();
  });
});
