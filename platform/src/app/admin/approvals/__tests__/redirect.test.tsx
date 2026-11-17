/// <reference types="vitest/globals" />
/**
 * A2 — /admin/approvals is retired. It was an unlinked page whose Approve/Reject buttons only changed
 * local state (nothing was ever saved). Any bookmark / direct visit now lands on the real GIFSY queue,
 * /admin/kyc/approvals, via a client-side replace (same mechanism as /admin/outlets: a server
 * `redirect()` is swallowed by the 'use client' admin layout's error boundary in this Next build).
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push, prefetch: vi.fn() }) }));

import AdminApprovalsRedirect from '../page';

describe('A2 — /admin/approvals redirect', () => {
  beforeEach(() => { replace.mockClear(); push.mockClear(); });

  it('replaces the URL with /admin/kyc/approvals and renders nothing of the old page', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = render(<AdminApprovalsRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/kyc/approvals'));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled(); // replace, not push — Back never returns to the dead URL
    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled(); // the old page's fake queue fetch is gone
    vi.unstubAllGlobals();
  });
});
