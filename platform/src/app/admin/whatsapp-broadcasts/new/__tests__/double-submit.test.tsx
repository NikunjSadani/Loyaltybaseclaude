/// <reference types="vitest/globals" />
/**
 * Fix 1 — confirm-send double-submit guard.
 *
 * A fast double-click on the confirm-send button must POST /whatsapp-broadcasts
 * exactly ONCE (a second POST = a double blast). The guard is a synchronously-set
 * in-flight ref, so it blocks the second call even before React re-renders the
 * button into its disabled state.
 *
 * Run: npx vitest run src/app/admin/whatsapp-broadcasts/new/__tests__/double-submit.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const CREATE_URL = '/api/admin/whatsapp-broadcasts';

const ZERO_VAR_TPL = {
  id: 'tpl-zero',
  name: 'Store closed notice',
  msg91TemplateName: 'store_closed_v1',
  category: 'UTILITY' as const,
  languageCode: 'en',
  bodyText: 'Our store is closed today. Thank you!',
  variableContract: [], // no variables → the map step needs no mapping
  status: 'ACTIVE' as const,
};

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
  },
  authHeader: () => ({}),
}));

import NewBroadcastWizardPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(() => Promise.resolve({ success: true, data: [ZERO_VAR_TPL] }));
  post.mockImplementation((url: string) => {
    if (url.endsWith('/preview')) {
      return Promise.resolve({
        success: true,
        data: { recipientCount: 5, deduped: 0, invalidCount: 0, sample: [] },
      });
    }
    if (url === CREATE_URL) {
      return Promise.resolve({ success: true, data: { id: 'bcast-new' } });
    }
    return Promise.resolve({ success: true, data: {} });
  });
});

function createCallCount() {
  return post.mock.calls.filter((c) => c[0] === CREATE_URL).length;
}

describe('New broadcast wizard — confirm-send double-submit guard (fix 1)', () => {
  it('POSTs the create exactly once even on a fast double-click', async () => {
    render(<NewBroadcastWizardPage />);

    // ① Audience — name the campaign (FILTER mode is the default).
    fireEvent.change(await screen.findByTestId('audience-title'), {
      target: { value: 'Holiday closure notice' },
    });
    fireEvent.click(screen.getByTestId('wizard-next'));

    // ② Template — pick the zero-variable template.
    fireEvent.click(await screen.findByTestId(`template-${ZERO_VAR_TPL.id}`));
    fireEvent.click(screen.getByTestId('wizard-next'));

    // ③ Map — no variables to map → straight through.
    await screen.findByText(/No variables to map/i);
    fireEvent.click(screen.getByTestId('wizard-next'));

    // ④ Preview — auto-runs; wait for "Continue to send" to enable, then advance.
    await waitFor(() => expect(screen.getByTestId('wizard-next')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('wizard-next'));

    // ⑤ Send — open the confirm dialog.
    fireEvent.click(await screen.findByTestId('open-confirm-btn'));

    // Double-click the confirm button as fast as possible (both synchronous).
    const confirmBtn = await screen.findByTestId('confirm-send-btn');
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(createCallCount()).toBeGreaterThanOrEqual(1));
    // give any erroneous second POST a chance to appear
    await Promise.resolve();
    expect(createCallCount()).toBe(1);
    expect(push).toHaveBeenCalledWith('/admin/whatsapp-broadcasts/bcast-new');
  });
});
