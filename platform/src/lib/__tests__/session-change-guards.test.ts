/// <reference types="vitest/globals" />
/**
 * Session-change guards (logout / brand switch may be vetoed by an in-flight feature, e.g. a Sales Import upload).
 * Run: npx vitest run src/lib/__tests__/session-change-guards.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GUARD_TIMEOUT_MS, registerSessionChangeGuard, runSessionChangeGuards, __resetSessionChangeGuardsForTests,
} from '../session-change-guards';

afterEach(() => vi.useRealTimers());

beforeEach(() => __resetSessionChangeGuardsForTests());

describe('session-change guards', () => {
  it('no guard registered → the change proceeds (behaviour unchanged for everyone else)', async () => {
    await expect(runSessionChangeGuards('logout')).resolves.toBe(true);
  });

  it('a guard can veto; unregistering removes it', async () => {
    const g = vi.fn(async () => false);
    const off = registerSessionChangeGuard(g);
    await expect(runSessionChangeGuards('switch-brand')).resolves.toBe(false);
    expect(g).toHaveBeenCalledWith('switch-brand', {});
    off();
    await expect(runSessionChangeGuards('switch-brand')).resolves.toBe(true);
  });

  it('a throwing guard never traps the user in a session', async () => {
    registerSessionChangeGuard(() => { throw new Error('boom'); });
    await expect(runSessionChangeGuards('logout')).resolves.toBe(true);
  });

  it('force: a veto is ignored and the guard is told not to prompt', async () => {
    const g = vi.fn(async () => false);
    registerSessionChangeGuard(g);
    await expect(runSessionChangeGuards('logout', { force: true })).resolves.toBe(true);
    expect(g).toHaveBeenCalledWith('logout', { force: true });
  });

  it('a hung guard clean-up is time-boxed: the change proceeds after the timeout', async () => {
    vi.useFakeTimers();
    registerSessionChangeGuard(() => new Promise<boolean>(() => {}));
    let done: boolean | null = null;
    void runSessionChangeGuards('switch-brand').then((v) => { done = v; });
    await vi.advanceTimersByTimeAsync(GUARD_TIMEOUT_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});
