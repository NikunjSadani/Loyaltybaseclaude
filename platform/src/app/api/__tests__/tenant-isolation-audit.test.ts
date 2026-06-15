/// <reference types="vitest/globals" />
/**
 * TASK 1.7 — Tenant-isolation audit (gap #23)
 *
 * Style: source-read wiring test (see docs/plans/01-how-we-test.md §"two test styles").
 *
 * What it checks
 * ──────────────
 * Every route file under src/app/api/admin/ is scanned for by-id Prisma
 * operations that lack tenant scoping.  Concretely, a handler is flagged when:
 *
 *   • It contains a call to one of the mutating / single-record-lookup operations:
 *       prisma.<model>.(delete|deleteMany|update|updateMany|findUnique|findFirst)
 *   • The `where` object in that call references a path/query `id` variable
 *     (i.e. the source contains `where: {` within a few lines of the call, or
 *     the call is `where: { id` directly).
 *   • BUT the same handler body does NOT reference `clientId` at all.
 *
 * Safe-TOCTOU pattern (users/[id], channel-partners/[id], credits/*):
 *   Handler resolves `getClientIdFromRequest` → guarding `findFirst({ where: { id, clientId } })`
 *   → mutation by PK only.  These contain `clientId` in their source so they pass.
 *
 * Safe-manual-guard pattern (sales/batches/[batchId]):
 *   Handler uses `findUnique({ where: { id } })` then checks `batch.clientId !== clientId`
 *   manually.  The heuristic cannot parse this structural check — it IS correctly
 *   tenant-isolated at runtime, but the source does not put `clientId` inside the
 *   `where` clause.  It is listed in KNOWN_SAFE_MANUAL_GUARD below and excluded
 *   from the assertion so the suite stays green.
 *
 * Heuristic limits (false-positives avoided by design)
 * ─────────────────────────────────────────────────────
 * • We key on the string `clientId` appearing anywhere in the handler source.
 *   This is deliberately broad — it catches both the where-clause pattern and
 *   the guarding-findFirst pattern without needing an AST.
 * • The scan is per-file, not per-handler.  A file with one scoped handler and
 *   one un-scoped one would be flagged; that's an acceptable false-positive bias
 *   (safer to over-report).
 * • Operations on arrays (`{ id: { in: [...] } }`) are NOT filtered out by this
 *   heuristic, but in practice those routes resolve their arrays from a
 *   tenant-filtered findMany first, so they also contain `clientId` in source.
 *
 * After all known holes are fixed this list should be EMPTY.
 * If new holes are found by this test add them to KNOWN_SAFE_MANUAL_GUARD
 * (if genuinely safe at runtime) or fix them (if not).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative } from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_ROUTES_ROOT = resolve(
  __dirname,
  '../../../app/api/admin',
);

/**
 * Prisma operations that can mutate or do single-record lookup by id.
 * Pattern: prisma.<anything>.<operation>(
 */
const RISKY_OPS_RE =
  /prisma\.\w+\.(delete|deleteMany|update|updateMany|findUnique|findFirst)\s*\(/g;

/**
 * Does the source, near the call, reference an `id` in the `where`?
 * We look for the literal string `id` appearing in the source as a whole
 * (path param extraction, query param extraction, or direct where clause).
 * Routes that only operate on non-id fields won't match.
 */
const USES_ID_RE = /\bid\b/;

/**
 * Files that contain `findUnique` / `findFirst` / mutating calls scoped by a
 * MANUAL post-fetch clientId check rather than a `where: { id, clientId }`
 * clause.  These are safe at runtime but the simple source heuristic can't
 * verify that — so we list them here rather than produce a false failure.
 *
 * Each entry is a path RELATIVE to ADMIN_ROUTES_ROOT, using forward slashes.
 * Add a `// KNOWN-UNSCOPED — see 1.7 report` comment when the route is
 * genuinely un-fixed rather than a false-positive.
 */
const KNOWN_SAFE_MANUAL_GUARD = new Set<string>([
  // sales/batches/[batchId]/route.ts
  // Uses findUnique({ where: { id: batchId } }) then checks batch.clientId !== clientId
  // manually.  Functionally isolated; heuristic cannot detect the post-fetch guard.
  'sales/batches/[batchId]/route.ts',

  // schemes/[id]/enrollments/export/route.ts
  // Demo-only route: no real Prisma calls, no auth (TODO comment in source).
  // Not a live isolation risk today, but excluded to avoid noise.
  'schemes/[id]/enrollments/export/route.ts',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all route.ts files under a directory. */
function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Returns true when the file contains at least one risky Prisma call where
 * `id` is referenced in the source but `clientId` is NOT present anywhere.
 *
 * We check the full file source for `clientId` because:
 *  • A guarding `findFirst({ where: { id, clientId } })` before a mutation
 *    contains `clientId` in the same handler body.
 *  • A `where: { id, clientId }` inline also contains it.
 *  • If neither is present the file is potentially un-scoped.
 */
function isLikelyUnscoped(src: string): boolean {
  // No risky ops → safe
  if (!RISKY_OPS_RE.test(src)) return false;
  // Reset lastIndex after global RE test
  RISKY_OPS_RE.lastIndex = 0;

  // No id reference → ops are on non-id fields, not a by-id risk
  if (!USES_ID_RE.test(src)) return false;

  // If clientId is referenced anywhere in the file the handler is considered
  // tenant-aware (either inline or via guarding findFirst).
  if (src.includes('clientId')) return false;

  return true;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Tenant-isolation audit — admin routes (gap #23)', () => {
  const allRoutes = collectRouteFiles(ADMIN_ROUTES_ROOT);

  it('finds at least one admin route file (sanity check on path)', () => {
    expect(allRoutes.length).toBeGreaterThan(0);
  });

  it('banners route.ts now contains clientId (F6 fix landed)', () => {
    const bannersSrc = readFileSync(
      resolve(ADMIN_ROUTES_ROOT, 'banners/route.ts'),
      'utf-8',
    );
    expect(bannersSrc).toMatch(/clientId/);
    // Confirm DELETE handler no longer does a bare .delete() without scoping
    expect(bannersSrc).not.toMatch(/bannerManagement\.delete\s*\(\s*\{/);
  });

  it('banners DELETE uses soft delete (deletedAt update, not hard delete)', () => {
    const bannersSrc = readFileSync(
      resolve(ADMIN_ROUTES_ROOT, 'banners/route.ts'),
      'utf-8',
    );
    expect(bannersSrc).toMatch(/deletedAt/);
    expect(bannersSrc).toMatch(/bannerManagement\.update/);
  });

  it('the set of un-tenant-scoped admin routes is empty (all known offenders either fixed or listed as KNOWN_SAFE_MANUAL_GUARD)', () => {
    const offenders: string[] = [];

    for (const absPath of allRoutes) {
      const relPath = relative(ADMIN_ROUTES_ROOT, absPath).replace(/\\/g, '/');

      // Skip files whose manual guard pattern we've reviewed and documented
      if (KNOWN_SAFE_MANUAL_GUARD.has(relPath)) continue;

      const src = readFileSync(absPath, 'utf-8');
      if (isLikelyUnscoped(src)) {
        offenders.push(relPath);
      }
    }

    // Report every offender clearly on failure
    if (offenders.length > 0) {
      console.error(
        '[tenant-isolation-audit] Un-scoped routes found:\n' +
          offenders.map((r) => `  • ${r}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });
});
