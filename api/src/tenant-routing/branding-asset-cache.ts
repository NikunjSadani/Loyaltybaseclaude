/**
 * Small, bounded in-process cache for the public branding-asset route.
 *
 *  - Positive entries: LRU, capped by entry count AND total bytes. Branding keys embed a
 *    fresh uuid per upload, so an entry never goes stale (no TTL needed).
 *  - Negative entries ("this key 404s"): remembered only briefly (TTL) and capped in number,
 *    so a repeated bad key doesn't hit GCS every time but a key that starts to exist is
 *    served shortly after.
 *
 * Per Cloud Run instance; nothing here is required for correctness (a cold cache just reads
 * GCS).
 */
export interface CachedAsset {
  bytes: Buffer;
  contentType: string;
}

export interface BrandingAssetCacheOptions {
  maxEntries: number;
  maxBytes: number;
  missTtlMs: number;
  maxMisses: number;
  now?: () => number;
}

export class BrandingAssetCache {
  // Map iteration order = insertion order → the first key is the least-recently-used.
  private readonly hits = new Map<string, CachedAsset>();
  private readonly misses = new Map<string, number>(); // key → expiry
  private bytes = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BrandingAssetCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(key: string): CachedAsset | undefined {
    const hit = this.hits.get(key);
    if (!hit) return undefined;
    this.hits.delete(key); // move to most-recently-used
    this.hits.set(key, hit);
    return hit;
  }

  set(key: string, asset: CachedAsset): void {
    const size = asset.bytes.length;
    if (size > this.opts.maxBytes) return;
    const prev = this.hits.get(key);
    if (prev) {
      this.bytes -= prev.bytes.length;
      this.hits.delete(key);
    }
    this.hits.set(key, asset);
    this.bytes += size;
    this.misses.delete(key);
    while (this.hits.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.hits.keys().next().value as string;
      this.bytes -= this.hits.get(oldest)!.bytes.length;
      this.hits.delete(oldest);
    }
  }

  isMiss(key: string): boolean {
    const exp = this.misses.get(key);
    if (exp === undefined) return false;
    if (this.now() > exp) {
      this.misses.delete(key);
      return false;
    }
    return true;
  }

  markMiss(key: string): void {
    this.misses.delete(key);
    this.misses.set(key, this.now() + this.opts.missTtlMs);
    while (this.misses.size > this.opts.maxMisses) {
      this.misses.delete(this.misses.keys().next().value as string);
    }
  }

  size(): { entries: number; bytes: number } {
    return { entries: this.hits.size, bytes: this.bytes };
  }
}
