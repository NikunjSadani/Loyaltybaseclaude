/// <reference types="vitest/globals" />
/**
 * Session-change guards (logout / brand switch may be vetoed by an in-flight feature, e.g. a Sales Import upload).
 * Run: npx vitest run src/lib/__tests__/session-change-guards.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerSessionChangeGuard, runSessionChangeGuards, __resetSessionChangeGuardsForTests,
} from '../session-change-guards';

beforeEach(() => __resetSessionChangeGuardsForTests());

describe('session-change guards', () => {
  it('no guard registered → the change proceeds (behaviour unchanged for everyone else)', async () => {
    await expect(runSessionChangeGuards('logout')).resolves.toBe(true);
  });

  it('a guard can veto; unregistering removes it', async () => {
    const g = vi.fn(async () => false);
    const off = registerSessionChangeGuard(g);
    await expect(runSessionChangeGuards('switch-brand')).resolves.toBe(false);
    expect(g).toHaveBeenCalledWith('switch-brand');
    off();
    await expect(runSessionChangeGuards('switch-brand')).resolves.toBe(true);
  });

  it('a throwing guard never traps the user in a session', async () => {
    registerSessionChangeGuard(() => { throw new Error('boom'); });
    await expect(runSessionChangeGuards('logout')).resolves.toBe(true);
  });
});
