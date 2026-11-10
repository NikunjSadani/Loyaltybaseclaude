import { BrandingAssetCache } from './branding-asset-cache';

const buf = (n: number) => Buffer.alloc(n, 1);

describe('BrandingAssetCache', () => {
  let now = 1_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000;
  });

  it('returns what was stored and refreshes recency (LRU)', () => {
    const c = new BrandingAssetCache({ maxEntries: 2, maxBytes: 1_000, missTtlMs: 30_000, maxMisses: 10, now: clock });
    c.set('a', { bytes: buf(10), contentType: 'image/png' });
    c.set('b', { bytes: buf(10), contentType: 'image/png' });
    expect(c.get('a')?.contentType).toBe('image/png'); // touch a → b is now LRU
    c.set('c', { bytes: buf(10), contentType: 'image/gif' });
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.get('c')).toBeDefined();
  });

  it('bounds total bytes, evicting least-recently-used entries', () => {
    const c = new BrandingAssetCache({ maxEntries: 50, maxBytes: 25, missTtlMs: 30_000, maxMisses: 10, now: clock });
    c.set('a', { bytes: buf(10), contentType: 'image/png' });
    c.set('b', { bytes: buf(10), contentType: 'image/png' });
    c.set('c', { bytes: buf(10), contentType: 'image/png' }); // 30 > 25 → evict a
    expect(c.get('a')).toBeUndefined();
    expect(c.size().bytes).toBe(20);
  });

  it('never stores an object larger than the byte budget', () => {
    const c = new BrandingAssetCache({ maxEntries: 50, maxBytes: 5, missTtlMs: 30_000, maxMisses: 10, now: clock });
    c.set('big', { bytes: buf(6), contentType: 'image/png' });
    expect(c.get('big')).toBeUndefined();
    expect(c.size().bytes).toBe(0);
  });

  it('re-setting a key does not double-count its bytes', () => {
    const c = new BrandingAssetCache({ maxEntries: 50, maxBytes: 100, missTtlMs: 30_000, maxMisses: 10, now: clock });
    c.set('a', { bytes: buf(10), contentType: 'image/png' });
    c.set('a', { bytes: buf(10), contentType: 'image/png' });
    expect(c.size()).toEqual({ entries: 1, bytes: 10 });
  });

  it('remembers a miss only briefly (TTL), and bounds the miss set', () => {
    const c = new BrandingAssetCache({ maxEntries: 50, maxBytes: 100, missTtlMs: 30_000, maxMisses: 2, now: clock });
    c.markMiss('x');
    expect(c.isMiss('x')).toBe(true);
    now += 30_001;
    expect(c.isMiss('x')).toBe(false);

    c.markMiss('p');
    c.markMiss('q');
    c.markMiss('r'); // > 2 → oldest dropped
    expect(c.isMiss('p')).toBe(false);
    expect(c.isMiss('q')).toBe(true);
    expect(c.isMiss('r')).toBe(true);
  });
});
