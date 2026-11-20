/// <reference types="vitest/globals" />
/**
 * React #418 (hydration mismatch) regression — client-only state must never be read during the
 * hydration render. Each hook is server-rendered with react-dom/server (which uses the hook's SERVER
 * snapshot), hydrated with hydrateRoot over that exact HTML, and must:
 *   1. hydrate with NO recoverable error (server snapshot === initial client render), and
 *   2. show the client value right after hydration, and keep following store updates.
 * Run: npx vitest run src/lib/__tests__/hydration-safe-hooks.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from '@testing-library/react';

// Client-only state that exists BEFORE the modules load (exactly like a returning browser session).
vi.hoisted(() => {
  localStorage.setItem('gifsy_settings_v1', JSON.stringify({ visibilityEnabled: true }));
  localStorage.setItem('assumedBrand', 'Bajaj');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q === '(display-mode: standalone)',
      media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

// Never let a background refresh / server reconcile resolve — the tests drive the store directly.
vi.mock('@/lib/api-client', () => ({
  api: { get: vi.fn(() => new Promise(() => {})), put: vi.fn() },
}));
vi.mock('@/lib/auth-actions', () => ({
  getAssumedContext: vi.fn(() => new Promise(() => {})),
}));

import {
  useGifsySettings, useGifsySettingsReady, hydrateGifsySettings,
  getGifsySettingsServerSnapshot, DEFAULT_SETTINGS,
} from '@/lib/gifsy-settings';
import { useTodayLabel, getTodayLabelSnapshot } from '@/lib/use-today-label';
import { useAssumedContext } from '@/lib/use-assumed-context';
import { useInstallPrompt } from '@/lib/pwa/install-prompt-store';

const roots: Root[] = [];
afterEach(() => {
  act(() => { roots.splice(0).forEach((r) => r.unmount()); });
  document.body.innerHTML = '';
});

/** SSR → paste the HTML → hydrateRoot. Returns the server HTML, the container and any hydration errors. */
async function ssrThenHydrate(el: React.ReactElement) {
  const serverHtml = renderToString(el);
  const container = document.createElement('div');
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const consoleErr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  await act(async () => {
    roots.push(hydrateRoot(container, el, { onRecoverableError: (e) => { errors.push(e); } }));
  });
  consoleErr.mockRestore();
  return { serverHtml, container, errors };
}

function SettingsProbe() {
  return <span data-v>{useGifsySettings().visibilityEnabled ? 'visibility-on' : 'visibility-off'}</span>;
}
function DateProbe() {
  return <span data-v>{useTodayLabel() ?? 'no-date'}</span>;
}
function AssumedProbe() {
  const { brand, ready } = useAssumedContext();
  return <span data-v>{ready ? (brand ?? 'platform') : 'not-ready'}</span>;
}
function InstallProbe() {
  return <span data-v>{useInstallPrompt().installed ? 'installed' : 'not-installed'}</span>;
}

describe('hydration-safe client stores (React #418)', () => {
  it('useGifsySettings: server snapshot = DEFAULT_SETTINGS = initial client render; cached value after hydration', async () => {
    expect(getGifsySettingsServerSnapshot()).toBe(DEFAULT_SETTINGS);
    const { serverHtml, container, errors } = await ssrThenHydrate(<SettingsProbe />);
    expect(serverHtml).toContain('visibility-off');
    expect(errors).toEqual([]);
    expect(container.textContent).toBe('visibility-on');
  });

  it('useGifsySettings: store updates propagate to a hydrated component', async () => {
    const { container } = await ssrThenHydrate(<SettingsProbe />);
    expect(container.textContent).toBe('visibility-on');
    act(() => {
      hydrateGifsySettings({ visibilityEnabled: false } as Parameters<typeof hydrateGifsySettings>[0]);
    });
    expect(container.textContent).toBe('visibility-off');
    act(() => {
      hydrateGifsySettings({ visibilityEnabled: true } as Parameters<typeof hydrateGifsySettings>[0]);
    });
    expect(container.textContent).toBe('visibility-on');
  });

  it('useGifsySettingsReady: false in SSR / hydration render, true right after', async () => {
    function ReadyProbe() {
      const ready = useGifsySettingsReady();
      const on = useGifsySettings().visibilityEnabled === true;
      return <span>{ready ? (on ? 'ready-on' : 'ready-off') : 'not-ready'}</span>;
    }
    act(() => {
      hydrateGifsySettings({ visibilityEnabled: true } as Parameters<typeof hydrateGifsySettings>[0]);
    });
    const { serverHtml, container, errors } = await ssrThenHydrate(<ReadyProbe />);
    expect(serverHtml).toContain('not-ready');
    expect(errors).toEqual([]);
    // Never observed "ready" together with the SSR default — ready and the cached value land together.
    expect(container.textContent).toBe('ready-on');
  });

  it('useGifsySettings: another tab writing the cache (storage event) applies here', async () => {
    const { container } = await ssrThenHydrate(<SettingsProbe />);
    expect(container.textContent).toBe('visibility-on');
    const next = JSON.stringify({ visibilityEnabled: false });
    localStorage.setItem('gifsy_settings_v1', next);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'gifsy_settings_v1', newValue: next }));
    });
    expect(container.textContent).toBe('visibility-off');
  });

  it('useTodayLabel: no date in SSR (no build-date / ICU mismatch); browser date after hydration', async () => {
    const { serverHtml, container, errors } = await ssrThenHydrate(<DateProbe />);
    expect(serverHtml).toContain('no-date');
    expect(errors).toEqual([]);
    expect(container.textContent).toBe(getTodayLabelSnapshot());
  });

  it('useAssumedContext: localStorage hint is not read during hydration; applies right after', async () => {
    const { serverHtml, container, errors } = await ssrThenHydrate(<AssumedProbe />);
    expect(serverHtml).toContain('not-ready');
    expect(errors).toEqual([]);
    expect(container.textContent).toBe('Bajaj');
  });

  it('useInstallPrompt: matchMedia is not read during hydration; installed state applies right after', async () => {
    const { serverHtml, container, errors } = await ssrThenHydrate(<InstallProbe />);
    expect(serverHtml).toContain('not-installed');
    expect(errors).toEqual([]);
    expect(container.textContent).toBe('installed');
  });
});
