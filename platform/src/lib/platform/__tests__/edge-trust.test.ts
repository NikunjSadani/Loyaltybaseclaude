/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { resolveTrustedHost } from '../edge-trust';

/** Build a header accessor from a plain map (case-sensitive keys as passed). */
function hdr(map: Record<string, string>) {
  return (name: string): string | null => map[name] ?? null;
}

const REAL = 'deoleoloyalty.gifsy.in';
const ORIGIN = 'gifsy-frontend-abc.a.run.app';

describe('resolveTrustedHost — S1 edge trust boundary', () => {
  it('no EDGE_SECRET configured → trusts x-forwarded-host (unchanged behaviour)', () => {
    const h = hdr({ 'x-forwarded-host': REAL, host: ORIGIN });
    expect(resolveTrustedHost(h, undefined)).toBe(REAL);
  });

  it('EDGE_SECRET set + matching x-edge-secret (via worker) → trusts x-forwarded-host', () => {
    const h = hdr({ 'x-forwarded-host': REAL, host: ORIGIN, 'x-edge-secret': 's3cr3t' });
    expect(resolveTrustedHost(h, 's3cr3t')).toBe(REAL);
  });

  it('EDGE_SECRET set + NO x-edge-secret (direct .run.app hit) → IGNORES forged x-forwarded-host, uses Host', () => {
    const h = hdr({ 'x-forwarded-host': REAL, host: ORIGIN }); // attacker forges x-forwarded-host
    expect(resolveTrustedHost(h, 's3cr3t')).toBe(ORIGIN);
  });

  it('EDGE_SECRET set + WRONG x-edge-secret → IGNORES x-forwarded-host, uses Host', () => {
    const h = hdr({ 'x-forwarded-host': REAL, host: ORIGIN, 'x-edge-secret': 'wrong' });
    expect(resolveTrustedHost(h, 's3cr3t')).toBe(ORIGIN);
  });

  it('falls back to Host when x-forwarded-host is absent (even when verified)', () => {
    const h = hdr({ host: ORIGIN, 'x-edge-secret': 's3cr3t' });
    expect(resolveTrustedHost(h, 's3cr3t')).toBe(ORIGIN);
  });

  it('returns null when neither trusted x-forwarded-host nor Host is present', () => {
    expect(resolveTrustedHost(hdr({}), 's3cr3t')).toBeNull();
  });
});
