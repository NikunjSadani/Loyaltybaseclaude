import { configuredOldSpaceMb, heapTripBytes, oldSpaceBytes, sharedStringsCapBytes } from './heap-budget';

const MiB = 1024 * 1024;

describe('heap budget from the OLD-SPACE size (audit M-1)', () => {
  it('reads --max-old-space-size from execArgv (wins) or NODE_OPTIONS; last flag wins; null when absent', () => {
    expect(configuredOldSpaceMb(['--max-old-space-size=1700'], '--max-old-space-size=1536')).toBe(1700);
    expect(configuredOldSpaceMb([], '--enable-source-maps --max-old-space-size=1536')).toBe(1536);
    expect(configuredOldSpaceMb(['--max-old-space-size=1000', '--max-old-space-size=1700'], undefined)).toBe(1700);
    expect(configuredOldSpaceMb([], undefined)).toBeNull();
  });

  it('job (old-space 1700): trip at 1,275 MiB used heap; shared strings ≤ 400 MiB — independent of heap_size_limit', () => {
    const old = oldSpaceBytes(1700, 1892 * MiB);
    expect(old).toBe(1700 * MiB);
    expect(heapTripBytes(old)).toBe(1275 * MiB);
    expect(sharedStringsCapBytes(old)).toBe(400 * MiB);
    expect(heapTripBytes(old)).toBeGreaterThan(1060 * MiB * 1.15); // the real file (≈ 1.06 GB peak) passes with > 15 % margin
  });

  it('no flag: the old space is estimated as 90 % of heap_size_limit', () => {
    expect(oldSpaceBytes(null, 1000 * MiB)).toBe(900 * MiB);
    expect(heapTripBytes(oldSpaceBytes(null, 1000 * MiB))).toBe(675 * MiB);
    expect(sharedStringsCapBytes(oldSpaceBytes(null, 1000 * MiB))).toBe(225 * MiB);
  });
});
