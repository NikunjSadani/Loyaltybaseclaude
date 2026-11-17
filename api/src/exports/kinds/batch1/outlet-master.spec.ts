/**
 * Outlet Master export kind (`outlet-master`) — PARITY with the old in-memory builder (ReportsService.outletMaster,
 * copied below verbatim as `oldOutletMaster`), plus the behaviours the old reports-outlet-master spec pinned, tenant
 * isolation, paging across 2,000-row pages, the over-fetch fix (query shapes), cellSafe and the signed links.
 *
 * Both builders read the SAME in-memory fake database (FakeDb) through the Prisma calls each one makes.
 */
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OutletKycIntent, Prisma } from '@prisma/client';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { buildXlsx } from '../../../common/xlsx';
import { istDateKey } from '../../../common/ist-date';
import { isKycInFlight, isReKycPending } from '../../../common/kyc-rekyc.helper';
import { rungIdHeader, rungNameHeader, rungPhoneHeader } from '../../../common/hierarchy-labels';
import { mintDocViewToken } from '../../../kyc/doc-view-token';
import { OUTLET_MASTER_KIND, profileStatus, salesApproverHistoryRow as liveSalesApproverHistoryRow } from './outlet-master';
import { expectSameWorkbook, fakeModuleRef, readBack, runKindToBuffer, seeded } from './parity-testkit-spec';

// ─── Fake database ─────────────────────────────────────────────────────────────────────────────────────────

interface SalesUserRec {
  id: string;
  clientId: string;
  userId: string;
  employeeCode: string;
  reportingToId: string | null;
  levelCode: string | null;
  name: string | null;
  phone: string | null;
}
interface SubRec {
  id: string;
  partnerId: string | null;
  userId: string;
  status: string;
  submittedAt: Date | null;
  createdAt: Date;
  approvedAt: Date | null;
  rejectionReason: string | null;
  reviewerNotes: string | null;
  boardPhotoLat: Prisma.Decimal | null;
  boardPhotoLng: Prisma.Decimal | null;
  paymentLat: Prisma.Decimal | null;
  paymentLng: Prisma.Decimal | null;
  documents: { id: string; documentType: string; createdAt: Date }[];
  statusHistory: { id: string; toStatus: string; changedByUserId: string | null; createdAt: Date; metadata: Prisma.JsonValue }[];
}
interface OutletRec {
  id: string;
  clientId: string;
  deletedAt: Date | null;
  partnerId: string | null;
  outletCode: string;
  [k: string]: unknown;
}
interface FakeData {
  features: Record<string, Record<string, unknown>>;
  typeConfigs: { clientId: string; displayName: string | null; outletType: { code: string } }[];
  outlets: OutletRec[];
  salesUsers: SalesUserRec[];
  assignments: { id: string; outletId: string; salesUserId: string; assignedAt: Date; unassignedAt: Date | null }[];
  submissions: SubRec[];
  users: { id: string; clientId: string; name: string | null; phone: string | null }[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Minimal Prisma stand-in answering exactly the calls the old builder and the kind make. Records every call. */
function fakePrisma(db: FakeData) {
  const calls: Record<string, unknown[]> = {};
  const log = (k: string, a: unknown) => (calls[k] ??= []).push(a);
  const suById = new Map(db.salesUsers.map((s) => [s.id, s]));
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const chainNode = (id: string | null, depth: number): unknown => {
    const su = id ? suById.get(id) : undefined;
    if (!su || depth <= 0) return null;
    return {
      employeeCode: su.employeeCode,
      hierarchyLevel: su.levelCode ? { code: su.levelCode } : null,
      user: { name: su.name, phone: su.phone },
      ...(depth > 1 ? { reportingTo: chainNode(su.reportingToId, depth - 1) } : {}),
    };
  };
  const subOut = (s: SubRec, opts: { docTypes?: string[]; histTypes?: string[] }) => {
    const u = userById.get(s.userId);
    const docs = s.documents
      .filter((d) => !opts.docTypes || opts.docTypes.includes(d.documentType))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || cmp(b.id, a.id))
      .map((d) => ({ id: d.id, documentType: d.documentType, createdAt: d.createdAt }));
    const hist = s.statusHistory
      .filter((h) => !opts.histTypes || opts.histTypes.includes(h.toStatus))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.id, b.id))
      .map(({ toStatus, changedByUserId, createdAt, metadata }) => ({ toStatus, changedByUserId, createdAt, metadata }));
    const { documents: _d, statusHistory: _h, userId: _u, ...scalars } = s;
    return { ...scalars, user: u ? { id: u.id, name: u.name, phone: u.phone } : null, documents: docs, statusHistory: hist };
  };

  return {
    calls,
    client: {
      findUnique: async (a: { where: { id: string } }) => {
        log('client.findUnique', a);
        return { features: db.features[a.where.id] ?? {} };
      },
    },
    outletTypeClientConfig: {
      findMany: async (a: { where: { clientId: string } }) => {
        log('outletTypeClientConfig.findMany', a);
        return db.typeConfigs.filter((t) => t.clientId === a.where.clientId && t.displayName !== null);
      },
    },
    outlet: {
      findMany: async (a: { where: Record<string, unknown>; take?: number }) => {
        log('outlet.findMany', a);
        const w = a.where as { clientId: string; OR?: Array<Record<string, unknown>> };
        let rows = db.outlets.filter((o) => o.clientId === w.clientId && o.deletedAt === null);
        if (w.OR) {
          const gt = (w.OR[0].outletCode as { gt: string }).gt;
          const eqCode = w.OR[1].outletCode as string;
          const gtId = (w.OR[1].id as { gt: string }).gt;
          rows = rows.filter((o) => o.outletCode > gt || (o.outletCode === eqCode && o.id > gtId));
        }
        rows = [...rows].sort((x, y) => cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id));
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map(({ clientId: _c, deletedAt: _d, ...rest }) => rest);
      },
    },
    salesUserAssignment: {
      findMany: async (a: { where: { outletId: { in: string[] } } }) => {
        log('salesUserAssignment.findMany', a);
        const ids = new Set(a.where.outletId.in);
        return db.assignments
          .filter((x) => ids.has(x.outletId) && x.unassignedAt === null)
          .sort((x, y) => y.assignedAt.getTime() - x.assignedAt.getTime() || cmp(y.id, x.id))
          .map((x) => ({ outletId: x.outletId, assignedAt: x.assignedAt, salesUserId: x.salesUserId, salesUser: chainNode(x.salesUserId, 8) }));
      },
    },
    kycSubmission: {
      findMany: async (a: { where: Record<string, unknown>; select: Record<string, { where?: Record<string, { in: string[] }> }> }) => {
        log('kycSubmission.findMany', a);
        const w = a.where as { id?: { in: string[] }; partnerId?: { in: string[] }; user?: { clientId: string } };
        const opts = {
          docTypes: a.select.documents?.where?.documentType?.in,
          histTypes: a.select.statusHistory?.where?.toStatus?.in,
        };
        if (w.id) {
          const ids = new Set(w.id.in);
          return db.submissions.filter((s) => ids.has(s.id)).map((s) => subOut(s, opts));
        }
        const pids = new Set(w.partnerId!.in);
        return db.submissions
          .filter((s) => s.partnerId && pids.has(s.partnerId) && userById.get(s.userId)?.clientId === w.user!.clientId)
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
          .map((s) => subOut(s, opts));
      },
    },
    salesUser: {
      findMany: async (a: { where: { id?: { in: string[] }; userId?: { in: string[] }; clientId?: string } }) => {
        log('salesUser.findMany', a);
        if (a.where.id) {
          const ids = new Set(a.where.id.in);
          return db.salesUsers
            .filter((s) => ids.has(s.id))
            .map((s) => ({
              id: s.id,
              employeeCode: s.employeeCode,
              reportingToId: s.reportingToId,
              hierarchyLevel: s.levelCode ? { code: s.levelCode } : null,
              user: { name: s.name, phone: s.phone },
            }));
        }
        const uids = new Set(a.where.userId!.in);
        return db.salesUsers
          .filter((s) => uids.has(s.userId) && s.clientId === a.where.clientId)
          .map((s) => ({ userId: s.userId, employeeCode: s.employeeCode, user: { name: s.name, phone: s.phone } }));
      },
    },
    $queryRaw: async (sql: Prisma.Sql) => {
      log('$queryRaw', sql);
      expect(sql.sql).toContain('DISTINCT ON');
      const [clientId, ...partnerIds] = sql.values as string[];
      const pids = new Set(partnerIds);
      const latest = new Map<string, SubRec>();
      for (const s of db.submissions) {
        if (!s.partnerId || !pids.has(s.partnerId) || userById.get(s.userId)?.clientId !== clientId) continue;
        const cur = latest.get(s.partnerId);
        if (!cur || s.createdAt > cur.createdAt || (+s.createdAt === +cur.createdAt && s.id > cur.id)) latest.set(s.partnerId, s);
      }
      return [...latest.values()].map((s) => ({ id: s.id }));
    },
  };
}

// ─── The OLD builder, verbatim (ReportsService.outletMaster before 2026-11-13), as the parity reference ──────

const RUNGS = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'] as const;
type Rung = (typeof RUNGS)[number];
interface AssignmentSalesUser {
  employeeCode: string;
  hierarchyLevel?: { code: string } | null;
  user?: { name: string | null; phone: string | null } | null;
  reportingTo?: AssignmentSalesUser | null;
}
const decToStr = (d: Prisma.Decimal | null | undefined): string => (d == null ? '' : d.toString());
const dateOnly = (d: Date | null | undefined): string => (d ? istDateKey(new Date(d)) : '');
function oldHeaders(geoEnabled: boolean, clientId: string): string[] {
  const base = [
    'Outlet Code', 'Outlet Name', 'Program Name', 'Sub-Program', 'Outlet Type',
    'Beat', 'Distributor Code', 'Distributor Name', 'Metro', 'City', 'State', 'Zone',
    ...RUNGS.flatMap((r) => [rungIdHeader(clientId, r), rungNameHeader(clientId, r), rungPhoneHeader(clientId, r)]),
    'Parent ID',
    'Owner Name', 'Phone Number', 'Address', 'Pincode',
    'Latitude of Outlet Board', 'Longitude of Outlet Board',
    'Enrollment by Employee ID', 'Enrollment by Employee Name', 'Enrollment by Employee Phone Number',
    'Enrollment Date', 'Enrollment Status', 'Profile Status',
    'Approval by Employee ID', 'Approval by Employee Name', 'Approval by Employee Phone Number',
    'Approval by Gifsy', 'Approval Date of Gifsy',
    'Latitude of Bank Details Collection', 'Longitude of Bank Details Collection',
    'Remarks', 'GST', 'PAN', 'GST Certificate', 'Address Proof', 'Self-Declaration', 'Deactivated At',
  ];
  if (!geoEnabled) return base;
  const h = [...base];
  const at = h.indexOf('Metro');
  h.splice(at >= 0 ? at + 1 : h.length, 0, 'Latitude', 'Longitude');
  return h;
}
function oldProfileStatus(
  outlet: { deactivatedAt: Date | null; kycIntent: OutletKycIntent | null; reKycFlags: Prisma.JsonValue | null },
  latest: string | undefined,
): string {
  if (outlet.deactivatedAt) return 'Deactivated';
  if (outlet.kycIntent === OutletKycIntent.PARKED) return 'Parked';
  if (outlet.kycIntent === OutletKycIntent.NOT_INTERESTED) return 'Not Interested';
  if (isReKycPending(outlet.reKycFlags) && !isKycInFlight(latest)) return 'Re-KYC Required';
  switch (latest) {
    case 'APPROVED': return 'Approved';
    case 'REJECTED': return 'Rejected';
    case 'RE_KYC_REQUIRED': return 'Re-KYC Required';
    case 'RE_UPLOAD_REQUIRED':
    case 'RESUBMISSION_REQUIRED': return 'Resubmission Required';
    case 'PENDING_ASM_APPROVAL': return 'Awaiting ASM Approval';
    case 'PENDING_RSM_APPROVAL': return 'Awaiting RSM Approval';
    case 'PENDING_GIFSY': return 'Awaiting Gifsy Approval';
    case 'SUSPENDED': return 'Suspended';
    case 'PENDING_SO_APPROVAL':
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
    case 'PENDING_PENNY_DROP':
    case 'PENDING_AGREEMENT': return 'Awaiting SO Approval';
    default: return 'KYC Pending';
  }
}
function salesUserChainSelect(): Prisma.SalesUserSelect {
  const node: Prisma.SalesUserSelect = { employeeCode: true, hierarchyLevel: { select: { code: true } }, user: { select: { name: true, phone: true } } };
  let cur: Prisma.SalesUserSelect = { ...node };
  for (let i = 0; i < 7; i++) cur = { ...node, reportingTo: { select: cur } };
  return cur;
}
function resolveRungs(start?: AssignmentSalesUser): Record<Rung, AssignmentSalesUser | undefined> {
  const out: Record<Rung, AssignmentSalesUser | undefined> = { XSR: undefined, SO: undefined, ASM: undefined, RSM: undefined, ZNM: undefined, NSM: undefined };
  let cur: AssignmentSalesUser | undefined | null = start;
  let guard = 0;
  while (cur && guard++ < 20) {
    const code = cur.hierarchyLevel?.code as Rung | undefined;
    if (code && code in out && !out[code]) out[code] = cur;
    cur = cur.reportingTo ?? undefined;
  }
  return out;
}
const stageOf = (m: Prisma.JsonValue | null): string | undefined =>
  m && typeof m === 'object' && !Array.isArray(m) ? ((m as Record<string, unknown>).stage as string) : undefined;
function salesApproverHistoryRow(history: { toStatus: string; changedByUserId: string | null; metadata: Prisma.JsonValue | null }[]) {
  return (
    history.find((h) => h.toStatus === 'PENDING_GIFSY' && stageOf(h.metadata) === 'FIRST_APPROVER') ||
    history.find((h) => h.toStatus === 'PENDING_GIFSY') ||
    history.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) !== 'GIFSY')
  );
}
function gifsyApproval(sub?: { status: string; approvedAt: Date | null; statusHistory: { toStatus: string; createdAt: Date; metadata: Prisma.JsonValue | null }[] }) {
  if (!sub) return { approved: false, at: null as Date | null };
  const gifsyRow =
    sub.statusHistory.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) === 'GIFSY') ||
    sub.statusHistory.find((h) => h.toStatus === 'APPROVED');
  if (sub.status === 'APPROVED' || gifsyRow) return { approved: true, at: gifsyRow?.createdAt ?? sub.approvedAt ?? null };
  return { approved: false, at: null as Date | null };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function oldOutletMaster(
  prisma: any,
  sign: (docId: string, clientId: string) => string,
  user: JwtPayload,
  base: string,
): Promise<Buffer> {
  const clientId = user.clientId;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const geoEnabled = ((client?.features ?? {}) as Record<string, unknown>).outletMasterGeo === true;
  const headers = oldHeaders(geoEnabled, clientId);
  const typeConfigs = await prisma.outletTypeClientConfig.findMany({
    where: { clientId, displayName: { not: null } },
    select: { displayName: true, outletType: { select: { code: true } } },
  });
  const typeDisplayByCode = new Map<string, string>();
  for (const tc of typeConfigs) {
    const dn = (tc.displayName ?? '').trim();
    if (dn) typeDisplayByCode.set(tc.outletType.code, dn);
  }
  const outlets: any[] = await prisma.outlet.findMany({ where: { clientId, deletedAt: null }, select: {}, orderBy: { outletCode: 'asc' } });
  const outletIds = outlets.map((o) => o.id);
  const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
  const assignments: any[] = outletIds.length
    ? await prisma.salesUserAssignment.findMany({
        where: { outletId: { in: outletIds }, unassignedAt: null },
        select: { outletId: true, assignedAt: true, salesUser: { select: salesUserChainSelect() } },
        orderBy: { assignedAt: 'desc' },
      })
    : [];
  const assignmentByOutlet = new Map<string, AssignmentSalesUser>();
  for (const a of assignments) {
    if (!a.outletId || !a.salesUser) continue;
    if (!assignmentByOutlet.has(a.outletId)) assignmentByOutlet.set(a.outletId, a.salesUser);
  }
  const submissions: any[] = partnerIds.length
    ? await prisma.kycSubmission.findMany({
        where: { partnerId: { in: partnerIds }, user: { clientId } },
        orderBy: { createdAt: 'desc' },
        select: { documents: {}, statusHistory: {} },
      })
    : [];
  const latestSubByPartner = new Map<string, any>();
  for (const s of submissions) {
    if (!s.partnerId) continue;
    if (!latestSubByPartner.has(s.partnerId)) latestSubByPartner.set(s.partnerId, s);
  }
  const lookup = new Set<string>();
  for (const s of latestSubByPartner.values()) {
    if (s.user?.id) lookup.add(s.user.id);
    const approver = salesApproverHistoryRow(s.statusHistory);
    if (approver?.changedByUserId) lookup.add(approver.changedByUserId);
  }
  const salesUsersByUserId = lookup.size
    ? new Map<string, any>(
        (await prisma.salesUser.findMany({ where: { userId: { in: [...lookup] }, clientId } })).map((su: any) => [su.userId, su]),
      )
    : new Map<string, any>();
  const docLink = (sub: any, type: string): string => {
    const doc = sub?.documents.find((d: any) => d.documentType === type);
    if (!doc) return '';
    return `${base}/v1/kyc/documents/view?token=${sign(doc.id, clientId)}`;
  };
  const rows = outlets.map((o) => {
    const row: Record<string, unknown> = {};
    row['Zone'] = o.zone ?? '';
    row['Outlet Code'] = o.outletCode ?? '';
    row['Outlet Name'] = o.name ?? '';
    row['Outlet Type'] = (o.outletType?.code && typeDisplayByCode.get(o.outletType.code)) || o.outletType?.name || '';
    row['Program Name'] = o.programName ?? '';
    row['Sub-Program'] = o.programCategory ?? '';
    row['Distributor Code'] = o.distributorCode ?? '';
    row['Distributor Name'] = o.distributorName ?? '';
    row['Metro'] = o.metro ?? '';
    row['Beat'] = o.beat ?? '';
    row['Parent ID'] = o.parent?.partnerCode ?? '';
    if (geoEnabled) {
      row['Latitude'] = decToStr(o.latitude);
      row['Longitude'] = decToStr(o.longitude);
    }
    const byRung = resolveRungs(assignmentByOutlet.get(o.id));
    for (const rung of RUNGS) {
      const su = byRung[rung];
      row[rungIdHeader(clientId, rung)] = su?.employeeCode ?? '';
      row[rungNameHeader(clientId, rung)] = su?.user?.name ?? '';
      row[rungPhoneHeader(clientId, rung)] = su?.user?.phone ?? '';
    }
    row['Owner Name'] = o.partner?.ownerName ?? '';
    row['Phone Number'] = o.partner?.phone ?? o.phone ?? '';
    row['Address'] = [o.addressLine1, o.addressLine2].filter(Boolean).join(', ');
    row['City'] = o.city ?? '';
    row['State'] = o.state ?? '';
    row['Pincode'] = o.pincode ?? '';
    const sub = o.partnerId ? latestSubByPartner.get(o.partnerId) : undefined;
    row['Latitude of Outlet Board'] = decToStr(sub?.boardPhotoLat);
    row['Longitude of Outlet Board'] = decToStr(sub?.boardPhotoLng);
    const enroller = sub?.user?.id ? salesUsersByUserId.get(sub.user.id) : undefined;
    row['Enrollment by Employee ID'] = enroller?.employeeCode ?? '';
    row['Enrollment by Employee Name'] = sub?.user?.name ?? '';
    row['Enrollment by Employee Phone Number'] = sub?.user?.phone ?? '';
    row['Enrollment Date'] = dateOnly(sub?.submittedAt ?? sub?.createdAt);
    row['Enrollment Status'] = sub?.status ?? '';
    row['Profile Status'] = oldProfileStatus(o, sub?.status);
    const approverRow = sub ? salesApproverHistoryRow(sub.statusHistory) : undefined;
    const approver = approverRow?.changedByUserId ? salesUsersByUserId.get(approverRow.changedByUserId) : undefined;
    row['Approval by Employee ID'] = approver?.employeeCode ?? '';
    row['Approval by Employee Name'] = approver?.user?.name ?? '';
    row['Approval by Employee Phone Number'] = approver?.user?.phone ?? '';
    const gifsy = gifsyApproval(sub);
    row['Approval by Gifsy'] = gifsy.approved ? 'Yes' : 'No';
    row['Approval Date of Gifsy'] = dateOnly(gifsy.at);
    row['Latitude of Bank Details Collection'] = decToStr(sub?.paymentLat);
    row['Longitude of Bank Details Collection'] = decToStr(sub?.paymentLng);
    row['Remarks'] = sub?.rejectionReason ?? sub?.reviewerNotes ?? '';
    row['GST'] = o.partner?.gstNumber ?? '';
    row['PAN'] = o.partner?.panNumber ?? '';
    row['GST Certificate'] = docLink(sub, 'GST_CERTIFICATE');
    row['Address Proof'] = docLink(sub, 'SHOP_ESTABLISHMENT');
    row['Self-Declaration'] = docLink(sub, 'SELF_DECLARATION');
    row['Deactivated At'] = dateOnly(o.deactivatedAt);
    return row;
  });
  const orderRow = (r: Record<string, unknown>) => Object.fromEntries(headers.map((h) => [h, r[h] ?? '']));
  const sheetRows = (rows.length ? rows : [Object.fromEntries(headers.map((h) => [h, '']))]).map(orderRow);
  return buildXlsx([{ name: 'Outlet Master', rows: sheetRows }]);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────

const dec = (v: string) => new Prisma.Decimal(v);
const SECRET = 'parity-secret';
const ORIGIN = 'https://api.example.com';

function emptyDb(): FakeData {
  return { features: {}, typeConfigs: [], outlets: [], salesUsers: [], assignments: [], submissions: [], users: [] };
}

function outletRec(clientId: string, id: string, code: string, over: Partial<OutletRec> = {}): OutletRec {
  return {
    id, clientId, deletedAt: null, partnerId: null, outletCode: code, zone: null, name: `Shop ${code}`,
    outletType: null, programName: null, programCategory: null, distributorCode: null, distributorName: null,
    metro: null, beat: null, addressLine1: null, addressLine2: null, city: null, state: null, pincode: null,
    phone: null, latitude: null, longitude: null, deactivatedAt: null, kycIntent: null, reKycFlags: null,
    partner: null, parent: null, ...over,
  };
}

/** A big, varied tenant: `n` outlets over 3 pages, chains with skipped / cross-tenant / cyclic levels, KYC history. */
function bigDb(clientId: string, n: number, seed = 7): FakeData {
  const rnd = seeded(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const db = emptyDb();
  db.features[clientId] = { outletMasterGeo: clientId === 'bajaj' };
  db.typeConfigs.push({ clientId, displayName: 'Retailer', outletType: { code: 'SSS' } });
  db.typeConfigs.push({ clientId: 'other', displayName: 'NOPE', outletType: { code: 'WHOLESALER' } });
  const levels = ['NSM', 'ZNM', 'RSM', 'ASM', 'SO', 'XSR'];
  // A 6-level tree; some SOs report straight to an RSM (skipped ASM); one chain is cyclic; one points cross-tenant.
  let suN = 0;
  const mk = (level: string | null, reportingToId: string | null, tenant = clientId) => {
    const id = `su${String(++suN).padStart(5, '0')}`;
    db.salesUsers.push({ id, clientId: tenant, userId: `u_${id}`, employeeCode: `E${suN}`, reportingToId, levelCode: level, name: `Name ${suN}`, phone: `9${String(suN).padStart(9, '0')}` });
    db.users.push({ id: `u_${id}`, clientId: tenant, name: `Name ${suN}`, phone: `9${String(suN).padStart(9, '0')}` });
    return id;
  };
  const foreignBoss = mk('NSM', null, 'other');
  const nsm = mk('NSM', null);
  const znm = mk('ZNM', nsm);
  const rsms = [mk('RSM', znm), mk('RSM', znm), mk('RSM', foreignBoss)];
  const asms = rsms.flatMap((r) => [mk('ASM', r), mk('ASM', r)]);
  const sos = [...asms.map((a) => mk('SO', a)), mk('SO', rsms[0]), mk(null, rsms[1])];
  const xsrs = sos.flatMap((s) => [mk('XSR', s), mk('XSR', s), mk('XSR', s)]);
  // Cycle: two XSRs reporting to each other.
  const c1 = mk('XSR', null);
  const c2 = mk('SO', c1);
  db.salesUsers.find((s) => s.id === c1)!.reportingToId = c2;
  // A 9-node chain whose NSM is the 9th node — one beyond the old 8-node include, so its NSM cells must stay blank.
  let deep: string | null = mk('NSM', null);
  for (const lvl of ['ZNM', 'RSM', 'ASM', 'SO', 'XSR', 'XSR', 'XSR', 'XSR']) deep = mk(lvl, deep);
  void levels;
  const assignees = [...xsrs, ...sos, c1, deep!];

  const statuses = ['APPROVED', 'REJECTED', 'PENDING_GIFSY', 'PENDING_SO_APPROVAL', 'PENDING_ASM_APPROVAL', 'SUBMITTED', 'DRAFT', 'RESUBMISSION_REQUIRED'];
  const docTypes = ['GST_CERTIFICATE', 'SHOP_ESTABLISHMENT', 'SELF_DECLARATION', 'SELFIE', 'CANCELLED_CHEQUE'];
  const t0 = Date.parse('2025-01-01T00:00:00Z');
  let tick = 0;
  const at = () => new Date(t0 + ++tick * 60_000);
  let subN = 0;
  for (let i = 0; i < n; i++) {
    const id = `o${String(i).padStart(6, '0')}`;
    // Codes are NOT in id order, so the (outletCode, id) keyset is exercised; some share a code.
    const code = i % 97 === 0 ? `DUP${String(Math.floor(i / 970)).padStart(3, '0')}` : `C${String((i * 7919) % 100003).padStart(6, '0')}`;
    const partnerId = rnd() < 0.85 ? `p${id}` : null;
    const o = outletRec(clientId, id, code, {
      partnerId,
      zone: pick(['North', 'South', null]),
      name: i === 5 ? '=HYPERLINK("http://evil")' : `Shop ${i}`,
      outletType: pick([{ name: 'SSS', code: 'SSS' }, { name: 'Wholesaler', code: 'WHOLESALER' }, null]),
      programName: pick(['RLP', 'Gold', null]),
      programCategory: pick(['Urban', null]),
      distributorCode: `D${i % 40}`,
      distributorName: pick(['Dist A', '+Dist B', null]),
      metro: pick(['Metro', null]),
      beat: `B${i % 13}`,
      addressLine1: pick(['A1', null]),
      addressLine2: pick(['A2', null]),
      city: pick(['Pune', 'Mumbai', null]),
      state: pick(['MH', null]),
      pincode: pick(['411001', null]),
      phone: pick(['8000000000', null]),
      latitude: rnd() < 0.5 ? dec('19.07600000') : null,
      longitude: rnd() < 0.5 ? dec('72.87770000') : null,
      deactivatedAt: rnd() < 0.05 ? new Date('2026-06-01T00:00:00Z') : null,
      kycIntent: pick([null, null, null, null, 'PARKED', 'NOT_INTERESTED']),
      reKycFlags: rnd() < 0.1 ? { gstNumber: true } : null,
      partner: partnerId ? { ownerName: `Owner ${i}`, phone: pick(['7000000000', null]), gstNumber: pick(['GST1', null]), panNumber: pick(['PAN1', null]) } : null,
      parent: rnd() < 0.2 ? { partnerCode: `CPP${i % 9}` } : null,
    });
    if (rnd() < 0.01) o.deletedAt = new Date(); // soft-deleted → never exported
    db.outlets.push(o);

    // Every 50th outlet is assigned to the bottom of the 9-node chain.
    if (i % 50 === 0) db.assignments.push({ id: `a${id}_deep`, outletId: id, salesUserId: deep!, assignedAt: new Date(t0 - i), unassignedAt: null });
    const nAssign = Math.floor(rnd() * 3);
    for (let k = 0; k < nAssign; k++) {
      db.assignments.push({ id: `a${id}_${k}`, outletId: id, salesUserId: pick(assignees), assignedAt: at(), unassignedAt: rnd() < 0.3 ? new Date() : null });
    }
    if (partnerId) {
      const nSubs = Math.floor(rnd() * 4);
      for (let k = 0; k < nSubs; k++) {
        const sid = `s${String(++subN).padStart(7, '0')}`;
        const submitter = rnd() < 0.9 ? pick(xsrs) : foreignBoss;
        const docs = docTypes.filter(() => rnd() < 0.6).map((t, j) => ({ id: `d${sid}_${j}`, documentType: t, createdAt: at() }));
        if (rnd() < 0.3) docs.push({ id: `d${sid}_x`, documentType: 'GST_CERTIFICATE', createdAt: at() }); // a newer GST doc
        const hist: SubRec['statusHistory'] = [];
        const hn = Math.floor(rnd() * 5);
        for (let h = 0; h < hn; h++) {
          hist.push({
            id: `h${sid}_${h}`,
            toStatus: pick(['SUBMITTED', 'PENDING_SO_APPROVAL', 'PENDING_GIFSY', 'APPROVED', 'REJECTED']),
            changedByUserId: rnd() < 0.8 ? `u_${pick([...sos, ...asms, ...xsrs])}` : null,
            createdAt: at(),
            metadata: pick([{ stage: 'FIRST_APPROVER' }, { stage: 'GIFSY' }, null, ['x']]),
          });
        }
        db.submissions.push({
          id: sid, partnerId, userId: `u_${submitter}`, status: pick(statuses),
          submittedAt: rnd() < 0.8 ? at() : null, createdAt: at(), approvedAt: rnd() < 0.3 ? at() : null,
          rejectionReason: pick([null, 'GST mismatch', '-bad']), reviewerNotes: pick([null, 'looks good']),
          boardPhotoLat: rnd() < 0.5 ? dec('18.52000000') : null, boardPhotoLng: rnd() < 0.5 ? dec('73.85000000') : null,
          paymentLat: rnd() < 0.5 ? dec('18.53000000') : null, paymentLng: rnd() < 0.5 ? dec('73.86000000') : null,
          documents: docs, statusHistory: hist,
        });
      }
    }
  }
  return db;
}

/** Another tenant sharing the same DB: outlets with interleaving codes + submissions on a SHARED partner id. */
function addOtherTenant(db: FakeData) {
  db.users.push({ id: 'u_other', clientId: 'other', name: 'Other Rep', phone: '1111111111' });
  for (let i = 0; i < 50; i++) {
    db.outlets.push(outletRec('other', `x${i}`, `C${String(i * 2000).padStart(6, '0')}`, { name: `OTHER-TENANT-${i}`, partnerId: `px${i}` }));
  }
  // A submission by another tenant's user on one of OUR partners — must never be "latest" for us.
  const ours = db.outlets.find((o) => o.clientId !== 'other' && o.partnerId);
  if (!ours) return;
  db.submissions.push({
    id: 'zz_other_sub', partnerId: ours.partnerId, userId: 'u_other', status: 'APPROVED', submittedAt: null,
    createdAt: new Date('2030-01-01T00:00:00Z'), approvedAt: null, rejectionReason: 'OTHER-TENANT-REASON', reviewerNotes: null,
    boardPhotoLat: null, boardPhotoLng: null, paymentLat: null, paymentLng: null, documents: [], statusHistory: [],
  });
}

const user = (clientId: string): JwtPayload => ({ sub: 'admin', role: 'CLIENT_ADMIN', clientId, phone: '', name: '' });
const configRef = () => fakeModuleRef([[ConfigService, { get: (k: string) => (k === 'JWT_SECRET' ? SECRET : undefined) }]]);
const oldSigner = () => {
  const jwt = new JwtService({ secret: SECRET });
  return (docId: string, clientId: string) => mintDocViewToken(jwt, SECRET, docId, clientId);
};

async function both(db: FakeData, clientId: string) {
  const oldPrisma = fakePrisma(db);
  const old = await oldOutletMaster(oldPrisma, oldSigner(), user(clientId), ORIGIN);
  const prisma = fakePrisma(db);
  const t = performance.now();
  const res = await runKindToBuffer(OUTLET_MASTER_KIND, { requestOrigin: ORIGIN }, { prisma, moduleRef: configRef(), user: user(clientId) });
  return { old, ...res, prisma, ms: Math.round(performance.now() - t) };
}

// ─── Specs ─────────────────────────────────────────────────────────────────────────────────────────────────

// Thousands of rows through two full xlsx builds per test: allow for a loaded CI box.
jest.setTimeout(120_000);

describe('outlet-master export kind', () => {
  beforeEach(() => {
    // Signed tokens embed `iat` — freeze the clock so the old and new files carry identical tokens.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T06:00:00Z'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('PARITY (Deoleo-style tenant, 4,500 outlets = 3 pages): sheet, headers and every cell equal the old builder', async () => {
    const db = bigDb('deoleo', 4500);
    addOtherTenant(db);
    const { old, buffer, rowCount, prisma, ms } = await both(db, 'deoleo');
    const got = expectSameWorkbook(buffer, old);
    const live = db.outlets.filter((o) => o.clientId === 'deoleo' && !o.deletedAt).length;
    expect(rowCount).toBe(live);
    expect(got.rows['Outlet Master']).toHaveLength(live + 1);
    expect(got.rows['Outlet Master'][0]).toHaveLength(57);
    // Paged: ≤ 2,000 outlets per read, 3 reads.
    const outletCalls = prisma.calls['outlet.findMany'] as Array<{ take: number }>;
    expect(outletCalls).toHaveLength(3);
    expect(outletCalls.every((c) => c.take === 2000)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`outlet-master parity: ${live} rows in ${ms} ms (${Math.round((live / Math.max(ms, 1)) * 1000)} rows/s, fake DB)`);
  });

  it('PARITY (Bajaj: geo columns + Bajaj hierarchy headers)', async () => {
    const db = bigDb('bajaj', 2300, 11);
    const { old, buffer } = await both(db, 'bajaj');
    const got = expectSameWorkbook(buffer, old);
    const headers = got.rows['Outlet Master'][0] as string[];
    expect(headers).toHaveLength(59);
    expect(headers.indexOf('Latitude')).toBe(headers.indexOf('Metro') + 1);
    expect(headers).toContain('ISR Code');
    expect(headers).toContain('SM HQ');
  });

  it('PARITY (empty tenant): every header + one all-blank row', async () => {
    const db = emptyDb();
    addOtherTenant(db);
    const { old, buffer, rowCount } = await both(db, 'deoleo');
    const got = expectSameWorkbook(buffer, old);
    expect(got.rows['Outlet Master']).toHaveLength(2);
    expect(got.rows['Outlet Master'][1].every((c) => c === '')).toBe(true);
    expect(rowCount).toBe(1);
  });

  it('tenant isolation: another tenant\'s outlets and submissions never appear', async () => {
    const db = bigDb('deoleo', 300);
    addOtherTenant(db);
    const { buffer } = await both(db, 'deoleo');
    const text = JSON.stringify(readBack(buffer).rows);
    expect(text).not.toContain('OTHER-TENANT');
    // Enrolling/approving employee lookups are tenant-scoped; the sales-chain walk follows the relation as stored.
  });

  it('over-fetch fix: latest submission per partner via DISTINCT ON, only 3 doc types + 2 history statuses, no nested chain', async () => {
    const db = bigDb('deoleo', 2100);
    const { prisma } = await both(db, 'deoleo');
    const subCalls = prisma.calls['kycSubmission.findMany'] as Array<{ where: Record<string, unknown>; select: Record<string, any> }>;
    expect(subCalls.length).toBeGreaterThan(0);
    for (const c of subCalls) {
      expect(c.where).toHaveProperty('id'); // only the latest ids — never "all submissions of these partners"
      expect(c.select.documents.where).toEqual({ documentType: { in: ['GST_CERTIFICATE', 'SHOP_ESTABLISHMENT', 'SELF_DECLARATION'] } });
      expect(c.select.statusHistory.where).toEqual({ toStatus: { in: ['PENDING_GIFSY', 'APPROVED'] } });
    }
    const raw = prisma.calls['$queryRaw'] as Prisma.Sql[];
    expect(raw.length).toBe(2); // one per page with partners
    expect(raw[0].values[0]).toBe('deoleo'); // tenant-scoped through the submitter
    const assignCalls = prisma.calls['salesUserAssignment.findMany'] as Array<{ select: Record<string, unknown> }>;
    for (const c of assignCalls) expect(c.select).toEqual({ outletId: true, salesUserId: true });
    // Each sales user is read once for the whole export (map), not once per assignment.
    const suIds = (prisma.calls['salesUser.findMany'] as Array<{ where: { id?: { in: string[] } } }>)
      .flatMap((c) => c.where.id?.in ?? []);
    expect(new Set(suIds).size).toBe(suIds.length);
  });

  it('cellSafe: a formula-looking outlet name is written as text', async () => {
    const db = emptyDb();
    db.outlets.push(outletRec('deoleo', 'o1', 'OUT001', { name: '=cmd()', distributorName: '@SUM(A1)' }));
    const { buffer, old } = await both(db, 'deoleo');
    expectSameWorkbook(buffer, old);
    const rows = readBack(buffer).rows['Outlet Master'];
    const h = rows[0] as string[];
    expect(rows[1][h.indexOf('Outlet Name')]).toBe("'=cmd()");
    expect(rows[1][h.indexOf('Distributor Name')]).toBe("'@SUM(A1)");
  });

  it('document links: /v1 doc-view URL on the request origin, token verifiable as a 30-day docview token for the tenant', async () => {
    const db = emptyDb();
    db.users.push({ id: 'u1', clientId: 'deoleo', name: 'Enroller', phone: '6' });
    db.outlets.push(outletRec('deoleo', 'o1', 'OUT001', { partnerId: 'p1' }));
    db.submissions.push({
      id: 's1', partnerId: 'p1', userId: 'u1', status: 'APPROVED', submittedAt: null, createdAt: new Date('2026-05-01T00:00:00Z'),
      approvedAt: null, rejectionReason: null, reviewerNotes: null, boardPhotoLat: null, boardPhotoLng: null, paymentLat: null,
      paymentLng: null, documents: [{ id: 'docGST', documentType: 'GST_CERTIFICATE', createdAt: new Date('2026-05-01T00:00:00Z') }],
      statusHistory: [],
    });
    const { buffer } = await both(db, 'deoleo');
    const rows = readBack(buffer).rows['Outlet Master'];
    const link = String(rows[1][(rows[0] as string[]).indexOf('GST Certificate')]);
    expect(link.startsWith(`${ORIGIN}/v1/kyc/documents/view?token=`)).toBe(true);
    const claims = new JwtService({}).verify(link.split('token=')[1], { secret: SECRET, ignoreExpiration: false });
    expect(claims).toMatchObject({ sub: 'docGST', clientId: 'deoleo', typ: 'docview' });
    expect(claims.exp - claims.iat).toBe(30 * 24 * 3600);
  });

  it.each([
    // [deactivatedAt, kycIntent, reKycFlags, latest status, expected] — precedence deactivatedAt > intent > re-KYC > status.
    [new Date(), null, null, 'APPROVED', 'Deactivated'],
    [null, 'PARKED', null, 'PENDING_SO_APPROVAL', 'Parked'],
    [null, 'NOT_INTERESTED', null, undefined, 'Not Interested'],
    [null, null, { gstNumber: true }, 'APPROVED', 'Re-KYC Required'],
    [null, null, { gstNumber: true }, 'PENDING_ASM_APPROVAL', 'Awaiting ASM Approval'],
    [null, null, null, 'PENDING_SO_APPROVAL', 'Awaiting SO Approval'],
    [null, null, null, 'SUBMITTED', 'Awaiting SO Approval'],
    [null, null, null, 'PENDING_RSM_APPROVAL', 'Awaiting RSM Approval'],
    [null, null, null, 'PENDING_GIFSY', 'Awaiting Gifsy Approval'],
    [null, null, null, 'REJECTED', 'Rejected'],
    [null, null, null, 'RESUBMISSION_REQUIRED', 'Resubmission Required'],
    [null, null, null, 'SUSPENDED', 'Suspended'],
    [null, null, null, undefined, 'KYC Pending'],
  ])('Profile Status (%#): %s %s %j %s → %s', (deactivatedAt, kycIntent, reKycFlags, latest, expected) => {
    const o = { deactivatedAt: deactivatedAt as Date | null, kycIntent: kycIntent as OutletKycIntent | null, reKycFlags: reKycFlags as Prisma.JsonValue };
    expect(profileStatus(o, latest as string | undefined)).toBe(expected);
    expect(oldProfileStatus(o, latest as string | undefined)).toBe(expected);
  });

  it('parseParams: requires the server-set request origin; always heavy; file name and label', () => {
    expect(() => OUTLET_MASTER_KIND.parseParams({}, user('deoleo'))).toThrow('Missing request origin');
    expect(() => OUTLET_MASTER_KIND.parseParams({ requestOrigin: 'javascript:alert(1)' }, user('deoleo'))).toThrow();
    const p = OUTLET_MASTER_KIND.parseParams({ requestOrigin: 'https://api.gifsy.in', junk: 1 }, user('deoleo'));
    expect(p).toEqual({ requestOrigin: 'https://api.gifsy.in' });
    expect(OUTLET_MASTER_KIND.isHeavy(p)).toBe(true);
    expect(OUTLET_MASTER_KIND.fileName(p, new Date('2026-11-13T20:00:00Z'))).toBe('outlet-master-2026-11-13.xlsx');
    expect(OUTLET_MASTER_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:export' });
  });

  it('GIFSY-reject fast-track: the consent-routed DRAFT→PENDING_GIFSY row (actor = the rep) is NOT a sales approver', () => {
    const now = Date.now();
    const ftRow = {
      toStatus: 'PENDING_GIFSY', changedByUserId: 'rep-1', createdAt: new Date(now - 3_600_000),
      metadata: { fastTrack: 'GIFSY_REJECT_RESUBMISSION', previousSubmissionId: 's0' },
    };
    const gifsyApproved = { toStatus: 'APPROVED', changedByUserId: 'admin', createdAt: new Date(now), metadata: { stage: 'GIFSY' } };
    // Fast-tracked → no sales approver at all (blank "Approval by Employee" columns).
    expect(liveSalesApproverHistoryRow([ftRow, gifsyApproved])).toBeUndefined();
    // A normal manager hand-off is unaffected.
    const mgr = { toStatus: 'PENDING_GIFSY', changedByUserId: 'asm-1', createdAt: new Date(now - 7_200_000), metadata: { stage: 'FIRST_APPROVER' } };
    expect(liveSalesApproverHistoryRow([mgr, gifsyApproved])?.changedByUserId).toBe('asm-1');
  });
});
