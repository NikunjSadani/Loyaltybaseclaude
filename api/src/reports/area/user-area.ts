/**
 * User → area (ASM · Zone · State · City) for user-level reports (owner 2026-11-20: "basic columns like ASM, Zone,
 * State so that we know which area the user belongs to"). Used by the App-installed-users Excel and the Usage Report
 * (page + Excel). Tenant-agnostic: works for every tenant; a missing value is written as "Not set", never blank-by-
 * accident, and never throws on odd data (dangling / cyclic reporting links, missing levels, blank outlet fields).
 *
 * WHERE EACH VALUE COMES FROM (this codebase — nothing else stores area):
 *   • ASM — the sales hierarchy (SalesUser.reportingToId chain; rung = SalesHierarchyLevel.code 'ASM', the internal
 *     code shared by every tenant — Bajaj only relabels it). The column header is the tenant's own name for that
 *     level (SalesHierarchyLevel.name for code ASM, else rungDisplayLabel, else "ASM").
 *       – an ASM → their own name;
 *       – below ASM (SO / ISR …) → walk up to the first ASM-rung manager;
 *       – above ASM (SM / ZH / NSM …) → blank (explained in the notes);
 *       – a VACANT ASM position (placeholder / inactive / removed) → "Vacant (<employee code>)". We deliberately do NOT
 *         skip to the next active manager (the approval rule in firstActiveApproverId): this column answers "which
 *         area", the area is still that ASM territory, and putting an SM's name in an ASM column would mislead;
 *       – no ASM in the chain (reports straight to an SM, no manager, dangling link) → "Not set".
 *   • Zone / State / City — the OUTLET MASTER (Outlet.zone / .state / .city). The 18-column hierarchy upload carries
 *     only ID ("HQ") / name / phone per rung — no geography — and SalesUser.region / .zone are dormant (never written by
 *     the upload). So:
 *       – retailers / wholesalers (SSS, WHOLESALER, SUB_STOCKIST) → their primary outlet (own outlets first, else the
 *         group they head), ASM = the ASM of the sales rep(s) assigned to that outlet (or to its owner);
 *       – sales users → every outlet assigned to them OR to anyone below them (SalesUserAssignment, outlet- or partner-
 *         level); a Zone typed on the employee record (SalesUser.zone) wins. More than AREA_MAX_VALUES distinct values
 *         are shortened to "A, B, C, D, E +N more".
 *   • Admin / MIS / Gifsy / vendor logins → "Not in sales hierarchy" in all four columns.
 *
 * Cost: FOUR tenant-wide reads, sequential (one pooled connection at a time), whatever the number of rows — never one
 * query per row. Resolution is in memory.
 */
import { HIERARCHY_RUNG_CODES, rungDisplayLabel } from '../../common/hierarchy-labels';
import { HIERARCHY_MAX_HOPS } from '../../sales/sales-hierarchy-access.helper';

export const AREA_NOT_SET = 'Not set';
export const AREA_NOT_IN_HIERARCHY = 'Not in sales hierarchy';
/** Distinct zones / states / cities listed in one cell before "+N more". */
export const AREA_MAX_VALUES = 5;

const ASM_CODE = 'ASM';
const PARTNER_ROLES = new Set(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);

export interface UserArea {
  asm: string;
  zone: string;
  state: string;
  city: string;
}

export interface UserAreaResolver {
  /** The ASM column header: the tenant's own name for the ASM level ("ASM" by default). */
  asmHeader: string;
  resolve(user: { id: string; role: string }): UserArea;
  /** Plain-English lines for the sheet's About / notes. */
  notes: string[];
}

// ─── Minimal read shapes (only what is selected) ─────────────────────────────────────────────────────────────────

interface LevelRow {
  code: string;
  name: string | null;
  level: number;
}
interface SalesUserRow {
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
interface AssignmentRow {
  salesUserId: string;
  outletId: string | null;
  partnerId: string | null;
}
interface OutletRow {
  id: string;
  partnerId: string | null;
  isPrimary: boolean | null;
  createdAt: Date | null;
  zone: string | null;
  state: string | null;
  city: string | null;
  partner: { userId: string | null } | null;
  parent: { userId: string | null } | null;
}

/** The prisma surface used (a structural type so tests can pass a fake). */
export interface AreaPrisma {
  salesHierarchyLevel: { findMany(args: unknown): Promise<unknown[]> };
  salesUser: { findMany(args: unknown): Promise<unknown[]> };
  salesUserAssignment: { findMany(args: unknown): Promise<unknown[]> };
  outlet: { findMany(args: unknown): Promise<unknown[]> };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Sorted distinct values → one cell; capped at AREA_MAX_VALUES; empty → "Not set". */
export function formatAreaValues(values: Iterable<string>): string {
  const list = [...new Set([...values].map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!list.length) return AREA_NOT_SET;
  if (list.length <= AREA_MAX_VALUES) return list.join(', ');
  return `${list.slice(0, AREA_MAX_VALUES).join(', ')} +${list.length - AREA_MAX_VALUES} more`;
}

export function areaNotes(asmHeader: string): string[] {
  const a = asmHeader;
  return [
    `${a}: the ${a} this user reports to in the sales hierarchy; an ${a} shows their own name. Users ABOVE the ${a} level are left blank (no ${a} sits above them). "Vacant (code)" = that ${a} position is vacant in the uploaded hierarchy (we show the vacant territory, not the next manager up). Retailers / wholesalers show the ${a} of the sales rep assigned to their outlet.`,
    'Zone / State / City: retailers / wholesalers — their main outlet in the outlet master. Sales users — the outlets assigned to them and to everyone below them (a zone typed on the employee record wins). More than 5 different values are shortened to "… +N more".',
    `"${AREA_NOT_SET}" = the value is missing in the uploaded data (no ${a} in the reporting chain, no outlet assigned, or a blank outlet field). "${AREA_NOT_IN_HIERARCHY}" = admin, MIS and Gifsy logins.`,
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

/** Build the resolver from already-loaded rows (pure — unit-testable without a DB). */
export function buildUserAreaResolver(
  clientId: string,
  levels: LevelRow[],
  salesUsers: SalesUserRow[],
  assignments: AssignmentRow[],
  outlets: OutletRow[],
): UserAreaResolver {
  // ── rung ranks: the tenant's own level numbers, else the canonical code order ──
  const rankByCode = new Map<string, number>();
  HIERARCHY_RUNG_CODES.forEach((c, i) => rankByCode.set(c, i + 1));
  const ownLevels = levels.filter((l) => typeof l.level === 'number' && l.level > 0);
  if (ownLevels.some((l) => clean(l.code).toUpperCase() === ASM_CODE)) {
    rankByCode.clear();
    for (const l of ownLevels) rankByCode.set(clean(l.code).toUpperCase(), l.level);
  }
  const asmRank = rankByCode.get(ASM_CODE) ?? 3;
  const asmLevelName = clean(levels.find((l) => clean(l.code).toUpperCase() === ASM_CODE)?.name);
  const asmHeader = asmLevelName || clean(rungDisplayLabel(clientId, ASM_CODE)) || 'ASM';

  const suById = new Map<string, SalesUserRow>();
  const suByUserId = new Map<string, SalesUserRow>();
  for (const s of salesUsers) {
    if (!s?.id) continue;
    suById.set(s.id, s);
    // A login can only own one SalesUser (userId @unique); prefer the live one if a fake/odd read returns two.
    const prev = suByUserId.get(s.userId);
    if (!prev || (prev.deletedAt && !s.deletedAt)) suByUserId.set(s.userId, s);
  }
  const codeOf = (s: SalesUserRow) => clean(s.hierarchyLevel?.code).toUpperCase();
  const rankOf = (s: SalesUserRow) => rankByCode.get(codeOf(s));
  const isVacant = (s: SalesUserRow) =>
    !s.isActive || s.deletedAt != null || (s.user?.status != null && s.user.status !== 'ACTIVE');
  const asmLabel = (s: SalesUserRow) => (isVacant(s) ? `Vacant (${s.employeeCode})` : clean(s.user?.name) || AREA_NOT_SET);

  // ── ASM per sales user (memoised; '' = above ASM) ──
  const asmMemo = new Map<string, string>();
  function asmFor(s: SalesUserRow): string {
    const hit = asmMemo.get(s.id);
    if (hit !== undefined) return hit;
    let out: string;
    const r = rankOf(s);
    if (codeOf(s) === ASM_CODE) out = asmLabel(s);
    else if (r !== undefined && r > asmRank) out = '';
    else {
      out = AREA_NOT_SET;
      const seen = new Set<string>([s.id]);
      let cur = s.reportingToId;
      for (let hops = 0; cur && hops < HIERARCHY_MAX_HOPS; hops++) {
        if (seen.has(cur)) break; // cycle guard
        seen.add(cur);
        const m = suById.get(cur);
        if (!m) break; // dangling link
        if (codeOf(m) === ASM_CODE) {
          out = asmLabel(m);
          break;
        }
        const mr = rankOf(m);
        if (mr !== undefined && mr > asmRank) break; // passed the ASM level without meeting one
        cur = m.reportingToId;
      }
    }
    asmMemo.set(s.id, out);
    return out;
  }

  // ── outlets → assigned reps (outlet-level and owner-level assignments) ──
  const outletsByPartner = new Map<string, OutletRow[]>();
  for (const o of outlets) {
    if (!o?.partnerId) continue;
    (outletsByPartner.get(o.partnerId) ?? outletsByPartner.set(o.partnerId, []).get(o.partnerId)!).push(o);
  }
  const outletById = new Map<string, OutletRow>();
  for (const o of outlets) if (o?.id) outletById.set(o.id, o);
  const repsByOutlet = new Map<string, Set<string>>(); // outlet id → sales user ids
  const geoOwn = new Map<string, GeoSets>(); // sales user id → geo of outlets assigned directly
  const link = (suId: string, o: OutletRow) => {
    const su = suById.get(suId);
    if (!su || su.deletedAt) return; // a removed rep is no longer anyone's rep
    if (o.id) (repsByOutlet.get(o.id) ?? repsByOutlet.set(o.id, new Set()).get(o.id)!).add(suId);
    addGeo(geoOwn.get(suId) ?? geoOwn.set(suId, newGeo()).get(suId)!, o);
  };
  for (const a of assignments) {
    if (!a?.salesUserId) continue;
    if (a.outletId) {
      const o = outletById.get(a.outletId);
      if (o) link(a.salesUserId, o);
    }
    if (a.partnerId) for (const o of outletsByPartner.get(a.partnerId) ?? []) link(a.salesUserId, o);
  }

  // ── downline geo: each rep's outlets count for the rep and every manager above them ──
  const geoAll = new Map<string, GeoSets>();
  for (const [suId, g] of geoOwn) {
    const seen = new Set<string>();
    let cur: string | null = suId;
    for (let hops = 0; cur && hops <= HIERARCHY_MAX_HOPS; hops++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const target = geoAll.get(cur) ?? geoAll.set(cur, newGeo()).get(cur)!;
      for (const z of g.zones) target.zones.add(z);
      for (const s of g.states) target.states.add(s);
      for (const c of g.cities) target.cities.add(c);
      cur = suById.get(cur)?.reportingToId ?? null;
    }
  }

  // ── partner login → primary outlet (own outlets first, else the group they head) ──
  const byPrimary = (a: OutletRow, b: OutletRow) =>
    Number(!!b.isPrimary) - Number(!!a.isPrimary) ||
    (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0) ||
    clean(a.id).localeCompare(clean(b.id));
  const ownOutlets = new Map<string, OutletRow[]>();
  const groupOutlets = new Map<string, OutletRow[]>();
  for (const o of outlets) {
    const owner = o?.partner?.userId;
    if (owner) (ownOutlets.get(owner) ?? ownOutlets.set(owner, []).get(owner)!).push(o);
    const head = o?.parent?.userId;
    if (head && head !== owner) (groupOutlets.get(head) ?? groupOutlets.set(head, []).get(head)!).push(o);
  }
  const primaryOutlet = (userId: string): OutletRow | undefined => {
    const list = ownOutlets.get(userId)?.length ? ownOutlets.get(userId)! : groupOutlets.get(userId) ?? [];
    return [...list].sort(byPrimary)[0];
  };

  const notSet: UserArea = { asm: AREA_NOT_SET, zone: AREA_NOT_SET, state: AREA_NOT_SET, city: AREA_NOT_SET };
  const outside: UserArea = {
    asm: AREA_NOT_IN_HIERARCHY,
    zone: AREA_NOT_IN_HIERARCHY,
    state: AREA_NOT_IN_HIERARCHY,
    city: AREA_NOT_IN_HIERARCHY,
  };

  function resolve(user: { id: string; role: string }): UserArea {
    const role = String(user?.role ?? '');
    const su = user?.id ? suByUserId.get(user.id) : undefined;
    if (su) {
      const g = geoAll.get(su.id) ?? newGeo();
      const ownZone = clean(su.zone);
      return {
        asm: asmFor(su),
        zone: ownZone || formatAreaValues(g.zones),
        state: formatAreaValues(g.states),
        city: formatAreaValues(g.cities),
      };
    }
    if (role.startsWith('SALES_')) return { ...notSet }; // a sales login with no employee record
    if (PARTNER_ROLES.has(role)) {
      const o = primaryOutlet(user.id);
      if (!o) return { ...notSet };
      const asms = new Set<string>();
      for (const repId of o.id ? repsByOutlet.get(o.id) ?? [] : []) {
        const rep = suById.get(repId);
        const v = rep ? asmFor(rep) : '';
        if (v && v !== AREA_NOT_SET) asms.add(v);
      }
      return {
        asm: asms.size ? [...asms].sort((a, b) => a.localeCompare(b)).join(', ') : AREA_NOT_SET,
        zone: clean(o.zone) || AREA_NOT_SET,
        state: clean(o.state) || AREA_NOT_SET,
        city: clean(o.city) || AREA_NOT_SET,
      };
    }
    return { ...outside };
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
