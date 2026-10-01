import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildXlsx } from '../common/xlsx';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateSchemeAdminDto,
  RosterQueryDto,
  RosterRemoveDto,
  RosterRemoveUploadDto,
  RosterUploadDto,
  SetAudienceDto,
  SetSchemeStatusDto,
  TestWhatsappConfirmDto,
  UpdateSchemeAdminDto,
  UpsertEnrollmentFormAdminDto,
} from './dto/scheme-admin.dto';
import {
  buildOutletWhereFromFilter,
  matchRosterRows,
  parseRosterUploadBuffer,
  OutletMatch,
} from './scheme-roster.helper';
import { OUTLET_FIELD_CATALOG, ROSTER_IDENTITY_COLUMNS } from './enrollment-form.helper';
import {
  normalizeWhatsappConfirmForStore,
  parseWhatsappConfirmConfig,
  WhatsappConfirmVariable,
} from './scheme-whatsapp-confirm.helper';
import { Msg91Service } from '../notifications/msg91.service';
import { formatDateIST, istDateKey } from '../common/ist-date';
import { phoneLast10, isValidPhone } from '../common/audience/audience.helpers';

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
  private readonly logger = new Logger(SchemeAdminService.name);
  /** Chunk size for batched $transaction persistence (trap #8 — mirrors TargetsService). */
  private static readonly UPLOAD_CHUNK = 100;

  constructor(
    private readonly prisma: PrismaService,
    // Msg91Service is @Global() (NotificationsModule) + already injected by
    // SchemeEnrollmentService the same way — no schemes.module import change needed.
    private readonly msg91: Msg91Service,
  ) {}

  /** Read a stored metadata JSON value into a plain object (null/array/scalar → {}). */
  private readMetadataObject(raw: unknown): Record<string, unknown> {
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  }

  /**
   * Merge the create/update metadata inputs into the value to persist.
   *   - `base` — the metadata to start from (existing scheme metadata on update, else {}).
   *   - `dtoMetadata` — a caller-supplied metadata bag; its keys are merged over `base`.
   *   - `whatsappConfirm` — when provided, normalized into `metadata.whatsappConfirm`,
   *     preserving every OTHER metadata key (so the WhatsApp-confirm editor and the main
   *     scheme editor never clobber each other's metadata).
   * Returns `undefined` when the result is empty (nothing to write on create).
   */
  private mergeMetadata(
    base: Record<string, unknown>,
    dtoMetadata: Record<string, unknown> | undefined,
    whatsappConfirm: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const merged: Record<string, unknown> = { ...base, ...(dtoMetadata ?? {}) };
    // SECURITY: `whatsappConfirm` may ONLY be written through the dedicated, @IsValidWhatsappConfirm-
    // validated DTO field — never smuggled raw through the free-form `metadata` bag (which would skip
    // validation). Strip any bag-supplied key first; if the caller sent the real (validated) field,
    // it is normalized in below. If they didn't, the STORED whatsappConfirm (from `base`) is preserved.
    if ('whatsappConfirm' in merged && whatsappConfirm === undefined) {
      merged.whatsappConfirm = this.readMetadataObject(base).whatsappConfirm;
      if (merged.whatsappConfirm === undefined) delete merged.whatsappConfirm;
    }
    if (whatsappConfirm !== undefined) {
      merged.whatsappConfirm = normalizeWhatsappConfirmForStore(whatsappConfirm);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

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
      this.prisma.schemeEnrollmentForm.findUnique({ where: { schemeId }, select: { formSchema: true } }),
    ]);
    // Audience must parse to a REAL mode (FILTER/EXCEL) — a truthy-but-garbage config
    // (e.g. `{}`) silently falls back to "visible to all", defeating the gate (audit F4).
    const ac = scheme?.audienceConfig as { mode?: unknown } | null;
    if (!ac || typeof ac !== 'object' || (ac.mode !== 'FILTER' && ac.mode !== 'EXCEL')) {
      throw new BadRequestException('Set a valid scheme audience before activating.');
    }
    // The form must exist AND capture at least one field — an empty-fields form captures
    // nothing, which is exactly what H3 exists to prevent (audit F4).
    const fields = (form?.formSchema as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new BadRequestException('Add an enrollment form with at least one field before activating.');
    }
  }

  /**
   * Authoritative guard (audit FE-F1): when whatsappConfirm is ENABLED and references FORM_FIELD
   * ids (recipient and/or variables), every referenced id MUST exist in the scheme's SAVED
   * enrollment form — not merely in the builder's unsaved draft. A stale/never-saved field id
   * would otherwise resolve to a blank body variable or an unresolvable recipient at send time.
   * `schemeId === null` (create) → no form yet → any FORM_FIELD ref is rejected (save the form first).
   */
  private async assertWhatsappConfirmFieldsExist(
    schemeId: string | null,
    whatsappConfirm: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (whatsappConfirm === undefined) return;
    const cfg = parseWhatsappConfirmConfig(whatsappConfirm);
    if (!cfg || !cfg.enabled) return;
    const refs = new Set<string>();
    if (cfg.recipient?.source === 'FORM_FIELD' && cfg.recipient.formFieldId) refs.add(cfg.recipient.formFieldId);
    for (const v of cfg.variables ?? []) {
      if (v.token === 'FORM_FIELD' && v.formFieldId) refs.add(v.formFieldId);
    }
    if (refs.size === 0) return;
    const form = schemeId
      ? await this.prisma.schemeEnrollmentForm.findUnique({ where: { schemeId }, select: { formSchema: true } })
      : null;
    const fields = ((form?.formSchema as { fields?: Array<{ id?: unknown }> } | null)?.fields) ?? [];
    const known = new Set(fields.map((f) => (typeof f.id === 'string' ? f.id : '')).filter(Boolean));
    const missing = [...refs].filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `WhatsApp confirmation references enrollment-form field(s) not in this scheme's saved form: ${missing.join(', ')}. Save the enrollment form (with those fields) first.`,
      );
    }
  }

  // ── Create (DRAFT or ACTIVE — D6) ──────────────────────────────────────────

  async create(user: JwtPayload, dto: CreateSchemeAdminDto) {
    await this.assertWhatsappConfirmFieldsExist(null, dto.whatsappConfirm);
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
        // A new scheme has no existing metadata → base is {}; whatsappConfirm (when sent)
        // is normalized into metadata.whatsappConfirm alongside any other metadata keys.
        metadata: this.mergeMetadata({}, dto.metadata, dto.whatsappConfirm) as
          | Prisma.InputJsonValue
          | undefined,
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
    await this.assertWhatsappConfirmFieldsExist(schemeId, dto.whatsappConfirm);

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
    // Metadata: only touched when the caller sends a metadata bag and/or whatsappConfirm.
    // Both are merged over the scheme's EXISTING metadata so neither clobbers keys it did
    // not send (in particular, editing whatsappConfirm preserves the rest of the bag, and
    // editing other metadata preserves an already-stored whatsappConfirm).
    if (dto.metadata !== undefined || dto.whatsappConfirm !== undefined) {
      data.metadata = this.mergeMetadata(
        this.readMetadataObject(existing.metadata),
        dto.metadata,
        dto.whatsappConfirm,
      ) as Prisma.InputJsonValue;
    }

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

  // ── Test-send the WhatsApp confirmation (validate a SAVED config live) ──────

  /** Sample values for a body variable when the admin supplies none (per token). */
  private sampleForVariable(v: WhatsappConfirmVariable, schemeName: string | null): string {
    switch (v.token) {
      case 'OWNER_NAME':
        return 'Ramesh Kumar';
      case 'OWNER_PHONE':
        return '9876543210';
      case 'OUTLET_NAME':
        return 'Ramesh Traders';
      case 'OUTLET_CODE':
        return 'OUT12345';
      case 'SCHEME_NAME':
        return schemeName || 'Sample Scheme';
      case 'SUBMISSION_DATE':
        // Match resolveSchemeWhatsappConfirm's SUBMISSION_DATE: IST wall-clock "DD Mon YYYY".
        return formatDateIST(new Date());
      case 'FORM_FIELD':
        return 'Sample value';
      default:
        return 'Sample value';
    }
  }

  /**
   * Fire a TEST WhatsApp for a scheme's SAVED metadata.whatsappConfirm config, to a number
   * the admin types, with sample (or admin-provided) variable values — WITHOUT creating an
   * enrollment or touching partner data. Validates the MSG91 template name + variable mapping
   * on a live scheme.
   *
   * VALIDATION problems (config not enabled / blank template / bad phone / value-count
   * mismatch) throw 4xx. The SEND outcome (dormant / sent / MSG91 error) is the POINT of the
   * test, so it is returned as a 200 RESULT — never thrown.
   *
   * PII: the full phone + body values are NEVER logged or returned — only `sentToMasked`
   * (••••<last4>).
   */
  async testWhatsappConfirm(user: JwtPayload, schemeId: string, dto: TestWhatsappConfirmDto) {
    // 1) Tenant scope (also loads the scheme — metadata + name — for the config + samples).
    const scheme = await this.assertSchemeOwnership(user, schemeId);

    // 2) Load + validate the SAVED config (lives at metadata.whatsappConfirm; same extraction
    //    as fireWhatsappConfirm in scheme-enrollment.service).
    const rawConfig = this.readMetadataObject(scheme.metadata).whatsappConfirm;
    const config = parseWhatsappConfirmConfig(rawConfig);
    if (!config || !config.enabled || config.templateName.trim() === '') {
      throw new BadRequestException(
        'Enable the WhatsApp confirmation and set a template name before sending a test.',
      );
    }
    const templateName = config.templateName.trim();

    // 3) Normalize the recipient: strip non-digits, take the LAST 10; must be exactly 10.
    const phone = phoneLast10(dto.phone);
    if (!isValidPhone(phone)) {
      throw new BadRequestException('Enter a valid 10-digit mobile number.');
    }

    // 4) Resolve the ordered body values.
    let bodyValues: string[];
    if (dto.bodyValues !== undefined) {
      if (dto.bodyValues.length !== config.variables.length) {
        throw new BadRequestException('Test values count must match the configured variables.');
      }
      // Coerce → String, trim, cap each at 300 chars (defensive — the DTO already @IsString's them).
      bodyValues = dto.bodyValues.map((v) => String(v ?? '').trim().slice(0, 300));
      // A blank/whitespace-only positional value is rejected by WhatsApp — surface it as a
      // clear 400 rather than letting it fail opaquely at MSG91.
      if (bodyValues.some((v) => v === '')) {
        throw new BadRequestException('Test values cannot be blank — fill every sample value.');
      }
    } else {
      bodyValues = config.variables.map((v) => this.sampleForVariable(v, scheme.name ?? null));
    }

    // 5) Dormancy: report (don't silently no-op) when MSG91 is not wired in this environment.
    if (!this.msg91.isWhatsappConfigured()) {
      return {
        ok: false,
        dormant: true,
        message: 'WhatsApp channel is not configured in this environment — nothing was sent.',
      };
    }

    // 6) Send. The send OUTCOME is the point of the test → returned as a 200 result, never thrown.
    // Audit line (initiator + scheme + masked recipient only — never the full phone or the
    // body values) so a real, billable test send is traceable to the admin who fired it.
    this.logger.log(
      `WhatsApp test-send: admin=${user.sub} scheme=${schemeId} template="${templateName}" → ••••${phone.slice(-4)}`,
    );
    try {
      const { requestId } = await this.msg91.sendWhatsappTemplate(phone, templateName, bodyValues);
      return { ok: true, requestId: requestId ?? null, sentToMasked: '••••' + phone.slice(-4) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
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
      // Per-scheme enroller-edit flag (default false) — only persisted when explicitly set.
      ...(dto.allowEnrollerEdit !== undefined ? { allowEnrollerEdit: dto.allowEnrollerEdit } : {}),
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
      // NOTE: "removed stays removed" — a filter re-materialize does NOT resurrect a
      // previously-removed row (createMany(skipDuplicates) skips it, and we deliberately do NOT
      // clear its deletedAt). An admin's explicit removal survives an unrelated audience re-save;
      // the only ways back are the Restore action or an Excel roster re-upload naming the outlet.
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
          // Resurrect-on-re-upload: re-uploading a previously-removed outletRef brings the
          // roster row back (clears the soft-delete). A live row is unaffected (already null).
          deletedAt: null,
          updatedAt: new Date(),
        },
      }),
    );

    for (let i = 0; i < ops.length; i += SchemeAdminService.UPLOAD_CHUNK) {
      await this.prisma.$transaction(ops.slice(i, i + SchemeAdminService.UPLOAD_CHUNK));
    }

    // Rows that will actually show a BLANK outlet name in the report: no parsed name AND
    // not matched to a loyalty outlet. A MATCHED row is deliberately excluded — it recovers
    // the registered outlet's name from the master in the export, so warning on it would be
    // noise (and would fire every upload for teams whose names come from matching, not the
    // file). Surfaced so the upload UI warns AT UPLOAD TIME — before the operator sees the
    // blanks in the report — that a name column may be unmapped OR those name cells are empty.
    const blankNameCount = matched.rows.filter(
      (r) => (!r.outletName || !r.outletName.trim()) && !r.matchedOutletId,
    ).length;

    return {
      totalRows: rawRows.length,
      upserted: matched.rows.length,
      matchedCount: matched.matchedCount,
      standaloneCount: matched.standaloneCount,
      blankNameCount,
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

    // deletedAt: null → a soft-removed roster row is excluded (shared by findMany + count).
    const where: Prisma.SchemeOutletWhereInput = { schemeId, clientId: user.clientId, deletedAt: null };

    const [roster, total] = await Promise.all([
      this.prisma.schemeOutlet.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: {
          taggedSalesUser: { select: { employeeCode: true } },
          enrollment: { select: { id: true, status: true, currentVersion: true, deletedAt: true } },
        },
      }),
      this.prisma.schemeOutlet.count({ where }),
    ]);

    // A soft-deleted enrollment reads as no enrollment (the roster row shows NOT_ENROLLED),
    // so the outlet can be re-enrolled into the same row.
    const shaped = roster.map((r) => ({
      ...r,
      enrollment: r.enrollment && r.enrollment.deletedAt == null ? r.enrollment : null,
    }));

    return { roster: shaped, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ── Roster export (full xlsx download — no pagination) ─────────────────────

  /**
   * Stream the CURRENT roster as an xlsx (D-roster-view). Unlike getRoster this is
   * unpaginated — the whole roster in one file — so the admin can view/download it
   * long after the upload (the upload result was the only prior surface). Tenant-scoped
   * by (schemeId + clientId), ordered by createdAt asc to mirror the paginated list.
   *
   * Every row carries an IDENTICAL key set: buildXlsx derives the header row from the
   * FIRST row's keys, so a fixed base-column set + the UNION of all prefillValues keys
   * (missing keys filled with '') guarantees no column is silently dropped. An empty
   * roster still emits a header-only sheet (one all-'' base row) rather than 404, so the
   * admin always gets a well-formed (possibly empty) file.
   */
  async getRosterExport(user: JwtPayload, schemeId: string): Promise<StreamableFile> {
    const scheme = await this.assertSchemeOwnership(user, schemeId);

    const roster = await this.prisma.schemeOutlet.findMany({
      // A soft-removed roster row is excluded from the export.
      where: { schemeId, clientId: user.clientId, deletedAt: null },
      include: {
        matchedOutlet: { select: { outletCode: true } },
        taggedSalesUser: { select: { employeeCode: true } },
        enrollment: { select: { status: true, currentVersion: true, enrolledAt: true, deletedAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // UNION of every row's prefill-variable columns, so every row gets an identical
    // column set regardless of which prefill keys it individually carries.
    const prefillKeys = new Set<string>();
    for (const r of roster) {
      const pv = r.prefillValues as Record<string, unknown> | null;
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        for (const k of Object.keys(pv)) prefillKeys.add(k);
      }
    }
    // Exclude any prefill key that collides with a fixed base-column header, so an
    // uploaded variable column literally named e.g. "Version" or "Outlet ID" can never
    // clobber the base column's value in the export (audit LOW — base column wins).
    const RESERVED_EXPORT_COLS = new Set([
      'Outlet ID', 'Outlet Name', 'Linkage', 'Matched Outlet Code',
      'Tagged Employee', 'Enrollment Status', 'Version', 'Enrolled At',
    ]);
    const prefillCols = [...prefillKeys].filter((k) => !RESERVED_EXPORT_COLS.has(k));

    // The fixed base columns — always present so an empty roster still has a header row.
    const baseRow = (): Record<string, unknown> => ({
      'Outlet ID': '',
      'Outlet Name': '',
      Linkage: '',
      'Matched Outlet Code': '',
      'Tagged Employee': '',
      'Enrollment Status': '',
      Version: '',
      'Enrolled At': '',
      ...Object.fromEntries(prefillCols.map((k) => [k, ''])),
    });

    const rows: Record<string, unknown>[] = roster.map((r) => {
      const pv = (r.prefillValues as Record<string, unknown> | null) ?? {};
      const row = baseRow();
      // A soft-deleted enrollment reads as NOT_ENROLLED in the roster export.
      const enr = r.enrollment && r.enrollment.deletedAt == null ? r.enrollment : null;
      row['Outlet ID'] = r.outletRef;
      row['Outlet Name'] = r.outletName;
      row['Linkage'] = r.matchedOutletId ? 'Matched' : 'Standalone';
      row['Matched Outlet Code'] = r.matchedOutlet?.outletCode ?? '';
      row['Tagged Employee'] = r.taggedSalesUser?.employeeCode ?? '';
      row['Enrollment Status'] = enr?.status ?? 'NOT_ENROLLED';
      row['Version'] = enr?.currentVersion ?? '';
      row['Enrolled At'] = enr?.enrolledAt
        ? istDateKey(enr.enrolledAt)
        : '';
      for (const k of prefillCols) {
        const v = pv[k];
        row[k] = v === undefined || v === null ? '' : v;
      }
      return row;
    });

    // Empty roster → one all-'' base row so buildXlsx still emits a header-only sheet.
    if (rows.length === 0) rows.push(baseRow());

    const buffer = buildXlsx([{ name: 'Roster', rows }]);
    const filename = `scheme_${scheme.code ?? scheme.id}_roster_${new Date().toISOString().split('T')[0]}.xlsx`;

    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
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
      // Removed roster rows contribute no prefill columns to the form-builder dropdown.
      where: { schemeId, clientId: user.clientId, deletedAt: null },
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
    // The roster's own identity columns are consumed into outletRef/outletName (not stored
    // in prefillValues), but a DATA_DISPLAY/prefill field can still bind to them — the enroll
    // payloads inject them via withRosterIdentity. Offer them first in the dropdown.
    const variableCols = [...cols]
      .filter((c) => !ROSTER_IDENTITY_COLUMNS.includes(c as (typeof ROSTER_IDENTITY_COLUMNS)[number]))
      .sort((a, b) => a.localeCompare(b));
    return {
      excelColumns: [...ROSTER_IDENTITY_COLUMNS, ...variableCols],
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

  // ── Roster-row remove / restore (soft-delete, GIFSY-admin only) ────────────

  /**
   * Soft-remove roster rows (set `deletedAt`) so each disappears from EVERY read —
   * roster list/export, enrollment reach/visibility, reports, notify recipients, admin
   * enrollments, sales eligibility, prefill/facet pickers. Removing a row with a LIVE
   * enrollment is allowed and non-destructive: the enrollment is reached ONLY through the
   * row, so it is hidden and fully restored when the row is restored (we NEVER touch the
   * enrollment's own deletedAt — the single source of truth is SchemeOutlet.deletedAt).
   * Idempotent: an already-removed id falls out via `deletedAt: null` and counts as notFound.
   */
  async removeRoster(user: JwtPayload, schemeId: string, dto: RosterRemoveDto) {
    await this.assertSchemeOwnership(user, schemeId);
    // Dedup so a repeated id can't inflate `notFound` (updateMany counts each row once).
    const ids = [...new Set(dto.schemeOutletIds)];

    const { removed, removedWithEnrollment } = await this.softRemoveRosterByIds(
      user.clientId,
      schemeId,
      ids,
    );

    return {
      removed,
      removedWithEnrollment,
      notFound: ids.length - removed,
    };
  }

  /**
   * Shared soft-delete of roster rows by internal schemeOutlet id (the single source of
   * truth behind both `removeRoster` [ids] and `removeRosterByUpload` [Excel of refs]).
   *
   * Counts the live enrollments hidden by this removal FIRST (so the admin can be warned),
   * then stamps `deletedAt` on the not-yet-removed rows, chunked to stay well under any
   * statement/parameter limit at tenant scale. Every write is scoped to the caller's own
   * scheme/client + `deletedAt: null`, so it is idempotent and cannot touch another tenant.
   * `ids` MUST already be de-duplicated by the caller (the `removed` count is authoritative).
   */
  private async softRemoveRosterByIds(clientId: string, schemeId: string, ids: string[]) {
    if (ids.length === 0) return { removed: 0, removedWithEnrollment: 0 };

    // How many of the rows we are ABOUT to remove carry a live (non-deleted) enrollment —
    // scoped to the rows this call will actually remove (own scheme/client + not-yet-removed).
    const removedWithEnrollment = await this.prisma.schemeEnrollment.count({
      where: {
        deletedAt: null,
        schemeOutlet: { id: { in: ids }, schemeId, clientId, deletedAt: null },
      },
    });

    let removed = 0;
    const now = new Date();
    for (let i = 0; i < ids.length; i += SchemeAdminService.UPLOAD_CHUNK) {
      const res = await this.prisma.schemeOutlet.updateMany({
        where: {
          schemeId,
          clientId,
          id: { in: ids.slice(i, i + SchemeAdminService.UPLOAD_CHUNK) },
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
      removed += res.count;
    }

    return { removed, removedWithEnrollment };
  }

  // ── Bulk remove by Excel (upload a sheet of Outlet IDs to soft-remove) ──────
  //
  // Reuses the roster-upload parser (only the Outlet ID column is read; name / tagged /
  // prefill columns are ignored) and the shared soft-delete above. A `dryRun` returns a
  // resolve-only PREVIEW (no writes) so the admin can confirm the exact effect first.
  // Removal is recoverable via the existing "Show removed → Restore".
  //
  // Identity: match on `outletRef` (the same "Outlet ID" that built the roster, unique per
  // scheme). A ref with no LIVE roster row (never present, already removed, or another
  // scheme's) is reported as not-found — never a silent miss, never a cross-scheme reach.
  async removeRosterByUpload(
    user: JwtPayload,
    schemeId: string,
    file: Express.Multer.File,
    dto: RosterRemoveUploadDto,
  ) {
    await this.assertSchemeOwnership(user, schemeId);
    if (!file?.buffer) throw new BadRequestException('A .xlsx file of Outlet IDs is required.');

    // Distinct, order-preserving Outlet IDs from the sheet. Only the id column matters for
    // removal; the parser still needs a recognizable id header (else it throws → 400).
    let refs: string[];
    try {
      const rows = parseRosterUploadBuffer(file.buffer, { idColumn: dto.idColumn }).rows;
      refs = [...new Set(rows.map((r) => r.outletRef).filter((r): r is string => !!r))];
    } catch {
      throw new BadRequestException(
        'Invalid or corrupted xlsx file, or no recognizable Outlet ID column was found.',
      );
    }

    if (refs.length === 0) {
      throw new BadRequestException('The file contained no Outlet IDs to remove.');
    }

    // Resolve refs → LIVE roster rows for THIS scheme (deletedAt: null). Anything not here is
    // reported as not-found. Chunked to bound the IN() size at scale.
    const liveRows: { id: string; outletRef: string }[] = [];
    for (let i = 0; i < refs.length; i += SchemeAdminService.UPLOAD_CHUNK) {
      const chunk = await this.prisma.schemeOutlet.findMany({
        where: {
          schemeId,
          clientId: user.clientId,
          deletedAt: null,
          outletRef: { in: refs.slice(i, i + SchemeAdminService.UPLOAD_CHUNK) },
        },
        select: { id: true, outletRef: true },
      });
      liveRows.push(...chunk);
    }

    const foundRefs = new Set(liveRows.map((r) => r.outletRef));
    const notFoundRefs = refs.filter((r) => !foundRefs.has(r));
    const ids = liveRows.map((r) => r.id);

    // Safe default: preview UNLESS the caller explicitly asked to perform the removal
    // ('false'/'0'). An omitted/ambiguous value never triggers an unconfirmed destructive
    // write. (dryRun is a string by design — see RosterRemoveUploadDto.)
    const isDryRun = dto.dryRun !== 'false' && dto.dryRun !== '0';

    if (isDryRun) {
      // Preview only — no writes. Count live enrollments that WOULD be hidden.
      const withEnrollmentCount =
        ids.length === 0
          ? 0
          : await this.prisma.schemeEnrollment.count({
              where: {
                deletedAt: null,
                schemeOutlet: { id: { in: ids }, schemeId, clientId: user.clientId, deletedAt: null },
              },
            });
      return {
        dryRun: true as const,
        totalRefs: refs.length,
        willRemove: ids.length,
        withEnrollmentCount,
        notFoundCount: notFoundRefs.length,
        // Bound the payload — the exact count is always precise; the list is a sample for the UI.
        notFoundRefs: notFoundRefs.slice(0, 500),
      };
    }

    const { removed, removedWithEnrollment } = await this.softRemoveRosterByIds(
      user.clientId,
      schemeId,
      ids,
    );

    return {
      dryRun: false as const,
      totalRefs: refs.length,
      removed,
      removedWithEnrollment,
      notFoundCount: notFoundRefs.length,
      notFoundRefs: notFoundRefs.slice(0, 500),
    };
  }

  /**
   * Restore soft-removed roster rows (clear `deletedAt`) — the recovery path behind the
   * "Show removed / Restore" panel. Only rows currently removed are restored; a live id
   * falls out via `deletedAt: { not: null }` and counts as notFound. Idempotent.
   */
  async restoreRoster(user: JwtPayload, schemeId: string, dto: RosterRemoveDto) {
    await this.assertSchemeOwnership(user, schemeId);
    // Dedup so a repeated id can't inflate `notFound` (updateMany counts each row once).
    const ids = [...new Set(dto.schemeOutletIds)];

    const res = await this.prisma.schemeOutlet.updateMany({
      where: { schemeId, clientId: user.clientId, id: { in: ids }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    return { restored: res.count, notFound: ids.length - res.count };
  }

  // ── Removed-roster listing (paginated — the restore panel) ─────────────────

  /**
   * Paginated list of soft-removed roster rows (deletedAt != null) for the restore panel.
   * Same shape as getRoster (roster[] + pagination), but every row is a removed one and
   * carries its `deletedAt` (when it was removed). Kept as a dedicated read so a removed
   * row can never leak into the normal roster list.
   */
  async getRemovedRoster(user: JwtPayload, schemeId: string, q: RosterQueryDto) {
    await this.assertSchemeOwnership(user, schemeId);

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.SchemeOutletWhereInput = {
      schemeId,
      clientId: user.clientId,
      deletedAt: { not: null },
    };

    const [roster, total] = await Promise.all([
      this.prisma.schemeOutlet.findMany({
        where,
        skip,
        take: limit,
        orderBy: { deletedAt: 'desc' },
        include: {
          taggedSalesUser: { select: { employeeCode: true } },
          enrollment: { select: { id: true, status: true, currentVersion: true, deletedAt: true } },
        },
      }),
      this.prisma.schemeOutlet.count({ where }),
    ]);

    // A soft-deleted enrollment reads as no enrollment (mirrors getRoster), so a removed
    // row that had a live enrollment still surfaces its status in the restore panel.
    const shaped = roster.map((r) => ({
      ...r,
      enrollment: r.enrollment && r.enrollment.deletedAt == null ? r.enrollment : null,
    }));

    return { roster: shaped, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
}
