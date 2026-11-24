/**
 * Outlet → its sales hierarchy (ASM · SO · ISR — name + employee ID) for outlet-level reports (Target vs Sales,
 * owner 2026-11-23). Tenant-agnostic; a cell is NEVER silently blank.
 *
 * RESOLUTION (the SAME assignment rule as user-area.ts — `forEachCoveredOutlet`):
 *   1. The outlet's reps = every ACTIVE sales user assigned to it directly (SalesUserAssignment.outletId), to its
 *      owner (partnerId = Outlet.partnerId) or to its parent group (partnerId = Outlet.parentId). Inactive / vacant /
 *      removed reps cover nothing (`isLiveSalesUser`).
 *   2. For each rep and each rung (ASM, SO, XSR/ISR) walk UP the reportingTo chain starting AT the rep (a rep who
 *      IS an SO is their own SO):
 *        – the first person whose level code is the rung → their name + employee code; a VACANT position (inactive /
 *          removed / placeholder login) → "Vacant (<employee code>)" + the code (user-area's convention: we show the
 *          vacant territory, never skip to the next manager up);
 *        – passed a MORE senior level without meeting the rung (e.g. the ISR column for an outlet whose rep is an SO),
 *          no manager, a dangling link or a cycle → nothing from this rep.
 *   3. Several reps → the DISTINCT (name, ID) pairs, sorted by name, joined with " | " (names can contain commas) — the Name and ID cells list
 *      the pairs in the SAME order, so the n-th name belongs to the n-th ID.
 *   4. Nothing found → "Not set" in both cells.
 *   5. A tenant whose hierarchy has NO level with that code (e.g. a tenant without an ISR level) → "Not set" in
 *      both cells for every outlet; the About sheet says so (`notes`).
 *
 * Headers use the tenant's own level name (SalesHierarchyLevel.name — Bajaj: XSR → "ISR"), else the Bajaj display
 * label, else the default ("ASM" / "SO" / "ISR"): "<label> Name", "<label> Employee ID".
 *
 * Cost: four tenant-wide reads (levels, sales users, assignments, outlets — the last two keyset-paged ≤ 2,000 rows),
 * whatever the number of report rows; resolution is in memory and memoised per (rep, rung).
 */
import { isBajajTenant, rungDisplayLabel } from '../../common/hierarchy-labels';
import { HIERARCHY_MAX_HOPS } from '../../sales/sales-hierarchy-access.helper';
import {
  AREA_NOT_SET,
  forEachCoveredOutlet,
  hierarchyRankByCode,
  isLiveSalesUser,
  type AreaPrisma,
  type AssignmentRow,
  type LevelRow,
  type SalesUserRow,
} from './user-area';

/** The three rungs the outlet columns show, most senior first (column order). */
export const OUTLET_HIERARCHY_RUNGS = [
  { code: 'ASM', fallback: 'ASM' },
  { code: 'SO', fallback: 'SO' },
  { code: 'XSR', fallback: 'ISR' },
] as const;

/** Joins several people in one cell — not ", " because a name can contain a comma. */
export const OUTLET_HIERARCHY_SEPARATOR = ' | ';

export interface OutletHierarchyOutlet {
  id: string;
  partnerId: string | null;
  parentId?: string | null;
}

export interface OutletHierarchyResolver {
  /** Six headers: <ASM> Name, <ASM> Employee ID, <SO> Name, <SO> Employee ID, <ISR> Name, <ISR> Employee ID. */
  headers: string[];
  /** rung code → the label used in its headers. */
  labels: Record<string, string>;
  /** Labels of the rungs this tenant has no level for (their cells always read "Not set"). */
  missingRungs: string[];
  /** The six cells for one outlet (by Outlet.id); an unknown / absent id → all "Not set". */
  cellsFor(outletId: string | null | undefined): string[];
  /** The sales-user rows (soft-deleted included) — reused by the manager filter so it costs no extra read. */
  salesUsers: SalesUserRow[];
  /** The tenant's levels — reused by the manager dropdown. */
  levels: LevelRow[];
  /** Plain-English lines for the About sheet. */
  notes: string[];
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

interface Pair {
  name: string;
  id: string;
}

export function buildOutletHierarchyResolver(
  clientId: string,
  levels: LevelRow[],
  salesUsers: SalesUserRow[],
  assignments: AssignmentRow[],
  outlets: OutletHierarchyOutlet[],
): OutletHierarchyResolver {
  levels = (levels ?? []).filter(Boolean);
  salesUsers = (salesUsers ?? []).filter((s) => !!s?.id);
  const rankByCode = hierarchyRankByCode(levels);
  const levelCodes = new Set(levels.map((l) => clean(l.code).toUpperCase()));
  const levelNameByCode = new Map<string, string>();
  for (const l of levels) {
    const n = clean(l.name);
    if (n) levelNameByCode.set(clean(l.code).toUpperCase(), n);
  }

  const labels: Record<string, string> = {};
  for (const r of OUTLET_HIERARCHY_RUNGS) {
    labels[r.code] =
      levelNameByCode.get(r.code) || (isBajajTenant(clientId) ? clean(rungDisplayLabel(clientId, r.code)) : '') || r.fallback;
  }
  const headers = OUTLET_HIERARCHY_RUNGS.flatMap((r) => [`${labels[r.code]} Name`, `${labels[r.code]} Employee ID`]);
  // A rung the tenant has no level for. With NO levels at all nothing can carry a code → every rung is missing.
  const missing = new Set(OUTLET_HIERARCHY_RUNGS.filter((r) => !levelCodes.has(r.code)).map((r) => r.code));
  const missingRungs = OUTLET_HIERARCHY_RUNGS.filter((r) => missing.has(r.code)).map((r) => labels[r.code]);

  const suById = new Map<string, SalesUserRow>();
  for (const s of salesUsers) suById.set(s.id, s);
  const codeOf = (s: SalesUserRow) => clean(s.hierarchyLevel?.code).toUpperCase();

  // ── reps per outlet (the user-area assignment rule) ──
  const repsByOutlet = new Map<string, Set<string>>();
  forEachCoveredOutlet(assignments ?? [], (outlets ?? []).filter(Boolean), (id) => suById.get(id), (rep, o) => {
    const set = repsByOutlet.get(o.id) ?? new Set<string>();
    set.add(rep.id);
    repsByOutlet.set(o.id, set);
  });

  // ── rung of one rep (memoised) ──
  const memo = new Map<string, Pair | null>();
  function rungOf(repId: string, code: string): Pair | null {
    const key = `${repId}\u0000${code}`;
    if (memo.has(key)) return memo.get(key)!;
    const rungRank = rankByCode.get(code);
    let out: Pair | null = null;
    const seen = new Set<string>();
    let cur: string | null = repId;
    for (let hops = 0; cur && hops <= HIERARCHY_MAX_HOPS; hops++) {
      if (seen.has(cur)) break; // cycle guard
      seen.add(cur);
      const m = suById.get(cur);
      if (!m) break; // dangling link
      const c = codeOf(m);
      if (c === code) {
        const emp = clean(m.employeeCode);
        out = isLiveSalesUser(m)
          ? { name: clean(m.user?.name) || AREA_NOT_SET, id: emp || AREA_NOT_SET }
          : { name: `Vacant (${emp || 'no code'})`, id: emp || AREA_NOT_SET };
        break;
      }
      const r = rankByCode.get(c);
      if (rungRank !== undefined && r !== undefined && r > rungRank) break; // passed the rung without meeting it
      cur = m.reportingToId;
    }
    memo.set(key, out);
    return out;
  }

  const NOT_SET_ROW = headers.map(() => AREA_NOT_SET);
  const cellMemo = new Map<string, string[]>();
  function cellsFor(outletId: string | null | undefined): string[] {
    if (!outletId) return NOT_SET_ROW;
    const hit = cellMemo.get(outletId);
    if (hit) return hit;
    const reps = [...(repsByOutlet.get(outletId) ?? [])];
    const cells: string[] = [];
    for (const r of OUTLET_HIERARCHY_RUNGS) {
      if (missing.has(r.code)) {
        cells.push(AREA_NOT_SET, AREA_NOT_SET);
        continue;
      }
      const byKey = new Map<string, Pair>();
      for (const repId of reps) {
        const p = rungOf(repId, r.code);
        if (p) byKey.set(`${p.name}\u0000${p.id}`, p);
      }
      const pairs = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      if (!pairs.length) cells.push(AREA_NOT_SET, AREA_NOT_SET);
      else cells.push(pairs.map((p) => p.name).join(OUTLET_HIERARCHY_SEPARATOR), pairs.map((p) => p.id).join(OUTLET_HIERARCHY_SEPARATOR));
    }
    cellMemo.set(outletId, cells);
    return cells;
  }

  const L = (code: string) => labels[code];
  const notes = [
    `${L('ASM')} / ${L('SO')} / ${L('XSR')} (name and employee ID): taken from the sales hierarchy. We find every active sales rep covering the outlet (assigned to the outlet itself, to its owner, or to its parent group) and walk up each rep's reporting line to that level; a rep who is themselves at that level counts as their own. Several reps → every distinct person, separated by " | " (the n-th name goes with the n-th ID).`,
    `"Vacant (code)" = that position is vacant in the uploaded hierarchy (we show the vacant position, not the next manager up). "${AREA_NOT_SET}" = no active rep covers the outlet, or no one at that level in the reps' reporting line.`,
  ];
  if (missingRungs.length) {
    notes.push(
      `This client's sales hierarchy has no ${missingRungs.join(' / ')} level, so ${missingRungs.length === 1 ? 'that column pair reads' : 'those column pairs read'} "${AREA_NOT_SET}" on every row.`,
    );
  }

  return { headers, labels, missingRungs, cellsFor, salesUsers, levels, notes };
}

const PAGE = 2000;

/** Keyset pages (orderBy id) — keeps every read ≤ 2,000 rows. */
async function readAll<T extends { id: string }>(fetch: (page: { take: number; cursor?: { id: string }; skip?: number }) => Promise<unknown[]>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = (await fetch(cursor ? { take: PAGE, cursor: { id: cursor }, skip: 1 } : { take: PAGE })) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    cursor = rows[rows.length - 1].id;
  }
}

/** Load the tenant's hierarchy + outlet ownership (four tenant-wide reads, paged) and build the resolver. */
export async function loadOutletHierarchyResolver(prisma: AreaPrisma, clientId: string): Promise<OutletHierarchyResolver> {
  const levels = (await prisma.salesHierarchyLevel.findMany({
    where: { clientId },
    select: { code: true, name: true, level: true },
  })) as LevelRow[];
  // Soft-deleted users INCLUDED: the chain walk shows a removed manager as "Vacant (code)" and the manager filter
  // walks through them (billing-progress G3).
  const salesUsers = (await prisma.salesUser.findMany({
    where: { clientId },
    select: {
      id: true,
      userId: true,
      reportingToId: true,
      isActive: true,
      deletedAt: true,
      employeeCode: true,
      zone: true,
      hierarchyLevel: { select: { code: true } },
      user: { select: { name: true, status: true } },
    },
  })) as SalesUserRow[];
  const assignments = await readAll<AssignmentRow & { id: string }>((page) =>
    prisma.salesUserAssignment.findMany({
      where: { unassignedAt: null, salesUser: { clientId, deletedAt: null } },
      select: { id: true, salesUserId: true, outletId: true, partnerId: true },
      orderBy: { id: 'asc' },
      ...page,
    }),
  );
  const outlets = await readAll<OutletHierarchyOutlet>((page) =>
    prisma.outlet.findMany({
      where: { clientId, deletedAt: null },
      select: { id: true, partnerId: true, parentId: true },
      orderBy: { id: 'asc' },
      ...page,
    }),
  );
  return buildOutletHierarchyResolver(clientId, levels, salesUsers, assignments, outlets);
}
