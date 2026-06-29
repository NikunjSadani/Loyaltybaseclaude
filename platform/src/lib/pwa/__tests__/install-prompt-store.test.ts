import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getInstallState,
  subscribe,
  promptInstall,
} from '../install-prompt-store';

// Build a fake beforeinstallprompt event with the methods the store consumes.
function makeBip(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const evt = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  evt.prompt = vi.fn().mockResolvedValue(undefined);
  evt.userChoice = Promise.resolve({ outcome });
  vi.spyOn(evt, 'preventDefault');
  return evt;
}

describe('install-prompt-store', () => {
  beforeEach(() => {
    // Reset the module singleton between tests (it holds module-level state).
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures beforeinstallprompt and flips canInstall true', async () => {
    const store = await import('../install-prompt-store');
    expect(store.getInstallState().canInstall).toBe(false);

    const evt = makeBip();
    window.dispatchEvent(evt);

    expect(evt.preventDefault).toHaveBeenCalled();
    expect(store.getInstallState().canInstall).toBe(true);
    expect(store.getInstallState().installed).toBe(false);
  });

  it('promptInstall calls prompt(), resolves the outcome, and clears canInstall', async () => {
    const store = await import('../install-prompt-store');
    const evt = makeBip('accepted');
    window.dispatchEvent(evt);
    expect(store.getInstallState().canInstall).toBe(true);

    const outcome = await store.promptInstall();
    expect(evt.prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('accepted');
    // The deferred event is single-use — canInstall flips back to false.
    expect(store.getInstallState().canInstall).toBe(false);
  });

  it('promptInstall returns "unavailable" when no event was captured', async () => {
    const store = await import('../install-prompt-store');
    expect(await store.promptInstall()).toBe('unavailable');
  });

  it('appinstalled sets installed true and notifies subscribers', async () => {
    const store = await import('../install-prompt-store');
    const cb = vi.fn();
    const unsub = store.subscribe(cb);

    window.dispatchEvent(makeBip());
    expect(store.getInstallState().canInstall).toBe(true);

    window.dispatchEvent(new Event('appinstalled'));
    expect(store.getInstallState().installed).toBe(true);
    expect(store.getInstallState().canInstall).toBe(false);
    expect(cb).toHaveBeenCalled();

    unsub();
  });

  // Reference the static (non-reset) imports so they aren't flagged unused; the
  // per-test dynamic imports above are what exercise the fresh singleton.
  it('exposes a stable public API surface', () => {
    expect(typeof getInstallState).toBe('function');
    expect(typeof subscribe).toBe('function');
    expect(typeof promptInstall).toBe('function');
  });
});
