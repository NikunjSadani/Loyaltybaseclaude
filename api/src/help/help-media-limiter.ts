import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN,
  HELP_MEDIA_PER_IP_PER_MIN,
  HELP_MEDIA_PER_TOKEN_PER_MIN,
} from './help.constants';

const WINDOW_MS = 60_000;
/** Bound the maps so a flood of distinct tokens/IPs cannot grow memory without limit. */
const MAX_KEYS = 50_000;

interface Bucket {
  start: number;
  count: number;
}

/**
 * Rate limits for the PUBLIC help-media route (it is @SkipThrottle: the global per-route bucket keys on req.ip,
 * which behind the Next rewrite is ONE value for every viewer, so it would cut playback for everyone at once).
 * In-memory, per API instance — the same model as the global throttler.
 *
 *  - per TOKEN: ≤ HELP_MEDIA_PER_TOKEN_PER_MIN requests / minute and ≤ HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN open
 *    streams at once (one viewer = one token; a leaked token cannot be used to pull the file in a loop);
 *  - per IP: ≤ HELP_MEDIA_PER_IP_PER_MIN / minute — a per-instance backstop (behind the proxy `req.ip` is the
 *    frontend, so this caps total media traffic per instance rather than one person).
 * Over a limit → 429 with Retry-After.
 */
@Injectable()
export class HelpMediaLimiter {
  private readonly perToken = new Map<string, Bucket>();
  private readonly perIp = new Map<string, Bucket>();
  private readonly open = new Map<string, number>();

  /** Clock (overridable in tests). */
  now: () => number = Date.now;

  static tokenKey(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 32);
  }

  private hit(map: Map<string, Bucket>, key: string, limit: number): boolean {
    const t = this.now();
    const b = map.get(key);
    if (!b || t - b.start >= WINDOW_MS) {
      if (!b && map.size >= MAX_KEYS) this.sweep(map, t);
      map.set(key, { start: t, count: 1 });
      return true;
    }
    b.count += 1;
    return b.count <= limit;
  }

  private sweep(map: Map<string, Bucket>, t: number): void {
    for (const [k, b] of map) if (t - b.start >= WINDOW_MS) map.delete(k);
    // Still full (a burst of distinct keys inside one window): drop the oldest half rather than grow.
    if (map.size >= MAX_KEYS) {
      let n = Math.floor(map.size / 2);
      for (const k of map.keys()) {
        if (n-- <= 0) break;
        map.delete(k);
      }
    }
  }

  private tooMany(): HttpException {
    return new HttpException('Too many requests for this video — please wait a moment.', HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Count one request. Throws 429 when the token or IP is over its per-minute limit. */
  check(tokenKey: string, ip: string | undefined): void {
    const ipOk = this.hit(this.perIp, ip || 'unknown', HELP_MEDIA_PER_IP_PER_MIN);
    const tokenOk = this.hit(this.perToken, tokenKey, HELP_MEDIA_PER_TOKEN_PER_MIN);
    if (!ipOk || !tokenOk) throw this.tooMany();
  }

  /** Reserve one concurrent stream slot for the token; returns the release function. Throws 429 when full. */
  acquireStream(tokenKey: string): () => void {
    const n = this.open.get(tokenKey) ?? 0;
    if (n >= HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN) throw this.tooMany();
    this.open.set(tokenKey, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(tokenKey) ?? 1) - 1;
      if (left <= 0) this.open.delete(tokenKey);
      else this.open.set(tokenKey, left);
    };
  }

  /** Test seam. */
  openStreams(tokenKey: string): number {
    return this.open.get(tokenKey) ?? 0;
  }
}
