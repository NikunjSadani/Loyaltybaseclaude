/**
 * Split an array into consecutive batches of at most `size` items.
 *
 * Used to send bulk uploads to APIs that cap rows-per-request (e.g. the outlet
 * master upsert caps each request at 500): the UI validates the whole file, then
 * posts the rows in sequential batches and aggregates one combined result.
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('chunkArray: size must be a positive integer');
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
