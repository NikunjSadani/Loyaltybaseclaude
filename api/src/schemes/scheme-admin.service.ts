import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateSchemeAdminDto,
  RosterQueryDto,
  RosterUploadDto,
  SetAudienceDto,
  SetSchemeStatusDto,
  UpdateSchemeAdminDto,
  UpsertEnrollmentFormAdminDto,
} from './dto/scheme-admin.dto';
import {
  buildOutletWhereFromFilter,
  matchRosterRows,
  parseRosterUploadBuffer,
  OutletMatch,
} from './scheme-roster.helper';
import { OUTLET_FIELD_CATALOG } from './enrollment-form.helper';

/**
 * SchemeAdminService — Wave-0 scheme data-collection ADMIN authoring (GIFSY only).
 *
 * Owns create / edit-in-place / status / enrollment-form (versioned) / audience
 * (filter + snapshot) / roster upload (Mode B) / roster listing. Enrollment capture,
 * enrollments view/export, reject, broadcast and reports are other streams.
 *
 * Tenant-scoped by clientId throughout. Denormalization invariant (§13.3): every
 * SchemeOutlet row is written with the SCHEME's own id + clientId, so the roster can
 * never drift from its scheme.
 */
@Injectable()
export class SchemeAdminService {
  /** Chunk size for batched $transaction persistence (trap #8 — mirrors TargetsService). */
  private static readonly UPLOAD_CHUNK = 100;

  constructor(private readonly prisma: PrismaService) {}

  // ── Ownership / tenant guard ───────────────────────────────────────────────

  /** Loads a scheme in the caller's tenant, or 404s (also 404 if soft-deleted). */
  private async assertSchemeOwnership(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId: user.clientId },
    });
    if (!scheme || scheme.deletedAt !== null) throw new NotFoundException('Scheme not found');
    return scheme;
  }

  /** end must be strictly after start. */
  private assertDateOrder(start: Date, end: Date) {
    if (!(end.getTime() > start.getTime())) {
      throw new BadRequestException('endDate must be after startDate.');
    }
  }

  /**
   * A scheme may only go ACTIVE once it can actually collect data: it must have an
   * audience (who can enroll) AND an enrollment form (what is captured). Activating an
   * empty scheme silently produces a live scheme nothing can enroll into / that captures
   * nothing (H3). Enforced at both create-as-ACTIVE and the setStatus→ACTIVE transition.
   */
  private async assertActivatable(schemeId: string) {
    const [scheme, form] = await Promise.all([
      this.prisma.scheme.findUnique({ where: { id: schemeId }, select: { audienceConfig: true } }),
      this.prisma.schemeEnrollmentForm.findUnique({ where: { schemeId }, select: { id: true } }),
    ]);
    if (!scheme?.audienceConfig) {
      throw new BadRequestException('Set the scheme audience before activating.');
    }
    if (!form) {
      throw new BadRequestException('Add an enrollment form before activating.');
    }
  }

  // ── Create (DRAFT or ACTIVE — D6) ──────────────────────────────────────────

  async create(user: JwtPayload, dto: CreateSchemeAdminDto) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    this.assertDateOrder(startDate, endDate);

    // A brand-new scheme has no audience/form yet, so it can never be validly ACTIVE (H3).
    // Force the DRAFT → (set audience + form) → activate flow.
    if (dto.status === 'ACTIVE') {
      throw new BadRequestException(
        'Create the scheme as a draft, then activate it after setting its audience and enrollment form.',
      );
    }

    const scheme = await this.prisma.scheme.create({
      data: {
        clientId: user.clientId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        startDate,
        endDate,
        imageUrl: dto.imageUrl,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
        // Status is DRAFT unless the admin explicitly launches ACTIVE.
        status: dto.status ?? 'DRAFT',
        // INERT non-null columns (D5) — a data-collection scheme has no reward/compute;
        // the admin never configures these, they exist only to satisfy the schema.
        schemeType: 'PURCHASE_INCENTIVE',
        rewardType: 'POINTS',
        createdByUserId: user.sub,
      },
    });

    return { scheme };
  }

  // ── Edit-in-place (D6/D7 — no duplicate) ───────────────────────────────────

  async update(user: JwtPayload, schemeId: string, dto: UpdateSchemeAdminDto) {
    const existing = await this.assertSchemeOwnership(user, schemeId);

    const startDate = dto.startDate !== undefined ? new Date(dto.startDate) : existing.startDate;
    const endDate = dto.endDate !== undefined ? new Date(dto.endDate) : existing.endDate;
    if (dto.startDate !== undefined || dto.endDate !== undefined) {
      this.assertDateOrder(startDate, endDate);
    }

    const data: Prisma.SchemeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.startDate !== undefined) data.startDate = startDate;
    if (dto.endDate !== undefined) data.endDate = endDate;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
    if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;

    const scheme = await this.prisma.scheme.update({ where: { id: schemeId }, data });
    return { scheme };
  }

  // ── Status transition (activate / pause — D6) ──────────────────────────────

  async setStatus(user: JwtPayload, schemeId: string, dto: SetSchemeStatusDto) {
    await this.assertSchemeOwnership(user, schemeId);
    // Gate activation on audience + form present (H3).
    if (dto.status === 'ACTIVE') {
      await this.assertActivatable(schemeId);
    }
    const scheme = await this.prisma.scheme.update({
      where: { id: schemeId },
      data: { status: dto.status },
    });
    return { scheme };
  }

  // ── Enrollment form (versioned — D11) ──────────────────────────────────────

  /**
   * Persist the current form AND append an immutable version snapshot, so a
   * submission captured against an earlier form still renders coherently. The
   * version bumps on every call; the append is guaranteed unique by the
   * monotonically-increasing version (schema @@unique[schemeId, version]).
   */
  async upsertEnrollmentForm(
    user: JwtPayload,
    schemeId: string,
    dto: UpsertEnrollmentFormAdminDto,
  ) {
    await this.assertSchemeOwnership(user, schemeId);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.schemeEnrollmentForm.findUnique({ where: { schemeId } });
      const nextVersion = (existing?.version ?? 0) + 1;

      const form = await tx.schemeEnrollmentForm.upsert({
        where: { schemeId },
        update: {
          campaignType: dto.campaignType,
          formSchema: dto.formSchema as Prisma.InputJsonValue,
          version: nextVersion,
          updatedAt: new Date(),
        },
        create: {
          schemeId,
          campaignType: dto.campaignType,
          formSchema: dto.formSchema as Prisma.InputJsonValue,
          version: nextVersion,
        },
      });

      const formVersion = await tx.schemeEnrollmentFormVersion.create({
        data: {
          schemeId,
          version: nextVersion,
          campaignType: dto.campaignType,
          formSchema: dto.formSchema as Prisma.InputJsonValue,
        },
      });

      return { enrollmentForm: form, formVersion };
    });
  }

  // ── Audience (§13.2) ───────────────────────────────────────────────────────

  /**
   * Store the audienceConfig. In FILTER mode with `frozen:true`, ALSO materialize a
   * SchemeOutlet snapshot from the filter (chunked). The materialization is additive
   * + idempotent (skipDuplicates on @@unique[schemeId, outletRef]) so re-saving never
   * removes an already-materialized (possibly enrolled) roster row.
   */
  async setAudience(user: JwtPayload, schemeId: string, dto: SetAudienceDto) {
    await this.assertSchemeOwnership(user, schemeId);

    // A FILTER audience must actually narrow (B-MED-1): at least one facet array or
    // kycApprovedOnly. An empty filter would silently snapshot EVERY tenant outlet.
    if (dto.mode === 'FILTER') {
      const f = dto.filter;
      const hasFacet =
        !!f &&
        ([f.outletTypeIds, f.programNames, f.programCategories, f.zones, f.states].some(
          (a) => Array.isArray(a) && a.length > 0,
        ) ||
          f.kycApprovedOnly === true);
      if (!hasFacet) {
        throw new BadRequestException(
          'FILTER audience requires at least one filter facet or kycApprovedOnly',
        );
      }
    }

    const audienceConfig: Prisma.InputJsonValue = {
      mode: dto.mode,
      selfEnrollAllowed: dto.selfEnrollAllowed,
      frozen: dto.frozen,
      ...(dto.filter ? { filter: dto.filter as unknown as Prisma.InputJsonValue } : {}),
    };

    await this.prisma.scheme.update({
      where: { id: schemeId },
      data: { audienceConfig },
    });

    let materializedCount = 0;
    if (dto.mode === 'FILTER' && dto.frozen === true) {
      const where = buildOutletWhereFromFilter(user.clientId, dto.filter);
      const outlets = await this.prisma.outlet.findMany({
        where,
        select: { id: true, outletCode: true, name: true, partnerId: true },
      });

      // Dedup on outletCode (the roster is keyed by outletRef); build create rows.
      const seen = new Set<string>();
      const createRows: Prisma.SchemeOutletCreateManyInput[] = [];
      for (const o of outlets) {
        if (seen.has(o.outletCode)) continue;
        seen.add(o.outletCode);
        createRows.push({
          clientId: user.clientId,
          schemeId,
          outletRef: o.outletCode,
          outletName: o.name,
          matchedOutletId: o.id,
          matchedPartnerId: o.partnerId,
        });
      }

      for (let i = 0; i < createRows.length; i += SchemeAdminService.UPLOAD_CHUNK) {
        const res = await this.prisma.schemeOutlet.createMany({
          data: createRows.slice(i, i + SchemeAdminService.UPLOAD_CHUNK),
          skipDuplicates: true,
        });
        materializedCount += res.count;
      }
    }

    return { audienceConfig, materializedCount };
  }

  // ── Roster upload (Mode B — chunked, dedup) ────────────────────────────────

  async uploadRoster(
    user: JwtPayload,
    schemeId: string,
    file: Express.Multer.File,
    dto: RosterUploadDto,
  ) {
    await this.assertSchemeOwnership(user, schemeId);
    if (!file?.buffer) throw new BadRequestException('A roster .xlsx file is required.');

    let rawRows;
    let skippedRows = 0;
    try {
      const parsed = parseRosterUploadBuffer(file.buffer, {
        idColumn: dto.idColumn,
        nameColumn: dto.nameColumn,
        taggedEmployeeColumn: dto.taggedEmployeeColumn,
      });
      rawRows = parsed.rows;
      skippedRows = parsed.skippedRows;
    } catch {
      throw new BadRequestException('Invalid or corrupted roster xlsx file.');
    }

    if (rawRows.length === 0) {
      throw new BadRequestException('The roster file contained no data rows.');
    }

    // Resolve the tenant-scoped lookup maps for matching.
    const outletRefs: string[] = Array.from(new Set(rawRows.map((r) => r.outletRef)));
    const employeeCodes: string[] = Array.from(
      new Set(rawRows.map((r) => r.taggedEmployeeCode).filter((c): c is string => Boolean(c))),
    );

    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, outletCode: { in: outletRefs }, deletedAt: null },
      select: { id: true, outletCode: true, partnerId: true },
    });
    const outletsByCode = new Map<string, OutletMatch>(
      outlets.map((o) => [o.outletCode, { id: o.id, partnerId: o.partnerId }]),
    );

    const salesUsers = employeeCodes.length
      ? await this.prisma.salesUser.findMany({
          where: { clientId: user.clientId, employeeCode: { in: employeeCodes }, deletedAt: null },
          select: { id: true, employeeCode: true },
        })
      : [];
    const salesUsersByCode = new Map<string, string>(
      salesUsers.map((s) => [s.employeeCode, s.id]),
    );

    const matched = matchRosterRows(rawRows, outletsByCode, salesUsersByCode);

    // Upsert each roster row (dedup enforced by @@unique[schemeId, outletRef]); a
    // re-upload updates the existing row rather than erroring. Chunked to stay under
    // the interactive-transaction timeout at tenant scale (trap #8).
    const ops: Prisma.PrismaPromise<unknown>[] = matched.rows.map((row) =>
      this.prisma.schemeOutlet.upsert({
        where: { schemeId_outletRef: { schemeId, outletRef: row.outletRef } },
        create: {
          clientId: user.clientId,
          schemeId,
          outletRef: row.outletRef,
          outletName: row.outletName,
          matchedOutletId: row.matchedOutletId,
          matchedPartnerId: row.matchedPartnerId,
          taggedSalesUserId: row.taggedSalesUserId,
          prefillValues: (row.prefillValues ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
        update: {
          outletName: row.outletName,
          matchedOutletId: row.matchedOutletId,
          matchedPartnerId: row.matchedPartnerId,
          taggedSalesUserId: row.taggedSalesUserId,
          prefillValues: (row.prefillValues ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
      }),
    );

    for (let i = 0; i < ops.length; i += SchemeAdminService.UPLOAD_CHUNK) {
      await this.prisma.$transaction(ops.slice(i, i + SchemeAdminService.UPLOAD_CHUNK));
    }

    return {
      totalRows: rawRows.length,
      upserted: matched.rows.length,
      matchedCount: matched.matchedCount,
      standaloneCount: matched.standaloneCount,
      duplicateRefs: matched.duplicateRefs,
      unmatchedEmployeeCodes: matched.unmatchedEmployeeCodes,
      // Non-blank rows dropped for a missing outlet id — surfaced so a reconciliation
      // report can account for them (they appear in no other count/sheet).
      skippedRows,
      // Per-input-row disposition for the downloadable upload report (D-report).
      rows: matched.rowReport,
    };
  }

  // ── Roster listing (paginated) ─────────────────────────────────────────────

  async getRoster(user: JwtPayload, schemeId: string, q: RosterQueryDto) {
    await this.assertSchemeOwnership(user, schemeId);

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.SchemeOutletWhereInput = { schemeId, clientId: user.clientId };

    const [roster, total] = await Promise.all([
      this.prisma.schemeOutlet.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: { enrollment: { select: { id: true, status: true, currentVersion: true } } },
      }),
      this.prisma.schemeOutlet.count({ where }),
    ]);

    return { roster, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ── Prefill sources (form-builder dropdown, H1) ────────────────────────────

  /**
   * The two prefill sources the form-builder's "Prefill from" dropdown offers (H1 —
   * replaces the blind free-text input where a typo silently unlocked a Locked field):
   *   - excelColumns — the DISTINCT roster prefill-variable columns actually present on
   *     this scheme's uploaded roster (Mode B). Columns are homogeneous per upload, so a
   *     bounded sample surfaces them all without scanning the whole roster at scale.
   *   - outletFields — the curated Outlet-master fields (dual-source prefill for matched
   *     loyalty outlets), a static contract shared with the backend resolver + validator.
   */
  async getPrefillSources(user: JwtPayload, schemeId: string) {
    await this.assertSchemeOwnership(user, schemeId);
    const rows = await this.prisma.schemeOutlet.findMany({
      where: { schemeId, clientId: user.clientId },
      select: { prefillValues: true },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
    const cols = new Set<string>();
    for (const r of rows) {
      const pv = r.prefillValues as Record<string, unknown> | null;
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        for (const k of Object.keys(pv)) if (k.trim() !== '') cols.add(k);
      }
    }
    return {
      excelColumns: [...cols].sort((a, b) => a.localeCompare(b)),
      outletFields: OUTLET_FIELD_CATALOG.map((f) => ({ key: f.key, label: f.label })),
    };
  }

  // ── Facet values (audience + report filter pickers) ────────────────────────

  /**
   * Distinct outlet-master attribute values across the tenant, so the audience builder
   * and report filters can offer a MULTI-SELECT picker instead of blind free-text
   * (mirrors H1 for facets). Scheme-scoped only to resolve the tenant; the values are the
   * tenant's whole outlet master. `outletTypes` are the types actually in use (id+name).
   */
  async getFacetValues(user: JwtPayload, schemeId: string) {
    await this.assertSchemeOwnership(user, schemeId);
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: { zone: true, programName: true, programCategory: true, state: true, outletTypeId: true },
    });
    const uniq = (vals: (string | null)[]) =>
      [...new Set(vals.filter((v): v is string => Boolean(v && v.trim())))].sort((a, b) => a.localeCompare(b));
    const usedTypeIds = uniq(outlets.map((o) => o.outletTypeId));
    const types = usedTypeIds.length
      ? await this.prisma.outletType.findMany({
          where: { id: { in: usedTypeIds } },
          select: { id: true, name: true },
        })
      : [];
    return {
      zones: uniq(outlets.map((o) => o.zone)),
      programNames: uniq(outlets.map((o) => o.programName)),
      programCategories: uniq(outlets.map((o) => o.programCategory)),
      states: uniq(outlets.map((o) => o.state)),
      outletTypes: types.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
