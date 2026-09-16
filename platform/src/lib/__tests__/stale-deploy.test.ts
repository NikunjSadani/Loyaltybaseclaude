import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isStaleDeploymentError,
  recoverFromStaleDeployment,
} from '@/lib/stale-deploy';

const reload = vi.fn();
beforeEach(() => {
  reload.mockClear();
  // jsdom's location.reload is non-configurable — redefine window.location wholesale.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/', pathname: '/', origin: 'http://localhost', reload },
  });
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('isStaleDeploymentError', () => {
  it('matches the Next 16 wording', () => {
    expect(isStaleDeploymentError(new Error('Failed to find Server Action "40277a0e".'))).toBe(true);
    expect(isStaleDeploymentError(new Error('Failed to find Server Action. This request might be from an older or newer deployment.'))).toBe(true);
  });
  it('matches the older "was not found on the server" wording', () => {
    expect(isStaleDeploymentError(new Error('Server Action "abc123" was not found on the server.'))).toBe(true);
  });
  it('accepts a string or a {message} object, not only Error', () => {
    expect(isStaleDeploymentError('Failed to find Server Action xyz')).toBe(true);
    expect(isStaleDeploymentError({ message: 'from an older or newer deployment' })).toBe(true);
  });
  it('does NOT match unrelated errors (so real failures still surface)', () => {
    expect(isStaleDeploymentError(new Error('Network request failed'))).toBe(false);
    expect(isStaleDeploymentError(new Error('You do not have access to this brand'))).toBe(false);
    // a generic "not found" that isn't the deploy-skew phrasing must NOT match (audit F3)
    expect(isStaleDeploymentError(new Error('Server Action failed: outlet not found'))).toBe(false);
    expect(isStaleDeploymentError(null)).toBe(false);
    expect(isStaleDeploymentError(undefined)).toBe(false);
    expect(isStaleDeploymentError({})).toBe(false);
  });
});

describe('recoverFromStaleDeployment', () => {
  it('reloads once and records the session flag', () => {
    expect(recoverFromStaleDeployment()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('staleDeployReloaded')).toBe('1');
  });

  it('does NOT reload again once already reloaded this session (absolute loop guard)', () => {
    // first call reloads
    expect(recoverFromStaleDeployment()).toBe(true);
    reload.mockClear();
    // any subsequent call this session declines — a false-positive match can never loop
    expect(recoverFromStaleDeployment()).toBe(false);
    expect(recoverFromStaleDeployment()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('declines (no reload) when sessionStorage is unavailable — cannot loop-protect', () => {
    vi.spyOn(window.sessionStorage.__proto__, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(recoverFromStaleDeployment()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
