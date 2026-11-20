/**
 * Return-to after sign-in (`/auth/login?next=…`) — open-redirect safety + role gating.
 * Run: npx vitest run src/lib/__tests__/return-to.test.ts
 */
import { describe, it, expect } from 'vitest';
import { loginUrlWithNext, readNextParam, returnPathForRole, returnToForEdgeRedirect, safeReturnPath } from '../return-to';

describe('safeReturnPath', () => {
  it('keeps a same-origin relative path with its query', () => {
    expect(safeReturnPath('/admin/tickets?ticket=abc123')).toBe('/admin/tickets?ticket=abc123');
  });

  it.each([
    'https://evil.example/admin',
    '//evil.example/admin',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'admin/tickets',
    '/\t/evil.example',
    ' /admin',
    '/auth/login?next=/admin',
    '/api/tickets',
    '',
    null,
    undefined,
    `/admin/${'x'.repeat(2000)}`,
  ])('rejects %j', (raw) => {
    expect(safeReturnPath(raw as string)).toBeNull();
  });
});

describe('returnPathForRole', () => {
  const next = '/admin/tickets?ticket=t1';
  it('admin roles may return into /admin', () => {
    for (const r of ['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF']) expect(returnPathForRole(next, r)).toBe(next);
  });
  it('a role not admitted to that portal falls back (null → its own home)', () => {
    expect(returnPathForRole(next, 'SALES_ISR')).toBeNull();
    expect(returnPathForRole(next, 'WHOLESALER')).toBeNull();
    expect(returnPathForRole('/sales/support', 'SALES_ISR')).toBe('/sales/support');
    expect(returnPathForRole('/sales/support', 'CLIENT_ADMIN')).toBeNull();
    // partner logins always go through the outlet picker
    expect(returnPathForRole('/partner/support', 'WHOLESALER')).toBeNull();
    expect(returnPathForRole('/administrator', 'CLIENT_ADMIN')).toBeNull();
  });
  it('an unsafe next is never honoured', () => {
    expect(returnPathForRole('//evil.example/admin', 'CLIENT_ADMIN')).toBeNull();
  });
  it('the Visibility photo viewer is a return target for admin + sales roles (not partner / MIS)', () => {
    const photo = '/visibility/photo?key=visibility-media%2Fbajaj%2Fa.jpg';
    for (const r of ['CLIENT_ADMIN', 'GIFSY_ADMIN', 'GIFSY_STAFF', 'SALES_ISR', 'SALES_SO']) expect(returnPathForRole(photo, r)).toBe(photo);
    expect(returnPathForRole(photo, 'WHOLESALER')).toBeNull();
    expect(returnPathForRole(photo, 'MIS_USER')).toBeNull();
  });
});

describe('loginUrlWithNext / readNextParam', () => {
  it('round-trips the deep link through the login URL', () => {
    const url = loginUrlWithNext('/admin/tickets?ticket=t1');
    expect(url).toBe('/auth/login?next=%2Fadmin%2Ftickets%3Fticket%3Dt1');
    expect(readNextParam(url.split('?')[1])).toBe('/admin/tickets?ticket=t1');
  });
  it('keeps extra params and drops an unsafe / login-page next', () => {
    expect(loginUrlWithNext('/admin/x', { expired: '1' })).toBe('/auth/login?expired=1&next=%2Fadmin%2Fx');
    expect(loginUrlWithNext('/auth/login')).toBe('/auth/login');
    expect(loginUrlWithNext('//evil.example')).toBe('/auth/login');
  });
});

describe('returnToForEdgeRedirect (document navigations only)', () => {
  const H = (h: Record<string, string>) => new Headers(h);
  it('a document navigation keeps path + query, minus _rsc', () => {
    expect(returnToForEdgeRedirect('/admin/tickets', '?ticket=t1&_rsc=x', H({ 'sec-fetch-dest': 'document' }))).toBe('/admin/tickets?ticket=t1');
    expect(returnToForEdgeRedirect('/admin/tickets', '?ticket=t1', H({ accept: 'text/html,application/xhtml+xml' }))).toBe('/admin/tickets?ticket=t1');
  });
  it('RSC fetches / prefetches / non-document requests → null', () => {
    for (const h of <Record<string, string>[]>[{ rsc: '1' }, { 'next-router-prefetch': '1' }, { 'next-router-state-tree': 'x' }, { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch;prerender' }, { 'sec-fetch-dest': 'empty' }, { accept: '*/*' }, {}]) {
      expect(returnToForEdgeRedirect('/admin/tickets', '?ticket=t1', H(h))).toBeNull();
    }
  });
});
