/**
 * User → area (ASM · Zone · State · City) for user-level reports (owner 2026-11-20: "basic columns like ASM, Zone,
 * State so that we know which area the user belongs to"). Used by the App-installed-users Excel and the Usage Report
 * (page + Excel). Tenant-agnostic: works for every tenant; a cell is NEVER silently blank — a missing value is "Not
 * set", a not-applicable one says why — and it never throws on odd data (dangling / cyclic reporting links, missing
 * levels, blank outlet fields).
 *
 * Every column is a LIST of values (sorted, distinct). Consumers format it: the Excel files write the FULL list
 * (areaCell); the usage page shows the first AREA_MAX_VALUES with "+N more" and the full list on hover / expand.
 *
 * WHERE EACH VALUE COMES FROM (this codebase — nothing else stores area):
 *   • ASM — the sales hierarchy (SalesUser.reportingToId chain; rung = SalesHierarchyLevel.code 'ASM', the internal
 *     code shared by every tenant — Bajaj only relabels it). The header is the tenant's own name for that level
 *     (SalesHierarchyLevel.name for code ASM, else rungDisplayLabel, else "ASM").
 *       – an ASM → their own name (also when since deactivated — it is still their row);
 *       – below ASM (SO / ISR …) → walk up to the first ASM-rung manager;
 *       – above ASM (SM / ZH / NSM …) → "Above ASM level";
 *       – a VACANT ASM position above someone (placeholder / inactive / removed) → "Vacant (<employee code>)". We do NOT
 *         skip to the next active manager (the approval rule in firstActiveApproverId): this column answers "which
 *         area", that is still the vacant ASM territory, and an SM's name in an ASM column would mislead;
 *       – no ASM in the chain (reports straight to an SM, no manager, dangling link, cycle) → "Not set".
 *   • Zone / State / City — the OUTLET MASTER (Outlet.zone / .state / .city). The 18-column hierarchy upload carries
 *     only ID ("HQ") / name / phone per rung — no geography — and SalesUser.region / .zone are dormant (never written by
 *     the upload).
 *   • Retailers / wholesalers (SSS, WHOLESALER, SUB_STOCKIST) → their primary OWN outlet (isPrimary desc, createdAt asc
 *     — the same outlet the installed-users "Outlet Code" column shows). ASM = the ASM of every ACTIVE rep assigned to
 *     that outlet: directly (outletId), to its owner (partnerId), or to its parent group (partnerId = the outlet's
 *     parentId — child outlets inherit the group's rep). A rep above the ASM level → "Above ASM level — Name (level)".
 *     A group head with NO outlet of their own → "Group — N outlets" in all four columns.
 *   • Sales users → every outlet assigned to them OR to an active rep below them (same three assignment routes); a
 *     Zone typed on the employee record (SalesUser.zone) wins.
 *   • Inactive / vacant / removed reps are ignored everywhere (they no longer cover any outlet).
 *   • Admin / MIS / Gifsy / vendor logins → "Not in sales hierarchy" in all four columns.
 *
 * Cost: FOUR tenant-wide reads, sequential (one pooled connection at a time), whatever the number of rows — never one
 * query per row. Resolution is in memory.
 */
import { HIERARCHY_RUNG_CODES, rungDisplayLabel } from '../../common/hierarchy-labels';
import { HIERARCHY_MAX_HOPS } from '../../sales/sales-hierarchy-access.helper';

export const AREA_NOT_SET = 'Not set';
export const AREA_NOT_IN_HIERARCHY = 'Not in sales hierarchy';
/** Distinct values the usage PAGE shows in one cell before "+N more" (the Excel files always write the full list). */
export const AREA_MAX_VALUES = 5;

const ASM_CODE = 'ASM';
const PARTNER_ROLES = new Set(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
/** Login roles that sit above the ASM level — used for the "<N> cities" summary when the employee record has no
 *  hierarchy level (or one this tenant does not rank). The level, when known, always wins. */
const ABOVE_ASM_ROLES = new Set(['SALES_HO', 'SALES_STATE_HEAD']);

/** Excel sheet carrying the full State / City lists of the rows summarised to "<N> cities" / "<N> states". */
export const AREAS_FULL_SHEET = 'Areas (full)';
export const AREAS_FULL_HEADERS = ['User', 'Mobile', 'Role', 'State (full list)', 'City (full list)'];
/** One "Areas (full)" row, or null when the row was not summarised (its main-sheet cells are already complete). */
export function areasFullRow(name: string, phone: string, role: string, a: Pick<UserArea, 'state' | 'city' | 'stateAll' | 'cityAll'>): string[] | null {
  if (!a.cityAll && !a.stateAll) return null;
  return [name, phone, role, areaCell(a.stateAll ?? a.state), areaCell(a.cityAll ?? a.city)];
}

/** One user's area — each column a sorted, distinct, never-empty list. */
export interface UserArea {
  asm: string[];
  zone: string[];
  state: string[];
  city: string[];
  /** Set only when `city` was summarised to ["<N> cities"] (a row above the ASM level): the full list, for a tooltip. */
  cityAll?: string[];
  /** Set only when `state` was summarised to ["<N> states"] (above-ASM row with > AREA_MAX_VALUES states). */
  stateAll?: string[];
}

/**
 * Rows ABOVE the ASM level (owner 2026-11-21): a State Head / NSM / HO covers so many cities that the full list is
 * noise. City → "<N> cities" whenever they cover 2+ cities (one city / "Not set" shows as-is); State → "<N> states"
 * only when they cover more than AREA_MAX_VALUES states. Zone is unchanged. Everyone else is unchanged.
 */
export function summariseAboveAsm(area: UserArea): UserArea {
  const real = (l: string[]) => l.filter((v) => v !== AREA_NOT_SET);
  const cities = real(area.city);
  const states = real(area.state);
  const out: UserArea = { ...area };
  if (cities.length >= 2) {
    out.city = [`${cities.length} cities`];
    out.cityAll = area.city;
  }
  if (states.length > AREA_MAX_VALUES) {
    out.state = [`${states.length} states`];
    out.stateAll = area.state;
  }
  return out;
}

export interface UserAreaResolver {
  /** The ASM column header: the tenant's own name for the ASM level ("ASM" by default). */
  asmHeader: string;
  resolve(user: { id: string; role: string }): UserArea;
  /** Plain-English lines for the sheet's About / notes: [ASM, Zone/State/City, placeholder words, above-ASM counts]. */
  notes: string[];
}

// ─── Minimal read shapes (only what is selected) ─────────────────────────────────────────────────────────────────

export interface LevelRow {
  code: string;
  name: string | null;
  level: number;
}
export interface SalesUserRow {
  id: string;
  userId: string;
  reportingToId: string | null;
  isActive: boolean;
  deletedAt: Date | null;
  employeeCode: string;
  zone: string | null;
  hierarchyLevel: { code: string } | null;
  user: { name: string | null; status: string | null } | null;
}
export interface AssignmentRow {
  salesUserId: string;
  outletId: string | null;
  partnerId: string | null;
}
interface OutletRow {
  id: string;
  partnerId: string | null;
  parentId?: string | null;
  isPrimary: boolean | null;
  createdAt: Date | null;
  zone: string | null;
  state: string | null;
  city: string | null;
  partner: { userId: string | null } | null;
  parent: { userId: string | null } | null;
}

/** The prisma surface used (a structural type so tests — and a transaction client — can be passed). */
export interface AreaPrisma {
  salesHierarchyLevel: { findMany(args: unknown): Promise<unknown[]> };
  salesUser: { findMany(args: unknown): Promise<unknown[]> };
  salesUserAssignment: { findMany(args: unknown): Promise<unknown[]> };
  outlet: { findMany(args: unknown): Promise<unknown[]> };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Sorted distinct trimmed values; empty → ["Not set"]. */
export function areaValues(values: Iterable<string>): string[] {
  const list = [...new Set([...values].map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return list.length ? list : [AREA_NOT_SET];
}

/** Excel cell: the FULL list (an Excel cell holds 32k characters — nothing is dropped). */
export function areaCell(values: readonly string[] | null | undefined): string {
  const list = (values ?? []).filter(Boolean);
  return list.length ? list.join(', ') : AREA_NOT_SET;
}

export function aboveAsmLabel(asmHeader: string): string {
  return `Above ${asmHeader} level`;
}

export function groupLabel(n: number): string {
  return `Group — ${n} outlet${n === 1 ? '' : 's'}`;
}

export function areaNotes(asmHeader: string): string[] {
  const a = asmHeader;
  const above = aboveAsmLabel(a);
  return [
    `${a}: the ${a} this user reports to in the sales hierarchy; an ${a} shows their own name. Users above the ${a} level show "${above}". "Vacant (code)" = that ${a} position is vacant in the uploaded hierarchy (we show the vacant territory, not the next manager up). Retailers / wholesalers show the ${a} of each active sales rep covering their outlet (assigned to the outlet, to its owner, or to its parent group); a rep who sits above the ${a} level shows as "${above} — Name (level)". Inactive or vacant reps are ignored.`,
    `Zone / State / City: retailers / wholesalers — their main outlet in the outlet master (the outlet shown as their Outlet Code); a group head with no outlet of their own shows "Group — N outlets" in all four columns. Sales users — the outlets covered by them and by the active reps below them (a zone typed on the employee record wins). The Excel files list every value (except the counts for users above the ${a} level — see the "<N> cities" note); the page shows the first ${AREA_MAX_VALUES} and "+N more" (click to see all).`,
    `"${AREA_NOT_SET}" = the value is missing in the uploaded data (no ${a} in the reporting chain, no active rep covering the outlet, no outlet assigned, or a blank outlet field). "${AREA_NOT_IN_HIERARCHY}" = admin, MIS and Gifsy logins.`,
    `Users above the ${a} level (e.g. state / national heads, head office): City shows "<N> cities" (the number of distinct cities they cover) instead of the full list, and State shows "<N> states" when they cover more than ${AREA_MAX_VALUES} states; Zone is shown in full. Full lists: in the Excel files on the "${AREAS_FULL_SHEET}" sheet; on the page, hover the cell.`,
  ];
}

interface GeoSets {
  zones: Set<string>;
  states: Set<string>;
  cities: Set<string>;
}
const newGeo = (): GeoSets => ({ zones: new Set(), states: new Set(), cities: new Set() });
function addGeo(g: GeoSets, o: OutletRow): void {
  const z = clean(o.zone);
  const s = clean(o.state);
  const c = clean(o.city);
  if (z) g.zones.add(z);
  if (s) g.states.add(s);
  if (c) g.cities.add(c);
}
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * Rung ranks (higher = more senior): the tenant's own SalesHierarchyLevel numbers when it defines an ASM level,
 * else the canonical code order (XSR 1 … NSM 6). Shared with the outlet-hierarchy resolver.
 */
export function hierarchyRankByCode(levels: readonly LevelRow[]): Map<string, number> {
  const rankByCode = new Map<string, number>();
  HIERARCHY_RUNG_CODES.forEach((c, i) => rankByCode.set(c, i + 1));
  const ownLevels = (levels ?? []).filter((l) => l && typeof l.level === 'number' && l.level > 0);
  if (ownLevels.some((l) => clean(l.code).toUpperCase() === ASM_CODE)) {
    rankByCode.clear();
    for (const l of ownLevels) rankByCode.set(clean(l.code).toUpperCase(), l.level);
  }
  return rankByCode;
}

/** A rep who still covers outlets: not removed, not deactivated, not a vacant placeholder. */
export function isLiveSalesUser(s: Pick<SalesUserRow, 'isActive' | 'deletedAt' | 'user'>): boolean {
  return s.isActive && s.deletedAt == null && (s.user?.status == null || s.user.status === 'ACTIVE');
}

/**
 * The outlets each LIVE rep covers — the ONE assignment rule shared by every area / hierarchy column: an assignment
 * covers its outlet (outletId), every outlet its partner OWNS (partnerId = Outlet.partnerId) and every child outlet of
 * that partner's group (partnerId = Outlet.parentId). Inactive / vacant / removed reps cover nothing. `cover` is
 * called once per (rep, outlet) route (a pair may repeat — callers use sets).
 */
export function forEachCoveredOutlet<O extends { id: string; partnerId: string | null; parentId?: string | null }>(
  assignments: readonly AssignmentRow[],
  outlets: readonly O[],
  repById: (id: string) => SalesUserRow | undefined,
  cover: (rep: SalesUserRow, outlet: O) => void,
): void {
  const outletById = new Map<string, O>();
  const outletsByOwnerOrParent = new Map<string, O[]>(); // partner id → its own outlets + its group's children
  for (const o of outlets) {
    if (o.id) outletById.set(o.id, o);
    if (o.partnerId) pushTo(outletsByOwnerOrParent, o.partnerId, o);
    if (o.parentId && o.parentId !== o.partnerId) pushTo(outletsByOwnerOrParent, o.parentId, o);
  }
  for (const a of assignments ?? []) {
    if (!a?.salesUserId) continue;
    const rep = repById(a.salesUserId);
    if (!rep || !isLiveSalesUser(rep)) continue; // an inactive / vacant / removed rep covers nothing
    if (a.outletId) {
      const o = outletById.get(a.outletId);
      if (o) cover(rep, o);
    }
    if (a.partnerId) for (const o of outletsByOwnerOrParent.get(a.partnerId) ?? []) cover(rep, o);
  }
}

/** Build the resolver from already-loaded rows (pure — unit-testable without a DB). */
export function buildUserAreaResolver(
  clientId: string,
  levels: LevelRow[],
  salesUsers: SalesUserRow[],
  assignments: AssignmentRow[],
  outlets: OutletRow[],
): UserAreaResolver {
  levels = (levels ?? []).filter(Boolean);
  outlets = (outlets ?? []).filter(Boolean);

  // ── rung ranks: the tenant's own level numbers, else the canonical code order ──
  const rankByCode = hierarchyRankByCode(levels);
  const asmRank = rankByCode.get(ASM_CODE) ?? 3;
  const levelNameByCode = new Map<string, string>();
  for (const l of levels) {
    const n = clean(l.name);
    if (n) levelNameByCode.set(clean(l.code).toUpperCase(), n);
  }
  const levelName = (code: string) => levelNameByCode.get(code) || clean(rungDisplayLabel(clientId, code)) || code;
  const asmHeader = levelNameByCode.get(ASM_CODE) || clean(rungDisplayLabel(clientId, ASM_CODE)) || 'ASM';
  const ABOVE = aboveAsmLabel(asmHeader);

  const suById = new Map<string, SalesUserRow>();
  const suByUserId = new Map<string, SalesUserRow>();
  for (const s of salesUsers ?? []) {
    if (!s?.id) continue;
    suById.set(s.id, s);
    // A login owns one SalesUser (userId @unique); prefer the live one if an odd read returns two.
    const prev = suByUserId.get(s.userId);
    if (!prev || (prev.deletedAt && !s.deletedAt)) suByUserId.set(s.userId, s);
  }
  const codeOf = (s: SalesUserRow) => clean(s.hierarchyLevel?.code).toUpperCase();
  const rankOf = (s: SalesUserRow) => rankByCode.get(codeOf(s));
  const isAbove = (s: SalesUserRow) => {
    const r = rankOf(s);
    return r !== undefined && r > asmRank;
  };
  const isLive = isLiveSalesUser;
  const ownName = (s: SalesUserRow) => clean(s.user?.name) || AREA_NOT_SET;

  // ── the ASM ABOVE a sales user (memoised): ASM name / "Vacant (code)" / "Not set" ──
  const chainMemo = new Map<string, string>();
  function asmAbove(s: SalesUserRow): string {
    const hit = chainMemo.get(s.id);
    if (hit !== undefined) return hit;
    let out = AREA_NOT_SET;
    const seen = new Set<string>([s.id]);
    let cur = s.reportingToId;
    for (let hops = 0; cur && hops < HIERARCHY_MAX_HOPS; hops++) {
      if (seen.has(cur)) break; // cycle guard
      seen.add(cur);
      const m = suById.get(cur);
      if (!m) break; // dangling link
      if (codeOf(m) === ASM_CODE) {
        out = isLive(m) ? ownName(m) : `Vacant (${m.employeeCode})`;
        break;
      }
      if (isAbove(m)) break; // passed the ASM level without meeting one
      cur = m.reportingToId;
    }
    chainMemo.set(s.id, out);
    return out;
  }
  /** A sales user's OWN row: own name (ASM, even if deactivated) / "Above ASM level" / the chain. */
  const asmForSelf = (s: SalesUserRow): string =>
    codeOf(s) === ASM_CODE ? ownName(s) : isAbove(s) ? ABOVE : asmAbove(s);
  /** A rep covering a retailer's outlet. */
  const asmForRep = (s: SalesUserRow): string =>
    codeOf(s) === ASM_CODE
      ? ownName(s)
      : isAbove(s)
        ? `${ABOVE} — ${ownName(s)} (${levelName(codeOf(s))})`
        : asmAbove(s);

  // ── outlets covered by each LIVE rep: outlet-level, owner-level, and parent-group-level assignments ──
  const repsByOutlet = new Map<string, Set<string>>(); // outlet id → live sales user ids
  const geoOwn = new Map<string, GeoSets>(); // live sales user id → geo of the outlets they cover directly
  const cover = (suId: string, o: OutletRow) => {
    if (o.id) {
      const set = repsByOutlet.get(o.id) ?? new Set<string>();
      set.add(suId);
      repsByOutlet.set(o.id, set);
    }
    const g = geoOwn.get(suId) ?? newGeo();
    addGeo(g, o);
    geoOwn.set(suId, g);
  };
  forEachCoveredOutlet(assignments ?? [], outlets, (id) => suById.get(id), (rep, o) => cover(rep.id, o));

  // ── downline geo: each rep's outlets count for the rep and every manager above them ──
  const geoAll = new Map<string, GeoSets>();
  for (const [suId, g] of geoOwn) {
    const seen = new Set<string>();
    let cur: string | null = suId;
    for (let hops = 0; cur && hops <= HIERARCHY_MAX_HOPS; hops++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const target = geoAll.get(cur) ?? newGeo();
      geoAll.set(cur, target);
      for (const z of g.zones) target.zones.add(z);
      for (const s of g.states) target.states.add(s);
      for (const c of g.cities) target.cities.add(c);
      cur = suById.get(cur)?.reportingToId ?? null;
    }
  }

  // ── partner login → primary OWN outlet (same order as the installed-users Outlet Code), else group size ──
  const byPrimary = (a: OutletRow, b: OutletRow) =>
    Number(!!b.isPrimary) - Number(!!a.isPrimary) ||
    (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0) ||
    clean(a.id).localeCompare(clean(b.id));
  const ownOutlets = new Map<string, OutletRow[]>();
  const groupOutlets = new Map<string, OutletRow[]>();
  for (const o of outlets) {
    const owner = o.partner?.userId;
    if (owner) pushTo(ownOutlets, owner, o);
    const head = o.parent?.userId;
    if (head && head !== owner) pushTo(groupOutlets, head, o);
  }

  const fill = (v: string): UserArea => ({ asm: [v], zone: [v], state: [v], city: [v] });

  function resolve(user: { id: string; role: string }): UserArea {
    const role = String(user?.role ?? '');
    const su = user?.id ? suByUserId.get(user.id) : undefined;
    if (su) {
      const g = geoAll.get(su.id) ?? newGeo();
      const ownZone = clean(su.zone);
      const area: UserArea = {
        asm: [asmForSelf(su)],
        zone: ownZone ? [ownZone] : areaValues(g.zones),
        state: areaValues(g.states),
        city: areaValues(g.cities),
      };
      // Above ASM by level; with no / an unranked level, by login role (SALES_HO / SALES_STATE_HEAD).
      const above = isAbove(su) || (rankOf(su) === undefined && ABOVE_ASM_ROLES.has(role));
      return above ? summariseAboveAsm(area) : area;
    }
    if (role.startsWith('SALES_')) return fill(AREA_NOT_SET); // a sales login with no employee record
    if (PARTNER_ROLES.has(role)) {
      const own = ownOutlets.get(user.id) ?? [];
      if (!own.length) {
        const group = groupOutlets.get(user.id) ?? [];
        return fill(group.length ? groupLabel(group.length) : AREA_NOT_SET);
      }
      const o = [...own].sort(byPrimary)[0];
      const asms = new Set<string>();
      for (const repId of o.id ? repsByOutlet.get(o.id) ?? [] : []) {
        const rep = suById.get(repId);
        const v = rep ? asmForRep(rep) : '';
        if (v && v !== AREA_NOT_SET) asms.add(v);
      }
      return {
        asm: areaValues(asms),
        zone: areaValues([clean(o.zone)]),
        state: areaValues([clean(o.state)]),
        city: areaValues([clean(o.city)]),
      };
    }
    return fill(AREA_NOT_IN_HIERARCHY);
  }

  return { asmHeader, resolve, notes: areaNotes(asmHeader) };
}

/** Load the tenant's hierarchy + outlet geography (4 reads, sequential) and build the resolver. */
export async function loadUserAreaResolver(prisma: AreaPrisma, clientId: string): Promise<UserAreaResolver> {
  const levels = (await prisma.salesHierarchyLevel.findMany({
    where: { clientId },
    select: { code: true, name: true, level: true },
  })) as LevelRow[];
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
  const assignments = (await prisma.salesUserAssignment.findMany({
    where: { unassignedAt: null, salesUser: { clientId, deletedAt: null } },
    select: { salesUserId: true, outletId: true, partnerId: true },
  })) as AssignmentRow[];
  const outlets = (await prisma.outlet.findMany({
    where: { clientId, deletedAt: null },
    select: {
      id: true,
      partnerId: true,
      parentId: true,
      isPrimary: true,
      createdAt: true,
      zone: true,
      state: true,
      city: true,
      partner: { select: { userId: true } },
      parent: { select: { userId: true } },
    },
  })) as OutletRow[];
  return buildUserAreaResolver(clientId, levels, salesUsers, assignments, outlets);
}

// ─── Per-tenant cache (usage page: sorting / filtering / paging must not reload the whole hierarchy) ─────────────

export const USER_AREA_CACHE_TTL_MS = 60_000;
const areaCache = new Map<string, { at: number; value: Promise<UserAreaResolver> }>();

/**
 * The tenant's resolver, built at most once per USER_AREA_CACHE_TTL_MS (keyed by clientId). Concurrent callers share
 * one in-flight load; a failed load is never cached. Area data changes only on hierarchy / outlet uploads, so a
 * minute of staleness is harmless.
 */
export function cachedUserAreaResolver(
  clientId: string,
  load: () => Promise<UserAreaResolver>,
  now: number = Date.now(),
): Promise<UserAreaResolver> {
  const hit = areaCache.get(clientId);
  if (hit && now - hit.at < USER_AREA_CACHE_TTL_MS) return hit.value;
  const value = load();
  areaCache.set(clientId, { at: now, value });
  value.catch(() => {
    if (areaCache.get(clientId)?.value === value) areaCache.delete(clientId);
  });
  return value;
}

/** Tests only. */
export function clearUserAreaCache(): void {
  areaCache.clear();
}
