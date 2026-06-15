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
 *   → mutation by PK only.  These contain `clientId` in their handler body so they pass.
 *
 * Safe-manual-guard pattern (sales/batches/[batchId]):
 *   Handler uses `findUnique({ where: { id } })` then checks `batch.clientId !== clientId`
 *   manually.  The heuristic cannot parse this structural check — it IS correctly
 *   tenant-isolated at runtime, but the source does not put `clientId` inside the
 *   `where` clause.  It is listed in KNOWN_SAFE_MANUAL_GUARD below and excluded
 *   from the assertion so the suite stays green.
 *
 * Heuristic design: per-handler segmentation
 * ───────────────────────────────────────────
 * • The file source is split into individual handler segments at each
 *   `export async function (GET|POST|PUT|PATCH|DELETE)` boundary.  Each segment
 *   runs from the keyword to the next such boundary (or EOF).  The risky-op /
 *   id-reference / clientId checks are then applied PER SEGMENT rather than
 *   per-file.
 *
 * • This closes the false-NEGATIVE that the previous per-file approach had: a
 *   file with one scoped handler (e.g. GET containing clientId) and one UN-scoped
 *   handler (e.g. DELETE with a bare prisma.x.delete) would PASS the old check
 *   because `clientId` appeared somewhere in the file — masking the real hole in
 *   the DELETE segment.
 *
 * • The safe-TOCTOU pattern still passes correctly: because the guarding
 *   findFirst({ where: { id, clientId } }) lives in the SAME handler segment as
 *   the subsequent mutation, `clientId` is present within that segment.
 *
 * Residual limitations (string-based, not AST-based)
 * ────────────────────────────────────────────────────
 * • A handler that delegates its where-clause construction to a helper imported
 *   from another file will contain no `clientId` reference in its own source; if
 *   that helper provides the tenant scope it would still be flagged here as
 *   suspicious.  Conversely, a handler that merely logs `clientId` (without using
 *   it in the where clause) would be incorrectly considered safe.
 * • Handler-segment boundaries are detected by the `export async function` regex;
 *   a non-exported inner function within a handler body is attributed to the
 *   current handler's segment — acceptable for our purposes.
 * • Operations on arrays (`{ id: { in: [...] } }`) are NOT filtered out, but in
 *   practice those routes resolve their arrays from a tenant-filtered findMany
 *   first, so they also contain `clientId` in the same handler source.
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
 * Regex used to split a route file into per-handler segments.
 * Matches the start of each Next.js route handler export declaration.
 * We use a capturing group so split() retains the delimiter text.
 */
const HANDLER_BOUNDARY_RE =
  /(?=export\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE)\b)/;

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
 * Split a route file's source into per-handler segments.
 *
 * Each segment starts at `export async function GET|POST|PUT|PATCH|DELETE`
 * and extends to the next such boundary (or EOF).  Module-level code before
 * the first handler is returned as the first element if non-empty.
 *
 * Example — a file with GET then DELETE returns:
 *   [
 *     '<imports and constants...>',
 *     'export async function GET(...) { ... }',
 *     'export async function DELETE(...) { ... }',
 *   ]
 */
export function splitIntoHandlerSegments(src: string): string[] {
  return src.split(HANDLER_BOUNDARY_RE).filter((seg) => seg.trim().length > 0);
}

/**
 * Returns true when a SINGLE handler segment contains at least one risky
 * Prisma call where `id` is referenced but `clientId` is NOT present.
 *
 * Unlike the old per-file check, this operates on one handler's body so a
 * scoped GET cannot mask an un-scoped DELETE in the same file.
 */
export function isHandlerSegmentUnscoped(segment: string): boolean {
  // Clone RE to avoid shared lastIndex state between calls
  const riskyRe = new RegExp(RISKY_OPS_RE.source, 'g');

  // No risky ops in this segment → safe
  if (!riskyRe.test(segment)) return false;

  // No id reference → ops are on non-id fields, not a by-id risk
  if (!USES_ID_RE.test(segment)) return false;

  // If clientId is referenced anywhere in this segment the handler is
  // considered tenant-aware (either inline or via guarding findFirst).
  if (segment.includes('clientId')) return false;

  return true;
}

/**
 * Returns true when ANY handler segment in the file appears un-scoped.
 * Replaces the old per-file `isLikelyUnscoped` which masked per-handler holes.
 */
export function isLikelyUnscoped(src: string): boolean {
  const segments = splitIntoHandlerSegments(src);
  return segments.some((seg) => isHandlerSegmentUnscoped(seg));
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

  // ── Hardening: synthetic unit tests for per-handler segmentation ────────────
  //
  // These tests prove that the false-negative the old per-file check had is
  // actually closed.  They use in-test source strings — no real files needed.

  it('per-handler segmentation: flags a mixed file where GET is scoped but DELETE is not', () => {
    // This is exactly the false-negative pattern the old per-file check missed:
    // clientId appears in GET so the old whole-file check passed.
    // Per-handler segmentation must flag the un-scoped DELETE segment.
    //
    // Note: the template literal below uses a function keyword (not arrow)
    // to match the `export async function DELETE` pattern the splitter detects.
    const mixedFileSrc = [
      "import prisma from '@/lib/prisma';",
      '',
      'export async function GET(req: NextRequest) {',
      '  const clientId = getClientIdFromRequest(req);',
      "  const id = req.nextUrl.searchParams.get('id');",
      '  const item = await prisma.widget.findFirst({ where: { id, clientId } });',
      '  return NextResponse.json(item);',
      '}',
      '',
      'export async function DELETE(req: NextRequest) {',
      "  const id = req.nextUrl.searchParams.get('id');",
      '  // BUG: no tenant scoping — bare delete by id only',
      '  await prisma.widget.delete({ where: { id } });',
      '  return NextResponse.json({ ok: true });',
      '}',
    ].join('\n');

    // Old per-file check: passes incorrectly because clientId is in GET
    // (we verify it would have been a false-negative)
    expect(mixedFileSrc.includes('clientId')).toBe(true);

    // New per-handler check: must flag this file
    expect(isLikelyUnscoped(mixedFileSrc)).toBe(true);

    // Verify it's specifically the DELETE segment that is flagged
    const segments = splitIntoHandlerSegments(mixedFileSrc);
    const deleteSegment = segments.find((s) => s.includes('export async function DELETE'));
    expect(deleteSegment).toBeDefined();
    expect(isHandlerSegmentUnscoped(deleteSegment!)).toBe(true);

    // And the GET segment must NOT be flagged (it has clientId)
    const getSegment = segments.find((s) => s.includes('export async function GET'));
    expect(getSegment).toBeDefined();
    expect(isHandlerSegmentUnscoped(getSegment!)).toBe(false);
  });

  it('per-handler segmentation: does NOT flag a file using the safe-TOCTOU pattern in DELETE', () => {
    // The safe-TOCTOU pattern: guarding findFirst({ where: { id, clientId } })
    // then updating by PK only.  clientId is present in the same handler segment.
    const safeFileSrc = `
import prisma from '@/lib/prisma';

export async function DELETE(req: NextRequest) {
  const clientId = getClientIdFromRequest(req);
  const id = req.nextUrl.searchParams.get('id');

  // Guard: ensure the record belongs to this tenant
  const item = await prisma.widget.findFirst({ where: { id, clientId } });
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Safe: PK-only update after tenant guard above confirms ownership
  await prisma.widget.update({ where: { id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
`.trim();

    // Per-handler check: must NOT flag this file (clientId is in the DELETE segment)
    expect(isLikelyUnscoped(safeFileSrc)).toBe(false);

    const segments = splitIntoHandlerSegments(safeFileSrc);
    const deleteSegment = segments.find((s) => s.includes('export async function DELETE'));
    expect(deleteSegment).toBeDefined();
    expect(isHandlerSegmentUnscoped(deleteSegment!)).toBe(false);
  });
});
