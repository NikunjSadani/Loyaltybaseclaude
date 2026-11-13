/**
 * `Promise.all(items.map(fn))` with at most `concurrency` calls in flight (memory-safety,
 * 2026-11-13). An unbounded fan-out over thousands of items queues thousands of DB queries
 * (and their result objects) at once on a 10-connection pool; this keeps it to a handful.
 * Results keep the input order; the first rejection rejects the whole call (like Promise.all).
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
