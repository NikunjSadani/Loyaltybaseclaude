import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  applyDndSuppression,
  isValidPhone,
  OutletAudienceFilter,
  phoneLast10,
} from '../common/audience/audience.helpers';
import { buildOutletWhereFromFilter } from '../schemes/scheme-roster.helper';

/** WhatsApp-only facets layered on top of the shared outlet filter (city + owner-group). */
type WhatsappFilterFacets = OutletAudienceFilter & {
  cities?: string[];
  groupIds?: string[];
  kycApprovedOnly?: boolean;
};

/** A recipient resolved from the tenant master (FILTER) or an uploaded row (EXCEL). */
export interface ResolvedRecipient {
  /** Canonical bare 10-digit phone. */
  phone: string;
  /** Source-record fields available to FILTER variable-mapping (outlet/sales attributes). */
  fields: Record<string, string>;
  /** EXCEL-mode ordered variable values (undefined for FILTER mode). */
  variables?: string[];
}

/** The outcome of resolving + cleaning an audience: the final set + pre-flight stats. */
export interface AudienceResolution {
  recipients: ResolvedRecipient[];
  /** Distinct valid recipients after dedup + suppression. */
  recipientCount: number;
  /** How many raw rows were dropped as invalid (bad/short phone). */
  invalidCount: number;
  /** How many duplicate phones were collapsed. */
  dedupedCount: number;
  /** How many were removed by the DND/opt-out suppression list. */
  suppressedCount: number;
}

export type AudienceScope = 'OUTLETS' | 'SALES' | 'BOTH';

/**
 * Tenant-wide WhatsApp audience resolver (Gifsy-operator, assumed tenant).
 *
 * Shares the SAME pure primitives as the scheme broadcaster (phone canonicalisation,
 * the outlet-facet filter via buildOutletWhereFromFilter, DND suppression) — but the
 * DATA SOURCE is the tenant's WHOLE outlet/sales master (there is no scheme roster
 * here). FILTER mode resolves outlets/sales matching the facet filter and carries each
 * record's fields for per-recipient variable mapping; EXCEL mode takes an uploaded
 * phone+variables list. Both run through the same clean/dedup/suppress finalizer.
 */
@Injectable()
export class WhatsappAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * DND / opt-out suppression source. Empty today (no store yet) — the hook exists so a
   * real per-tenant suppression list is a one-method change with no caller churn.
   */
  private async loadSuppressed(_clientId: string): Promise<ReadonlySet<string>> {
    return new Set<string>();
  }

  /** Resolve a FILTER-mode audience from the tenant's outlet/sales master. */
  async resolveFilter(
    clientId: string,
    scope: AudienceScope,
    filter: OutletAudienceFilter | undefined,
  ): Promise<AudienceResolution> {
    const raw: ResolvedRecipient[] = [];
    if (scope === 'OUTLETS' || scope === 'BOTH') {
      raw.push(...(await this.resolveOutletRecipients(clientId, filter)));
    }
    if (scope === 'SALES' || scope === 'BOTH') {
      raw.push(...(await this.resolveSalesRecipients(clientId, filter)));
    }
    const suppressed = await this.loadSuppressed(clientId);
    return this.finalize(raw, suppressed);
  }

  /**
   * Broadcast-specific Outlet `where`: the shared scheme facet filter PLUS the WhatsApp-only
   * facets (city + owner-group) AND a hard exclusion of deactivated/soft-deleted outlets.
   * A paid blast must never reach a churned outlet, so `deactivatedAt` is pinned null here
   * (a broadcast-only guard — the shared helper, used by SCHEME authoring, is NOT changed).
   */
  private buildBroadcastOutletWhere(
    clientId: string,
    filter: OutletAudienceFilter | undefined,
  ): Prisma.OutletWhereInput {
    const f = filter as WhatsappFilterFacets | undefined;
    const where = buildOutletWhereFromFilter(clientId, {
      outletTypeIds: f?.outletTypeIds,
      programNames: f?.programNames,
      programCategories: f?.programCategories,
      zones: f?.zones,
      states: f?.states,
      kycApprovedOnly: f?.kycApprovedOnly === true,
    });
    // Broadcast-only: never blast a deactivated (churned) outlet. deletedAt is already
    // pinned null by the shared helper; deactivatedAt is the additional broadcast guard.
    where.deactivatedAt = null;
    if (f?.cities && f.cities.length > 0) where.city = { in: f.cities };
    if (f?.groupIds && f.groupIds.length > 0) where.parentId = { in: f.groupIds };
    return where;
  }

  /** True iff the filter narrows the audience at all (any facet or kycApprovedOnly set). */
  private isNarrowed(filter: OutletAudienceFilter | undefined): boolean {
    const f = filter as WhatsappFilterFacets | undefined;
    if (!f) return false;
    const lists = [
      f.zones,
      f.programNames,
      f.programCategories,
      f.outletTypeIds,
      f.states,
      f.cities,
      f.groupIds,
    ];
    if (lists.some((l) => Array.isArray(l) && l.length > 0)) return true;
    return f.kycApprovedOnly === true;
  }

  /** Resolve an EXCEL-mode audience from uploaded rows. */
  async resolveExcel(
    clientId: string,
    rows: { phone: string; variables?: string[] }[],
  ): Promise<AudienceResolution> {
    const raw: ResolvedRecipient[] = rows.map((r) => ({
      phone: phoneLast10(r.phone),
      fields: {},
      variables: r.variables ?? [],
    }));
    const suppressed = await this.loadSuppressed(clientId);
    return this.finalize(raw, suppressed);
  }

  /**
   * OUTLETS: tenant outlets matching the facet filter. Prefers the owner (partner)
   * phone over the outlet phone (parity with the scheme broadcaster). Carries the
   * outlet's fields for FILTER variable-mapping.
   */
  private async resolveOutletRecipients(
    clientId: string,
    filter: OutletAudienceFilter | undefined,
  ): Promise<ResolvedRecipient[]> {
    // Broadcast where: shared scheme facets + city/group + deactivated-outlet exclusion.
    const where = this.buildBroadcastOutletWhere(clientId, filter);

    const outlets = await this.prisma.outlet.findMany({
      where,
      select: {
        name: true,
        outletCode: true,
        ownerName: true,
        phone: true,
        zone: true,
        programName: true,
        programCategory: true,
        state: true,
        city: true,
        district: true,
        partner: { select: { phone: true, ownerName: true } },
      },
    });

    return outlets.map((o) => {
      const phone = phoneLast10(o.partner?.phone ?? o.phone);
      return {
        phone,
        fields: {
          name: o.name ?? '',
          outletCode: o.outletCode ?? '',
          ownerName: o.partner?.ownerName ?? o.ownerName ?? '',
          phone,
          zone: o.zone ?? '',
          programName: o.programName ?? '',
          programCategory: o.programCategory ?? '',
          state: o.state ?? '',
          city: o.city ?? '',
          district: o.district ?? '',
        },
      };
    });
  }

  /**
   * SALES recipients, HONORING the audience filter (no silent over-send):
   *   - NO filter (empty) → every tenant sales rep (tenant-wide blast).
   *   - A filter present → only the reps currently ASSIGNED (SalesUserAssignment,
   *     unassignedAt null) to an outlet that matches the same filtered outlet set. So a
   *     scope=SALES/BOTH blast narrowed to (say) state=MH reaches only the reps working
   *     those outlets — never the whole sales force. BOTH = filtered outlets + their reps.
   */
  private async resolveSalesRecipients(
    clientId: string,
    filter: OutletAudienceFilter | undefined,
  ): Promise<ResolvedRecipient[]> {
    let salesUserWhere: Prisma.SalesUserWhereInput = { clientId, deletedAt: null };

    if (this.isNarrowed(filter)) {
      // Reps assigned to the filtered outlet set. Resolve the outlet ids first (same where
      // the OUTLETS scope uses), then the distinct assigned sales users.
      const outletWhere = this.buildBroadcastOutletWhere(clientId, filter);
      const outlets = await this.prisma.outlet.findMany({
        where: outletWhere,
        select: { id: true },
      });
      const outletIds = outlets.map((o) => o.id);
      if (outletIds.length === 0) return [];
      const assignments = await this.prisma.salesUserAssignment.findMany({
        where: { outletId: { in: outletIds }, unassignedAt: null },
        select: { salesUserId: true },
        distinct: ['salesUserId'],
      });
      const salesUserIds = assignments.map((a) => a.salesUserId);
      if (salesUserIds.length === 0) return [];
      salesUserWhere = { clientId, deletedAt: null, id: { in: salesUserIds } };
    }

    const salesUsers = await this.prisma.salesUser.findMany({
      where: salesUserWhere,
      select: {
        employeeCode: true,
        user: { select: { name: true, phone: true } },
      },
    });

    return salesUsers.map((s) => {
      const phone = phoneLast10(s.user?.phone);
      return {
        phone,
        fields: {
          name: s.user?.name ?? '',
          employeeCode: s.employeeCode ?? '',
          phone,
        },
      };
    });
  }

  /**
   * Clean + dedup + suppress a raw recipient list:
   *   - drop rows whose canonical phone is not a valid bare 10-digit mobile → invalidCount
   *   - collapse duplicate phones (first occurrence wins) → dedupedCount
   *   - remove DND/opt-out phones → suppressedCount
   * Dedup is on the canonical phone so a number reached via two scopes (outlet owner who
   * is also a sales rep) is never messaged — or billed — twice.
   */
  private finalize(
    raw: ResolvedRecipient[],
    suppressed: ReadonlySet<string>,
  ): AudienceResolution {
    let invalidCount = 0;
    const byPhone = new Map<string, ResolvedRecipient>();
    let dedupedCount = 0;
    for (const r of raw) {
      if (!isValidPhone(r.phone)) {
        invalidCount++;
        continue;
      }
      if (byPhone.has(r.phone)) {
        dedupedCount++;
        continue;
      }
      byPhone.set(r.phone, r);
    }

    // DND suppression on the canonical-phone set.
    const keptPhones = applyDndSuppression(new Set(byPhone.keys()), suppressed);
    const suppressedCount = byPhone.size - keptPhones.size;
    const recipients = [...byPhone.values()].filter((r) => keptPhones.has(r.phone));

    return {
      recipients,
      recipientCount: recipients.length,
      invalidCount,
      dedupedCount,
      suppressedCount,
    };
  }
}
