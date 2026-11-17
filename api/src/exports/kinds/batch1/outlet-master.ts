/**
 * Outlet Master (57 columns, +2 geo columns for an `outletMasterGeo` tenant) as a background export — kind
 * `outlet-master`, served by `GET /v1/admin/reports/outlet-master` (moved from ReportsService.outletMaster, which
 * crashed prod with a heap OOM on 2026-11-13). Output is cell-for-cell what the old builder produced (parity spec:
 * outlet-master.spec.ts).
 *
 * Reads, per page of ≤ 2,000 outlets (keyset on outletCode, id) — nothing tenant-wide is held:
 *  - the page's outlets (+ partner, parent code, outlet type);
 *  - the page's ACTIVE assignments (salesUserId only — the old 8-level nested `reportingTo` include is gone);
 *  - the sales chain from a lazily filled id → SalesUser map (each sales user is read once per export, ~1,050 rows at
 *    most for a tenant), walked the same 8 nodes deep the old nested select reached;
 *  - the LATEST KYC submission of each of the page's partners (`DISTINCT ON`, one row per partner — was every
 *    submission ever), with only the three document types the columns show and only the PENDING_GIFSY / APPROVED
 *    status-history rows the approval columns read (was the full history incl. every `metadata` JSON);
 *  - the enrolling / approving sales users of those submissions (cached by userId across pages);
 * then writes the page's rows (signed document links minted per row) before reading the next page.
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OutletKycIntent, Prisma } from '@prisma/client';
import { istDateKey } from '../../../common/ist-date';
import { isKycInFlight, isReKycPending } from '../../../common/kyc-rekyc.helper';
import { rungIdHeader, rungNameHeader, rungPhoneHeader } from '../../../common/hierarchy-labels';
import { mintDocViewToken } from '../../../kyc/doc-view-token';
import { hasFastTrackMarker } from '../../../kyc/kyc-fast-track.helper';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { BATCH1_PAGE_SIZE, rawObject, utcDateKey } from './common';

const RUNGS = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'] as const;
type Rung = (typeof RUNGS)[number];

/** Nodes of the reporting chain the old nested select reached: the assigned user + 7 `reportingTo` levels. */
const CHAIN_DEPTH = 8;

/** Document types the three document-link columns show. */
const DOC_COLUMNS = [
  { header: 'GST Certificate', type: 'GST_CERTIFICATE' },
  { header: 'Address Proof', type: 'SHOP_ESTABLISHMENT' },
  { header: 'Self-Declaration', type: 'SELF_DECLARATION' },
] as const;

export interface OutletMasterParams {
  /** External API origin as the caller reached it — SERVER-SET by ExportsService (never a client value). */
  requestOrigin: string;
}

// ── Headers ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The 57 header keys in exact order. The LEADING columns mirror the outlet UPLOAD template's column order
 * (`OUTLET_UPLOAD_HEADERS` in platform/src/lib/outlet-upload.ts) — only the ORDER is aligned, the master keeps its own
 * established names ("Outlet Code" ≡ template "Outlet ID"; "Distributor Code" ≡ "Distributor ID"). The template's single
 * "XSR ID" expands to the full XSR→NSM block. The hierarchy headers are tenant-aware (Bajaj display headers; every
 * other tenant incl. Deoleo resolves to `${code} ID` / `${code} Name` / `${code} Phone Number`).
 */
function baseOutletMasterHeaders(clientId: string): string[] {
  return [
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
}

/**
 * Headers for a tenant: base, plus — when `outletMasterGeo` is on (Bajaj) — the outlet-coordinate columns
 * 'Latitude'/'Longitude' right after 'Metro' (the upload template's names, so the file round-trips).
 */
export function outletMasterHeaders(geoEnabled: boolean, clientId: string): string[] {
  const base = baseOutletMasterHeaders(clientId);
  if (!geoEnabled) return base;
  const h = [...base];
  const at = h.indexOf('Metro');
  h.splice(at >= 0 ? at + 1 : h.length, 0, 'Latitude', 'Longitude');
  return h;
}

// ── Pure row helpers (moved verbatim from ReportsService) ───────────────────────────────────────────────────

function decToStr(d: Prisma.Decimal | null | undefined): string {
  return d == null ? '' : d.toString();
}

function dateOnly(d: Date | null | undefined): string {
  return d ? istDateKey(new Date(d)) : '';
}

/**
 * The outlet's real "Profile Status". Precedence: genuinely DEACTIVATED (deactivatedAt, NOT isActive — an outlet is
 * created isActive=false and flips true only at KYC approval) → outlet-level intent (PARKED / NOT_INTERESTED) → re-KYC
 * flagged with no fresh submission under review → the latest submission's pipeline stage.
 */
export function profileStatus(
  outlet: { deactivatedAt: Date | null; kycIntent: OutletKycIntent | null; reKycFlags: Prisma.JsonValue | null },
  latest: string | undefined,
): string {
  if (outlet.deactivatedAt) return 'Deactivated';
  if (outlet.kycIntent === OutletKycIntent.PARKED) return 'Parked';
  if (outlet.kycIntent === OutletKycIntent.NOT_INTERESTED) return 'Not Interested';
  if (isReKycPending(outlet.reKycFlags) && !isKycInFlight(latest)) return 'Re-KYC Required';
  switch (latest) {
    case 'APPROVED':              return 'Approved';
    case 'REJECTED':              return 'Rejected';
    case 'RE_KYC_REQUIRED':       return 'Re-KYC Required';
    case 'RE_UPLOAD_REQUIRED':
    case 'RESUBMISSION_REQUIRED': return 'Resubmission Required';
    case 'PENDING_ASM_APPROVAL':  return 'Awaiting ASM Approval';
    case 'PENDING_RSM_APPROVAL':  return 'Awaiting RSM Approval';
    case 'PENDING_GIFSY':         return 'Awaiting Gifsy Approval';
    case 'SUSPENDED':             return 'Suspended';
    // Submitted / initial-review states and PENDING_SO_APPROVAL all read as awaiting the first (SO) approval.
    case 'PENDING_SO_APPROVAL':
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
    case 'PENDING_PENNY_DROP':
    case 'PENDING_AGREEMENT':     return 'Awaiting SO Approval';
    default:                      return 'KYC Pending';
  }
}

export interface HistoryRow {
  toStatus: string;
  changedByUserId: string | null;
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
}

function stageOf(m: Prisma.JsonValue | null): string | undefined {
  return m && typeof m === 'object' && !Array.isArray(m) ? ((m as Record<string, unknown>).stage as string) : undefined;
}

/**
 * The status-history row of the SALES approval that handed the submission to Gifsy: a FIRST_APPROVER-stage row into
 * PENDING_GIFSY, else any row into PENDING_GIFSY, else a sales-side APPROVED (stage ≠ GIFSY).
 *
 * A GIFSY-reject FAST-TRACK row (DRAFT→PENDING_GIFSY at the owner's consent, Bajaj `gifsyRejectFastTrack`) is NOT a
 * sales approval — its actor is the submitting REP — so it is skipped: a fast-tracked KYC has no sales approver and
 * the "Approval by Employee" columns stay blank instead of naming the rep. (No such row exists for any other tenant.)
 */
export function salesApproverHistoryRow(history: HistoryRow[]): HistoryRow | undefined {
  const sales = history.filter((h) => !hasFastTrackMarker(h.metadata));
  return (
    sales.find((h) => h.toStatus === 'PENDING_GIFSY' && stageOf(h.metadata) === 'FIRST_APPROVER') ||
    sales.find((h) => h.toStatus === 'PENDING_GIFSY') ||
    sales.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) !== 'GIFSY')
  );
}

/** Gifsy final-approval state + timestamp for a submission. */
function gifsyApproval(sub?: { status: string; approvedAt: Date | null; statusHistory: HistoryRow[] }): {
  approved: boolean;
  at: Date | null;
} {
  if (!sub) return { approved: false, at: null };
  const gifsyRow =
    sub.statusHistory.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) === 'GIFSY') ||
    sub.statusHistory.find((h) => h.toStatus === 'APPROVED');
  if (sub.status === 'APPROVED' || gifsyRow) return { approved: true, at: gifsyRow?.createdAt ?? sub.approvedAt ?? null };
  return { approved: false, at: null };
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────────────────────────

const OUTLET_SELECT = {
  id: true,
  partnerId: true,
  zone: true,
  outletCode: true,
  name: true,
  outletType: { select: { name: true, code: true } },
  programName: true,
  programCategory: true,
  distributorCode: true,
  distributorName: true,
  metro: true,
  beat: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  pincode: true,
  phone: true,
  latitude: true,
  longitude: true,
  deactivatedAt: true,
  kycIntent: true,
  reKycFlags: true,
  partner: { select: { ownerName: true, phone: true, gstNumber: true, panNumber: true } },
  // Owner-group parent → its partnerCode round-trips through the upload's "Parent ID".
  parent: { select: { partnerCode: true } },
} satisfies Prisma.OutletSelect;

type OutletRow = Prisma.OutletGetPayload<{ select: typeof OUTLET_SELECT }>;

const SUBMISSION_SELECT = {
  id: true,
  partnerId: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  approvedAt: true,
  rejectionReason: true,
  reviewerNotes: true,
  boardPhotoLat: true,
  boardPhotoLng: true,
  paymentLat: true,
  paymentLng: true,
  user: { select: { id: true, name: true, phone: true } },
  // Only the three types the link columns show; newest first so `find` = the latest of a type.
  documents: {
    where: { documentType: { in: DOC_COLUMNS.map((d) => d.type) } },
    select: { id: true, documentType: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  },
  // Only the transitions the approval columns read (salesApproverHistoryRow / gifsyApproval), oldest first.
  statusHistory: {
    where: { toStatus: { in: ['PENDING_GIFSY', 'APPROVED'] } },
    select: { toStatus: true, changedByUserId: true, createdAt: true, metadata: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.KycSubmissionSelect;

type SubmissionRow = Prisma.KycSubmissionGetPayload<{ select: typeof SUBMISSION_SELECT }>;

interface ChainNode {
  employeeCode: string;
  levelCode: string | null;
  name: string | null;
  phone: string | null;
  reportingToId: string | null;
}

interface PersonRow {
  employeeCode: string;
  user: { name: string | null; phone: string | null } | null;
}

/** Latest submission id per partner (newest createdAt; id breaks a tie), scoped to the tenant through the submitter. */
async function latestSubmissionIds(ctx: ExportRunContext, partnerIds: string[]): Promise<string[]> {
  if (partnerIds.length === 0) return [];
  const rows = await ctx.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT ON (s."partnerId") s."id"
      FROM "kyc_submissions" s
      JOIN "users" u ON u."id" = s."userId"
     WHERE u."clientId" = ${ctx.clientId}
       AND s."partnerId" IN (${Prisma.join(partnerIds)})
     ORDER BY s."partnerId", s."createdAt" DESC, s."id" DESC`);
  return rows.map((r) => r.id);
}

/** Sales users by id, loaded lazily and kept for the whole export (a tenant has ~1,050). */
class SalesChainCache {
  private readonly byId = new Map<string, ChainNode | null>();

  constructor(private readonly ctx: ExportRunContext) {}

  /** Make sure every node within CHAIN_DEPTH of each start id is loaded (one query per missing level). */
  async load(startIds: Iterable<string>): Promise<void> {
    let frontier = new Set(startIds);
    for (let depth = 0; depth < CHAIN_DEPTH && frontier.size > 0; depth++) {
      const missing = [...frontier].filter((id) => !this.byId.has(id));
      if (missing.length > 0) {
        // No tenant filter: the old nested `reportingTo` include followed the relation as stored.
        const rows = await this.ctx.prisma.salesUser.findMany({
          where: { id: { in: missing } },
          select: {
            id: true,
            employeeCode: true,
            reportingToId: true,
            hierarchyLevel: { select: { code: true } },
            user: { select: { name: true, phone: true } },
          },
        });
        for (const id of missing) this.byId.set(id, null);
        for (const r of rows) {
          this.byId.set(r.id, {
            employeeCode: r.employeeCode,
            levelCode: r.hierarchyLevel?.code ?? null,
            name: r.user?.name ?? null,
            phone: r.user?.phone ?? null,
            reportingToId: r.reportingToId,
          });
        }
      }
      const next = new Set<string>();
      for (const id of frontier) {
        const parent = this.byId.get(id)?.reportingToId;
        if (parent) next.add(parent);
      }
      frontier = next;
    }
  }

  /**
   * Bucket the chain by hierarchyLevel.code (NOT walk position) so a skipped level leaves its cells blank; the first
   * node of a code wins; at most CHAIN_DEPTH nodes, like the old nested select.
   */
  rungs(startId: string | undefined): Record<Rung, ChainNode | undefined> {
    const out: Record<Rung, ChainNode | undefined> = {
      XSR: undefined, SO: undefined, ASM: undefined, RSM: undefined, ZNM: undefined, NSM: undefined,
    };
    let id: string | null | undefined = startId;
    for (let n = 0; id && n < CHAIN_DEPTH; n++) {
      const node = this.byId.get(id);
      if (!node) break;
      const code = node.levelCode as Rung | null;
      if (code && code in out && !out[code]) out[code] = node;
      id = node.reportingToId;
    }
    return out;
  }
}

// ── The kind ────────────────────────────────────────────────────────────────────────────────────────────────

async function runOutletMaster(
  ctx: ExportRunContext,
  params: OutletMasterParams,
  out: Parameters<ExportKindDef<OutletMasterParams>['run']>[2],
): Promise<{ rowCount: number }> {
  const { prisma, clientId } = ctx;
  const base = params.requestOrigin;

  // Bajaj-only outlet-coordinate columns (clients.features.outletMasterGeo); every other tenant gets the base set.
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const geoEnabled = ((client?.features ?? {}) as Record<string, unknown>).outletMasterGeo === true;
  const headers = outletMasterHeaders(geoEnabled, clientId);

  // Per-tenant outlet-type display labels: "Outlet Type" = displayName ?? name.
  const typeConfigs = await prisma.outletTypeClientConfig.findMany({
    where: { clientId, displayName: { not: null } },
    select: { displayName: true, outletType: { select: { code: true } } },
  });
  const typeDisplayByCode = new Map<string, string>();
  for (const tc of typeConfigs) {
    const dn = (tc.displayName ?? '').trim();
    if (dn) typeDisplayByCode.set(tc.outletType.code, dn);
  }

  // Signed document links — the same token KycService.signDocViewToken mints (shared mintDocViewToken).
  const config = ctx.moduleRef.get(ConfigService, { strict: false });
  const secret = config.get<string>('JWT_SECRET');
  const jwt = new JwtService({});
  const docLink = (sub: SubmissionRow | undefined, type: string): string => {
    const doc = sub?.documents.find((d) => d.documentType === type);
    if (!doc) return '';
    return `${base}/v1/kyc/documents/view?token=${mintDocViewToken(jwt, secret, doc.id, clientId)}`;
  };

  const sheet = await out.addSheet('Outlet Master', headers);
  const chain = new SalesChainCache(ctx);
  const peopleByUserId = new Map<string, PersonRow | null>();
  let after: { outletCode: string; id: string } | null = null;

  for (;;) {
    const outlets: OutletRow[] = await prisma.outlet.findMany({
      where: {
        clientId,
        deletedAt: null,
        ...(after
          ? { OR: [{ outletCode: { gt: after.outletCode } }, { outletCode: after.outletCode, id: { gt: after.id } }] }
          : {}),
      },
      select: OUTLET_SELECT,
      orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
      take: BATCH1_PAGE_SIZE,
    });
    if (outlets.length === 0) break;
    const last = outlets[outlets.length - 1];
    after = { outletCode: last.outletCode, id: last.id };

    // Active assignments — the most recent per outlet wins.
    const assignments = await prisma.salesUserAssignment.findMany({
      where: { outletId: { in: outlets.map((o) => o.id) }, unassignedAt: null },
      select: { outletId: true, salesUserId: true },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    const assignedByOutlet = new Map<string, string>();
    for (const a of assignments) {
      if (a.outletId && !assignedByOutlet.has(a.outletId)) assignedByOutlet.set(a.outletId, a.salesUserId);
    }
    await chain.load(assignedByOutlet.values());

    // Latest KYC submission per partner of this page.
    const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
    const subIds = await latestSubmissionIds(ctx, partnerIds);
    const subs = subIds.length
      ? await prisma.kycSubmission.findMany({ where: { id: { in: subIds } }, select: SUBMISSION_SELECT })
      : [];
    const subByPartner = new Map<string, SubmissionRow>();
    for (const s of subs) if (s.partnerId) subByPartner.set(s.partnerId, s);

    // Enrolling + approving employees (actor User id → its SalesUser in this tenant), cached across pages.
    const wanted = new Set<string>();
    for (const s of subByPartner.values()) {
      if (s.user?.id) wanted.add(s.user.id);
      const appr = salesApproverHistoryRow(s.statusHistory);
      if (appr?.changedByUserId) wanted.add(appr.changedByUserId);
    }
    const missingPeople = [...wanted].filter((id) => !peopleByUserId.has(id));
    if (missingPeople.length > 0) {
      const people = await prisma.salesUser.findMany({
        where: { userId: { in: missingPeople }, clientId },
        select: { userId: true, employeeCode: true, user: { select: { name: true, phone: true } } },
      });
      for (const id of missingPeople) peopleByUserId.set(id, null);
      for (const p of people) peopleByUserId.set(p.userId, p);
    }

    for (const o of outlets) {
      const row: Record<string, string> = {};
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

      const byRung = chain.rungs(assignedByOutlet.get(o.id));
      for (const rung of RUNGS) {
        const su = byRung[rung];
        row[rungIdHeader(clientId, rung)] = su?.employeeCode ?? '';
        row[rungNameHeader(clientId, rung)] = su?.name ?? '';
        row[rungPhoneHeader(clientId, rung)] = su?.phone ?? '';
      }

      row['Owner Name'] = o.partner?.ownerName ?? '';
      row['Phone Number'] = o.partner?.phone ?? o.phone ?? '';
      row['Address'] = [o.addressLine1, o.addressLine2].filter(Boolean).join(', ');
      row['City'] = o.city ?? '';
      row['State'] = o.state ?? '';
      row['Pincode'] = o.pincode ?? '';

      const sub = o.partnerId ? subByPartner.get(o.partnerId) : undefined;
      row['Latitude of Outlet Board'] = decToStr(sub?.boardPhotoLat);
      row['Longitude of Outlet Board'] = decToStr(sub?.boardPhotoLng);

      const enroller = sub?.user?.id ? peopleByUserId.get(sub.user.id) : undefined;
      row['Enrollment by Employee ID'] = enroller?.employeeCode ?? '';
      row['Enrollment by Employee Name'] = sub?.user?.name ?? '';
      row['Enrollment by Employee Phone Number'] = sub?.user?.phone ?? '';
      row['Enrollment Date'] = dateOnly(sub?.submittedAt ?? sub?.createdAt);
      row['Enrollment Status'] = sub?.status ?? '';
      row['Profile Status'] = profileStatus(o, sub?.status);

      const approverRow = sub ? salesApproverHistoryRow(sub.statusHistory) : undefined;
      const approver = approverRow?.changedByUserId ? peopleByUserId.get(approverRow.changedByUserId) : undefined;
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
      for (const d of DOC_COLUMNS) row[d.header] = docLink(sub, d.type);
      row['Deactivated At'] = dateOnly(o.deactivatedAt);

      await sheet.addRow(headers.map((h) => row[h] ?? ''));
    }
    if (outlets.length < BATCH1_PAGE_SIZE) break;
  }

  // An empty tenant still gets every column: the old builder seeded one all-blank row.
  if (sheet.rowCount === 0) await sheet.addRow(headers.map(() => ''));
  return { rowCount: sheet.rowCount };
}

/**
 * Heavy rule: ALWAYS heavy (Downloads page). `isHeavy` sees only the params (no tenant size), and this is the
 * report that took prod down: 6,500 outlets × 59 columns + 3 signed links per row is a minutes-long, DB-heavy job for
 * Bajaj. A small tenant waits ~1 minute instead of getting it instantly — accepted for one uniform, safe path.
 * Access mirrors the endpoint: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') + @RequirePermission('reports:export').
 */
export const OUTLET_MASTER_KIND: ExportKindDef<OutletMasterParams> = {
  kind: 'outlet-master',
  label: 'Outlet master',
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:export' },
  parseParams(raw) {
    const origin = rawObject(raw).requestOrigin;
    if (typeof origin !== 'string' || !/^https?:\/\/[^\s/?#]+$/.test(origin)) {
      throw new BadRequestException('Missing request origin.');
    }
    return { requestOrigin: origin };
  },
  isHeavy: () => true,
  describeParams: () => 'All outlets',
  fileName: (_params, now) => `outlet-master-${utcDateKey(now)}.xlsx`,
  run: runOutletMaster,
};
