/**
 * RequireAuth keeps where a signed-out user was going (`/auth/login?next=<path+query>`).
 * Run: npx vitest run src/components/auth/__tests__/require-auth-next.test.tsx
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('@/lib/auth-client', () => ({ getStoredUser: () => null, getRoleHome: () => '/auth/login' }));

import { RequireAuth } from '../require-auth';

beforeEach(() => {
  replace.mockReset();
  window.history.replaceState(null, '', '/admin/tickets?ticket=t1');
});

describe('RequireAuth return-to', () => {
  it('a signed-out visit to a deep link redirects to login carrying ?next=', async () => {
    render(<RequireAuth><p>secret</p></RequireAuth>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/login?next=%2Fadmin%2Ftickets%3Fticket%3Dt1'));
  });
});
