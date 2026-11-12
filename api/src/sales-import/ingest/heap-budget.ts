/**
 * The worker's memory budget as FIXED byte amounts derived from the configured OLD-SPACE size (audit of fe04e04, M-1).
 * `--max-old-space-size` is not the total heap: on node:24-alpine `--max-old-space-size=1700` yields a V8
 * heap_size_limit of ≈ 1,892 MB (young generation + code space on top). A fraction of heap_size_limit therefore tripped
 * too late (75 % ≈ 1.42 GB of used heap, with Prisma / buffers / code on top in a 2 GiB container). The budget is now:
 *   - heap backstop trip point = 75 % of the OLD-SPACE size  (1700 → 1,275 MiB; the real file peaks at ≈ 1.06 GB);
 *   - xlsx shared-strings cap  = min(400 MiB, 25 % of the old-space size)  (1700 → 400 MiB).
 * The old-space size is read from the process flags (execArgv wins over NODE_OPTIONS — Node's own precedence); without
 * a flag it is estimated as 90 % of heap_size_limit (the measured 1700 / 1892 ratio).
 */
import * as v8 from 'node:v8';

const MiB = 1024 * 1024;
export const HEAP_TRIP_SHARE_OF_OLD_SPACE = 0.75;
export const SHARED_STRINGS_SHARE_OF_OLD_SPACE = 0.25;
export const SHARED_STRINGS_MAX_BYTES = 400 * MiB;
/** heap_size_limit ≈ old-space / 0.9 (node:24, measured: 1700 → 1892). */
export const OLD_SPACE_SHARE_OF_HEAP_LIMIT = 0.9;

function lastOldSpaceFlag(args: readonly string[]): number | null {
  let v: number | null = null;
  for (const a of args) {
    const m = /^--max-old-space-size=(\d+)$/.exec(a.trim());
    if (m) v = Number(m[1]);
  }
  return v;
}

/** The configured old-space size in MB (execArgv overrides NODE_OPTIONS), or null when no flag is set. */
export function configuredOldSpaceMb(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): number | null {
  return lastOldSpaceFlag(execArgv) ?? lastOldSpaceFlag((nodeOptions ?? '').split(/\s+/).filter(Boolean));
}

/** Old-space size in bytes: the configured flag, else estimated from V8's heap_size_limit. */
export function oldSpaceBytes(
  configuredMb: number | null = configuredOldSpaceMb(),
  heapLimit: number = v8.getHeapStatistics().heap_size_limit,
): number {
  return configuredMb !== null ? configuredMb * MiB : Math.floor(heapLimit * OLD_SPACE_SHARE_OF_HEAP_LIMIT);
}

/** Used-heap bytes at which the backstop trips. */
export function heapTripBytes(oldSpace: number = oldSpaceBytes()): number {
  return Math.floor(oldSpace * HEAP_TRIP_SHARE_OF_OLD_SPACE);
}

/** Max unpacked size of xlsx/sharedStrings.xml (exceljs caches the whole table in the same heap). */
export function sharedStringsCapBytes(oldSpace: number = oldSpaceBytes()): number {
  return Math.min(SHARED_STRINGS_MAX_BYTES, Math.floor(oldSpace * SHARED_STRINGS_SHARE_OF_OLD_SPACE));
}
