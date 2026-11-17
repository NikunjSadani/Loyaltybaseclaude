import { mapBounded } from './map-bounded';

describe('mapBounded', () => {
  it('keeps input order and never exceeds the concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapBounded([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    await expect(mapBounded([], 8, async () => 1)).resolves.toEqual([]);
  });

  it('rejects when any call rejects', async () => {
    await expect(
      mapBounded([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
