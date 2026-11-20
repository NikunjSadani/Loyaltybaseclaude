import { isTrustedInternalCall } from './internal-call';

describe('isTrustedInternalCall (server-to-server secret gate)', () => {
  const SECRET = 'a-very-long-internal-secret-0123456789';

  it('FAIL-SAFE: no secret configured → nothing is trusted', () => {
    expect(isTrustedInternalCall(SECRET, undefined)).toBe(false);
    expect(isTrustedInternalCall('', '')).toBe(false);
  });

  it('a configured secret shorter than 16 chars is treated as unset', () => {
    expect(isTrustedInternalCall('short', 'short')).toBe(false);
  });

  it('missing / wrong / different-length presented values are refused', () => {
    expect(isTrustedInternalCall(undefined, SECRET)).toBe(false);
    expect(isTrustedInternalCall(SECRET.slice(0, -1) + 'X', SECRET)).toBe(false);
    expect(isTrustedInternalCall(SECRET + 'extra', SECRET)).toBe(false);
    expect(isTrustedInternalCall(['array'] as unknown, SECRET)).toBe(false);
  });

  it('the exact secret is trusted (a trailing \\r from a Windows-created secret is tolerated)', () => {
    expect(isTrustedInternalCall(SECRET, SECRET)).toBe(true);
    expect(isTrustedInternalCall(SECRET, `${SECRET}\r`)).toBe(true);
  });
});
