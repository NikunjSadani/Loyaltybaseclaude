/**
 * KYC status report (xlsx) as a background export — kind `kyc-status`, served by
 * `GET /v1/reports/kyc-status?format=xlsx`. A full outlet snapshot (the date range is ignored, as before). The JSON
 * format of the same endpoint stays in ReportsService and uses the SAME select + row builder below.
 *
 * Paged ≤ 2,000 outlets (keyset on outletCode, id); per page: the owner partner's LATEST submission (take 1) with only
 * its latest transition into REJECTED, then the page's rejecters (name + role) in one query.
 */
import { KycStatus, OutletKycIntent, Prisma } from '@prisma/client';
import { istDateKey } from '../../../common/ist-date';
import { deriveKycStage } from '../../../common/kyc-rekyc.helper';
import { salesUserRoleLabel } from '../../../common/hierarchy-labels';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { ExportKindDef } from '../../export-kinds';
import { BATCH1_PAGE_SIZE } from './common';

export const KYC_STATUS_OUTLET_SELECT = {
  id: true,
  zone: true,
  outletCode: true,
  name: true,
  programName: true,
  deactivatedAt: true,
  kycIntent: true,
  partner: {
    select: {
      ownerName: true,
      phone: true,
      businessName: true,
      panNumber: true,
      // Latest submission for the owner partner (mirrors the KYC dashboard include). The rejection detail is only
      // USED for rows whose current status is "Rejected".
      kycSubmissions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          status: true,
          submittedAt: true,
          createdAt: true,
          id: true,
          rejectionReason: true,
          reviewerNotes: true,
          reviewedAt: true,
          // The (latest) transition into REJECTED: rejected date + actor + pre-rejection stage.
          statusHistory: {
            where: { toStatus: 'REJECTED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true, changedByUserId: true, fromStatus: true },
          },
        },
      },
    },
  },
} satisfies Prisma.OutletSelect;

export type KycStatusOutlet = Prisma.OutletGetPayload<{ select: typeof KYC_STATUS_OUTLET_SELECT }>;

export const KYC_STATUS_HEADERS = [
  'S.No', 'Outlet ID', 'Outlet Name', 'Zone', 'Program Name', 'Business Name', 'Owner/User Name', 'Mobile', 'PAN',
  'Status', 'Last Submitted On', 'Rejected Stage', 'Rejected By', 'Rejection Reason', 'Reviewer Notes', 'Rejected On',
] as const;

export type KycStatusRow = Record<(typeof KYC_STATUS_HEADERS)[number], string | number>;

/** Outlet-level lifecycle overlay first (states outside the KYC pipeline), then the canonical dashboard KYC stage. */
function statusFor(o: KycStatusOutlet): string {
  if (o.deactivatedAt) return 'Deactivated';
  if (o.kycIntent === OutletKycIntent.PARKED) return 'Parked';
  if (o.kycIntent === OutletKycIntent.NOT_INTERESTED) return 'Not Interested';
  return deriveKycStage(o.partner?.kycSubmissions[0]?.status ?? null);
}

/**
 * Report rows for a batch of outlets (S.No continues from `serialStart`). Resolves the rejecters' name + role in ONE
 * query. Sales roles collapse to the tenant-aware hierarchy label (Bajaj swaps RSM→SM; Deoleo byte-identical).
 */
export async function kycStatusRows(
  prisma: PrismaService,
  clientId: string,
  outlets: KycStatusOutlet[],
  serialStart = 0,
): Promise<KycStatusRow[]> {
  const actorIds = Array.from(
    new Set(
      outlets
        .map((o) => o.partner?.kycSubmissions[0]?.statusHistory?.[0]?.changedByUserId)
        .filter((v): v is string => !!v),
    ),
  );
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const roleLabel = (role: string | null | undefined): string => {
    if (!role) return '';
    const nonSales: Record<string, string> = {
      GIFSY_ADMIN: 'Gifsy Admin',
      GIFSY_STAFF: 'Gifsy Staff',
      CLIENT_ADMIN: 'Client Admin',
      MIS_USER: 'MIS User',
    };
    return nonSales[role] ?? salesUserRoleLabel(clientId, role) ?? role;
  };

  // Field vs Gifsy rejection: the canonical stage of the pre-rejection status, else the rejecter's role, else blank.
  const classifyRejectStage = (fromStatus: KycStatus | null | undefined, actorRole: string | null | undefined): string => {
    const stage = deriveKycStage(fromStatus ?? null);
    if (stage === 'Pending Gifsy') return 'Gifsy';
    if (stage === 'Submitted (field approval)') return 'Field';
    if (actorRole?.startsWith('GIFSY_')) return 'Gifsy';
    if (actorRole?.startsWith('SALES_')) return 'Field';
    return '';
  };

  return outlets.map((o, i) => {
    const sub = o.partner?.kycSubmissions[0];
    const lastSubmittedOn = sub ? istDateKey(sub.submittedAt ?? sub.createdAt) : '';
    // The 5 rejection-detail columns are populated ONLY when the CURRENT status is "Rejected".
    const status = statusFor(o);
    const isRejected = status === 'Rejected';
    const hist = sub?.statusHistory?.[0];
    const actor = hist?.changedByUserId ? actorById.get(hist.changedByUserId) : undefined;
    const rejectedAtInstant = hist?.createdAt ?? sub?.reviewedAt;
    return {
      'S.No': serialStart + i + 1,
      'Outlet ID': o.outletCode ?? '',
      'Outlet Name': o.name ?? '',
      Zone: o.zone ?? '',
      'Program Name': o.programName ?? '',
      'Business Name': o.partner?.businessName ?? '',
      'Owner/User Name': o.partner?.ownerName ?? '',
      Mobile: o.partner?.phone ?? '',
      PAN: o.partner?.panNumber ?? '',
      Status: status,
      'Last Submitted On': lastSubmittedOn,
      'Rejected Stage': isRejected ? classifyRejectStage(hist?.fromStatus, actor?.role) : '',
      'Rejected By': isRejected
        ? actor?.name
          ? actor.role
            ? `${actor.name} (${roleLabel(actor.role)})`
            : actor.name
          : ''
        : '',
      'Rejection Reason': isRejected ? (sub?.rejectionReason ?? '') : '',
      'Reviewer Notes': isRejected ? (sub?.reviewerNotes ?? '') : '',
      'Rejected On': isRejected ? (rejectedAtInstant ? istDateKey(rejectedAtInstant) : '') : '',
    };
  });
}

/** Keyset page of the tenant's live outlets in report order (outletCode, id). */
export function kycStatusOutletPage(
  prisma: PrismaService,
  clientId: string,
  after: { outletCode: string; id: string } | null,
  take: number,
): Promise<KycStatusOutlet[]> {
  return prisma.outlet.findMany({
    where: {
      clientId,
      deletedAt: null,
      ...(after ? { OR: [{ outletCode: { gt: after.outletCode } }, { outletCode: after.outletCode, id: { gt: after.id } }] } : {}),
    },
    select: KYC_STATUS_OUTLET_SELECT,
    orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
    take,
  });
}

/**
 * Heavy rule: ALWAYS heavy — a full-tenant outlet snapshot with no filter (6,500 Bajaj outlets), like Outlet Master.
 * Access mirrors the endpoint: @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN') + @RequirePermission('reports:read').
 */
export const KYC_STATUS_KIND: ExportKindDef<Record<string, never>> = {
  kind: 'kyc-status',
  label: 'KYC status report',
  access: { roles: ['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN'], permission: 'reports:read' },
  // dateFrom/dateTo are accepted and ignored, exactly as before (a full snapshot).
  parseParams: () => ({}),
  isHeavy: () => true,
  describeParams: () => 'All outlets',
  fileName: () => 'kyc-status.xlsx',
  async run(ctx, _params, out) {
    const sheet = await out.addSheet('KYC Status', KYC_STATUS_HEADERS);
    let after: { outletCode: string; id: string } | null = null;
    for (;;) {
      const outlets = await kycStatusOutletPage(ctx.prisma, ctx.clientId, after, BATCH1_PAGE_SIZE);
      if (outlets.length === 0) break;
      const last = outlets[outlets.length - 1];
      after = { outletCode: last.outletCode, id: last.id };
      for (const row of await kycStatusRows(ctx.prisma, ctx.clientId, outlets, sheet.rowCount)) {
        await sheet.addRow(KYC_STATUS_HEADERS.map((h) => row[h]));
      }
      if (outlets.length < BATCH1_PAGE_SIZE) break;
    }
    // Zero outlets → one all-blank row so the sheet still shows the headers (as before).
    if (sheet.rowCount === 0) await sheet.addRow(KYC_STATUS_HEADERS.map(() => ''));
    return { rowCount: sheet.rowCount };
  },
};
