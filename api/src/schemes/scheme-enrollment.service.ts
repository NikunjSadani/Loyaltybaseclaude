import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { descendantSalesUserIds, SalesUserEdge } from '../sales/sales-hierarchy-access.helper';
import { generateNumericOtp } from '../common/otp';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { sniffFileType } from '../common/file-signature';
import {
  EnrollmentFormSchema,
  FormField,
  applyPrefillPins,
  collectOutletFieldKeys,
  evaluateVisibleWhen,
  pickBoundOutletFields,
  pickBoundPrefill,
  validateSubmittedValues,
  withRosterIdentity,
} from './enrollment-form.helper';
import {
  AdminListEnrollmentsQueryDto,
  EnrollDto,
  EnrollmentMode,
  RejectEnrollmentDto,
  ResubmitEnrollmentDto,
  SalesTargetsQueryDto,
  SendEnrollOtpDto,
  VerifyEnrollOtpDto,
} from './dto/scheme-enrollment.dto';

/** OtpPurpose value added in this wave (schema.prisma edit — orchestrator regenerates). */
const SCHEME_OTP_PURPOSE = 'SCHEME_ENROLL_CONSENT' as const;
/** How long a verified enroll-consent OTP stays usable for the subsequent submit. */
const OTP_VERIFY_WINDOW_MS = 15 * 60 * 1000;
/** Media types allowed to render inline; anything else is forced to a download. */
const INLINE_SAFE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

interface AudienceFilter {
  outletTypeIds?: string[];
  programNames?: string[];
  programCategories?: string[];
  zones?: string[];
  states?: string[];
  kycApprovedOnly?: boolean;
}
interface AudienceConfig {
  mode: 'FILTER' | 'EXCEL';
  selfEnrollAllowed: boolean;
  frozen: boolean;
  /** Admin-set per-scheme flag: an enroller may edit a live SUBMITTED enrollment (default false). */
  allowEnrollerEdit: boolean;
  filter?: AudienceFilter;
}

type RosterRow = Prisma.SchemeOutletGetPayload<Record<string, never>>;

/** One reachable SALES target for a scheme (a roster row, or a live-rule subtree outlet). */
export interface SalesTargetRow {
  /** Set for a materialized roster row; null for a live-rule outlet (server lazy-creates on enroll). */
  schemeOutletId: string | null;
  /** Set for a live-rule outlet (the `Outlet.id` to pass as `targetOutletRef`); null for a roster row. */
  targetOutletRef: string | null;
  outletRef: string;
  outletName: string;
  matched: boolean;
  standalone: boolean;
  status: 'NOT_ENROLLED' | 'SUBMITTED' | 'REJECTED';
  rejectionReason: string | null;
  enrollmentId: string | null;
  currentVersion: number | null;
  /** Excel prefill variables for a materialized roster row (D13); null for a live-rule outlet (no row yet). */
  prefillValues: Record<string, string> | null;
  /** Outlet-master field values for a MATCHED row, projected to the form's bound outlet fields (dual-source, D13); null otherwise. */
  outletFieldValues: Record<string, string> | null;
  /** True when the matched outlet's owner is KYC-approved (renderer pre-pins the owner phone). */
  outletApproved: boolean;
  /** Masked on-file owner phone for a KYC-approved matched outlet (renderer pre-pin hint); null otherwise. */
  ownerPhoneMasked: string | null;
}

/**
 * Scheme Data-Collection — enrollment engine (Wave-0/W1).
 *
 * Supersedes the partner-keyed `SchemesService.submitEnrollment` path with the
 * roster-anchored model (§9–§13): every submission anchors to a `SchemeOutlet`
 * roster row (matched or standalone), a `SchemeEnrollment` holds the CURRENT state
 * (1:1 on `schemeOutletId`), and every submit/resubmit APPENDS an immutable
 * `SchemeSubmission` version (D10/D11). Live on submit (no approval gate); admin can
 * REJECT-with-reason; the outlet/rep resubmits the whole form → a new version supersedes.
 *
 * Reuse (per §12): consent-OTP shape (bound OtpCode.referenceId), magic-byte media
 * guard + auth-gated stream, `resolveActivePartnerId` (login-picker sibling), and the
 * sales-downline reach model.
 */
@Injectable()
export class SchemeEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly msg91: Msg91Service,
  ) {}

  private isGifsyAdmin(user: JwtPayload): boolean {
    return user.role === 'GIFSY_ADMIN';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scheme / audience helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Tenant filter — a GIFSY_ADMIN is the cross-tenant operator; everyone else is pinned. */
  private schemeTenant(user: JwtPayload): { clientId?: string } {
    // platformWide (un-assumed GIFSY) → all tenants; an ASSUMED operator is pinned to
    // the assumed tenant (cross-tenant read boundary). WRITE gates still use isGifsyAdmin.
    return platformWide(user) ? {} : { clientId: user.clientId };
  }

  /** Load a non-deleted scheme in the caller's tenant. */
  private async loadScheme(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...this.schemeTenant(user) },
    });
    if (!scheme || scheme.deletedAt !== null) throw new NotFoundException('Scheme not found.');
    return scheme;
  }

  /** Load a non-deleted scheme + its current enrollment form (statically typed with the relation). */
  private async loadSchemeWithForm(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...this.schemeTenant(user) },
      include: { enrollmentForm: true },
    });
    if (!scheme || scheme.deletedAt !== null) throw new NotFoundException('Scheme not found.');
    return scheme;
  }

  private assertSchemeOpen(scheme: { status: string; startDate: Date; endDate: Date }): void {
    if (scheme.status !== 'ACTIVE') {
      throw new BadRequestException(`Scheme is not accepting enrollments (status: ${scheme.status}).`);
    }
    const now = new Date();
    if (now < scheme.startDate || now > scheme.endDate) {
      throw new BadRequestException('Scheme is outside its active enrollment period.');
    }
  }

  private parseAudience(scheme: { audienceConfig: Prisma.JsonValue | null }): AudienceConfig | null {
    const raw = scheme.audienceConfig as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const cfg = raw as Partial<AudienceConfig>;
    if (cfg.mode !== 'FILTER' && cfg.mode !== 'EXCEL') return null;
    return {
      mode: cfg.mode,
      selfEnrollAllowed: cfg.selfEnrollAllowed === true,
      frozen: cfg.frozen === true,
      allowEnrollerEdit: cfg.allowEnrollerEdit === true,
      filter: cfg.filter,
    };
  }

  /** Does a matched outlet satisfy a FILTER-mode audience (D17)? Inclusions only. */
  private outletMatchesFilter(
    outlet: {
      outletTypeId: string | null;
      programName: string | null;
      programCategory: string | null;
      zone: string | null;
      state: string | null;
    },
    filter?: AudienceFilter,
  ): boolean {
    if (!filter) return true;
    const inList = (val: string | null, list?: string[]) =>
      !list || list.length === 0 || (val != null && list.includes(val));
    return (
      inList(outlet.outletTypeId, filter.outletTypeIds) &&
      inList(outlet.programName, filter.programNames) &&
      inList(outlet.programCategory, filter.programCategories) &&
      inList(outlet.zone, filter.zones) &&
      inList(outlet.state, filter.states)
    );
  }

  /** Latest-KYC-approved for a matched partner (keyed by partnerId → works for login-less siblings). */
  private async isPartnerKycApproved(clientId: string, partnerId: string): Promise<boolean> {
    const p = await this.prisma.channelPartner.findFirst({
      where: { id: partnerId, clientId },
      select: { kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    });
    return p?.kycSubmissions?.[0]?.status === 'APPROVED';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dual-source prefill (D13) — Outlet-master field values for a MATCHED row
  // ───────────────────────────────────────────────────────────────────────────

  /** Prisma `select` for the outlet-native columns the outlet-field catalog can expose. */
  private static readonly OUTLET_FIELD_SELECT = {
    outletCode: true, name: true, addressLine1: true, addressLine2: true,
    city: true, state: true, pincode: true, zone: true, programName: true,
    programCategory: true, ownerName: true, phone: true,
  } as const;

  /** Prisma `select` for the partner columns the outlet-field catalog can expose. */
  private static readonly PARTNER_FIELD_SELECT = {
    businessName: true, ownerName: true, phone: true, panNumber: true, gstNumber: true,
  } as const;

  /**
   * Build the FULL Outlet-master field map (catalog key → value) for a matched roster
   * row, merging the Outlet record (outlet-native fields) with its ChannelPartner
   * (owner fields). Outlet values win for the two overlapping keys (ownerName/phone),
   * falling back to the partner. Empty/null values are omitted. Pure once the records
   * are loaded — the caller projects it to the form's bound outlet fields.
   */
  private buildOutletFieldMap(
    outlet: Record<string, unknown> | null,
    partner: Record<string, unknown> | null,
  ): Record<string, string> {
    const m: Record<string, string> = {};
    const put = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && String(v) !== '') m[k] = String(v);
    };
    if (outlet) {
      put('outletCode', outlet.outletCode);
      put('outletName', outlet.name);
      put('addressLine1', outlet.addressLine1);
      put('addressLine2', outlet.addressLine2);
      put('city', outlet.city);
      put('state', outlet.state);
      put('pincode', outlet.pincode);
      put('zone', outlet.zone);
      put('programName', outlet.programName);
      put('programCategory', outlet.programCategory);
      put('ownerName', outlet.ownerName);
      put('phone', outlet.phone);
    }
    if (partner) {
      if (!m.ownerName) put('ownerName', partner.ownerName);
      if (!m.phone) put('phone', partner.phone);
      put('businessName', partner.businessName);
      put('panNumber', partner.panNumber);
      put('gstNumber', partner.gstNumber);
    }
    return m;
  }

  /**
   * Resolve the projected outlet-field values + KYC-approved owner-phone hints for a
   * matched roster row — batched by outletId/partnerId so a many-row listing loads each
   * outlet/partner once. Returns per-row: the outlet-field map projected to the form's
   * bound `outletField`s (null when none bound / standalone), and, for a KYC-approved
   * owner, the masked on-file phone (renderer pre-pin). No queries when the form binds
   * no outlet fields AND we don't need approval hints.
   */
  private async loadOutletFieldContext(
    clientId: string,
    rows: { matchedOutletId: string | null; matchedPartnerId: string | null }[],
    formSchema: unknown,
    needApprovalHint = true,
  ): Promise<
    Map<string, { outletFieldValues: Record<string, string> | null; outletApproved: boolean; ownerPhoneMasked: string | null }>
  > {
    const result = new Map<
      string,
      { outletFieldValues: Record<string, string> | null; outletApproved: boolean; ownerPhoneMasked: string | null }
    >();
    const bindsOutletFields = collectOutletFieldKeys(formSchema).size > 0;

    const outletIds = [...new Set(rows.map((r) => r.matchedOutletId).filter((v): v is string => Boolean(v)))];
    const partnerIds = [...new Set(rows.map((r) => r.matchedPartnerId).filter((v): v is string => Boolean(v)))];

    const outletsById = new Map<string, Record<string, unknown>>();
    if (bindsOutletFields && outletIds.length > 0) {
      const outlets = await this.prisma.outlet.findMany({
        where: { id: { in: outletIds }, clientId },
        select: { id: true, ...SchemeEnrollmentService.OUTLET_FIELD_SELECT },
      });
      for (const o of outlets) outletsById.set(o.id, o as Record<string, unknown>);
    }

    // Partners are needed for the outlet-field owner columns (only when the form binds
    // outlet fields) AND the KYC-approval pre-pin hint (only for the enrollee payloads).
    // submit() needs neither → passes needApprovalHint=false → zero extra queries when the
    // form binds no outlet fields.
    const partnersById = new Map<string, { fields: Record<string, unknown>; approved: boolean; phone: string | null }>();
    if ((bindsOutletFields || needApprovalHint) && partnerIds.length > 0) {
      const partners = await this.prisma.channelPartner.findMany({
        where: { id: { in: partnerIds }, clientId },
        select: {
          id: true,
          ...SchemeEnrollmentService.PARTNER_FIELD_SELECT,
          kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
        },
      });
      for (const p of partners) {
        partnersById.set(p.id, {
          fields: p as Record<string, unknown>,
          approved: p.kycSubmissions?.[0]?.status === 'APPROVED',
          phone: p.phone ?? null,
        });
      }
    }

    for (const r of rows) {
      const outlet = r.matchedOutletId ? outletsById.get(r.matchedOutletId) ?? null : null;
      const partnerRec = r.matchedPartnerId ? partnersById.get(r.matchedPartnerId) ?? null : null;
      const outletFieldValues = bindsOutletFields
        ? pickBoundOutletFields(this.buildOutletFieldMap(outlet, partnerRec?.fields ?? null), formSchema)
        : null;
      const approved = partnerRec?.approved ?? false;
      const onFile = this.phoneLast10(partnerRec?.phone);
      const ownerPhoneMasked = approved && onFile.length === 10 ? `******${onFile.slice(-4)}` : null;
      // Key by outletId then partnerId (matched rows always have one); fall back to a blank.
      const key = r.matchedOutletId ?? r.matchedPartnerId ?? '';
      result.set(key, { outletFieldValues, outletApproved: approved, ownerPhoneMasked });
    }
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Roster resolution — the enrollment SUBJECT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve (and, for a live-rule Mode-A scheme, lazily create) the `SchemeOutlet`
   * roster row that a SELF/SALES caller may enroll — after full authorization:
   *   SELF  — the active partner (own or an authorized login-less sibling); the row
   *           must be MATCHED to that partner (self-enroll only for real outlets, D19).
   *   SALES — the caller must reach the row: a tagged employee in the caller's downline,
   *           OR an active assignment OR[partnerId, outletId] to the matched outlet.
   *
   * Also enforces audience (FILTER match / EXCEL roster membership) + selfEnrollAllowed.
   */
  private async resolveRoster(
    user: JwtPayload,
    scheme: { id: string; clientId: string; audienceConfig: Prisma.JsonValue | null },
    mode: EnrollmentMode,
    dto: { targetSchemeOutletId?: string; targetOutletRef?: string },
    requestedPartnerId?: string,
  ): Promise<RosterRow> {
    const audience = this.parseAudience(scheme);

    // ── Existing roster row (Excel Mode B, frozen snapshot, or prior lazy-create) ──
    if (dto.targetSchemeOutletId) {
      const row = await this.prisma.schemeOutlet.findFirst({
        where: { id: dto.targetSchemeOutletId, schemeId: scheme.id, clientId: scheme.clientId },
      });
      if (!row) throw new NotFoundException('Roster row not found for this scheme.');
      await this.authorizeRoster(user, scheme, audience, mode, row, requestedPartnerId);
      return row;
    }

    // ── Lazy-create (Mode-A live-rule) — a matched outlet only ──────────────────
    if (audience && audience.frozen) {
      // A frozen snapshot / Excel roster is a closed set — no lazy rows.
      throw new BadRequestException('This scheme has a fixed roster; targetSchemeOutletId is required.');
    }

    const { outlet, partnerId } = await this.resolveLazyOutlet(user, scheme, mode, dto, requestedPartnerId);

    // Audience: FILTER match (live-rule) — an outlet outside the filter is not enrollable.
    if (audience?.mode === 'FILTER') {
      if (!this.outletMatchesFilter(outlet, audience.filter)) {
        throw new ForbiddenException('This outlet is not in the scheme audience.');
      }
      if (audience.filter?.kycApprovedOnly && partnerId) {
        if (!(await this.isPartnerKycApproved(scheme.clientId, partnerId))) {
          throw new ForbiddenException('This scheme is restricted to KYC-approved outlets.');
        }
      }
    }

    // Self-enroll gate (D21) — matched real outlets only.
    if (mode === 'SELF' && audience && !audience.selfEnrollAllowed) {
      throw new ForbiddenException('Self-enrollment is not enabled for this scheme.');
    }

    // Find-or-create the roster row (idempotent on the [schemeId, outletRef] unique).
    return this.prisma.schemeOutlet.upsert({
      where: { schemeId_outletRef: { schemeId: scheme.id, outletRef: outlet.id } },
      update: {},
      create: {
        clientId: scheme.clientId,
        schemeId: scheme.id,
        outletRef: outlet.id,
        outletName: outlet.name,
        matchedOutletId: outlet.id,
        matchedPartnerId: partnerId,
      },
    });
  }

  /** Resolve the outlet + owner partner for a lazy (live-rule) enroll, with reach auth. */
  private async resolveLazyOutlet(
    user: JwtPayload,
    scheme: { clientId: string },
    mode: EnrollmentMode,
    dto: { targetOutletRef?: string },
    requestedPartnerId?: string,
  ): Promise<{
    outlet: {
      id: string;
      name: string;
      partnerId: string | null;
      outletTypeId: string | null;
      programName: string | null;
      programCategory: string | null;
      zone: string | null;
      state: string | null;
    };
    partnerId: string | null;
  }> {
    if (mode === 'SELF') {
      const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
        clientId: user.clientId,
        userSub: user.sub,
        phone: user.phone,
        requestedPartnerId,
      });
      if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
      if (!partnerId) {
        throw new ForbiddenException('No ChannelPartner record found for your account in this tenant.');
      }
      // The active partner's own outlet (self-enroll = matched real outlet, D19).
      const outlets = await this.prisma.outlet.findMany({
        where: { partnerId, clientId: user.clientId, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true, name: true, partnerId: true, outletTypeId: true,
          programName: true, programCategory: true, zone: true, state: true,
        },
      });
      const chosen = dto.targetOutletRef
        ? outlets.find((o) => o.id === dto.targetOutletRef)
        : outlets[0];
      if (!chosen) throw new NotFoundException('No outlet found for your account to enroll.');
      return { outlet: chosen, partnerId };
    }

    // SALES — a matched tenant outlet in the caller's reach.
    if (!dto.targetOutletRef) {
      throw new BadRequestException('targetOutletRef (or targetSchemeOutletId) is required for SALES enrollment.');
    }
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: dto.targetOutletRef, clientId: scheme.clientId, deletedAt: null },
      select: {
        id: true, name: true, partnerId: true, outletTypeId: true,
        programName: true, programCategory: true, zone: true, state: true,
      },
    });
    if (!outlet) throw new NotFoundException('Target outlet not found in this tenant.');
    await this.assertSalesReachOutlet(user, outlet.id, outlet.partnerId);
    return { outlet, partnerId: outlet.partnerId };
  }

  /** Authorize a SELF/SALES caller against an EXISTING roster row. */
  private async authorizeRoster(
    user: JwtPayload,
    scheme: { clientId: string },
    audience: AudienceConfig | null,
    mode: EnrollmentMode,
    row: RosterRow,
    requestedPartnerId?: string,
  ): Promise<void> {
    if (mode === 'SELF') {
      if (!row.matchedPartnerId) {
        // Standalone rows are rep-filled only (D19) — no self-enroll.
        throw new ForbiddenException('This roster row cannot be self-enrolled.');
      }
      const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
        clientId: user.clientId,
        userSub: user.sub,
        phone: user.phone,
        requestedPartnerId,
      });
      if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
      if (!partnerId || partnerId !== row.matchedPartnerId) {
        throw new ForbiddenException('This roster row belongs to a different outlet.');
      }
      if (audience && !audience.selfEnrollAllowed) {
        throw new ForbiddenException('Self-enrollment is not enabled for this scheme.');
      }
      return;
    }

    // SALES — tagged-downline OR assignment reach.
    await this.assertSalesReachRoster(user, row);
  }

  /**
   * SALES reach for a roster row: the tagged employee is in the caller's downline, OR the
   * matched outlet/partner is assigned to ANYONE in the caller's downline (not just the
   * caller directly). This MUST mirror `getSalesTargets` (which surfaces the row) and
   * `assertSalesReachOutlet` — otherwise a target that appears in the rep's task window is
   * rejected at OTP/enroll with "not within your team" (a manager reaching a junior-assigned
   * roster row was wrongly blocked; the assignment branch only checked the caller's own
   * direct assignment).
   */
  private async assertSalesReachRoster(user: JwtPayload, row: RosterRow): Promise<void> {
    const caller = await this.requireCallerSalesUser(user);
    const edges = await this.loadSalesEdges(user.clientId);
    const reach = descendantSalesUserIds(caller.id, edges); // caller + whole downline

    // Tagged employee somewhere in the caller's downline.
    if (row.taggedSalesUserId && reach.has(row.taggedSalesUserId)) return;

    // OR the matched outlet/partner is actively assigned to anyone in the caller's downline.
    const or: Prisma.SalesUserAssignmentWhereInput[] = [];
    if (row.matchedOutletId) or.push({ outletId: row.matchedOutletId });
    if (row.matchedPartnerId) or.push({ partnerId: row.matchedPartnerId });
    if (or.length > 0) {
      const assignment = await this.prisma.salesUserAssignment.findFirst({
        where: { unassignedAt: null, salesUserId: { in: [...reach] }, OR: or },
        select: { id: true },
      });
      if (assignment) return;
    }

    throw new ForbiddenException('This outlet is not within your team.');
  }

  /** SALES reach for a not-yet-rostered outlet (live-rule): assignment or the outlet's assigned rep in the downline. */
  private async assertSalesReachOutlet(
    user: JwtPayload,
    outletId: string,
    partnerId: string | null,
  ): Promise<void> {
    const caller = await this.requireCallerSalesUser(user);
    if (await this.hasActiveAssignment(caller.id, partnerId, outletId)) return;

    // Fallback (D17 reach): the outlet's own assigned rep + up-hierarchy.
    const assignment = await this.prisma.salesUserAssignment.findFirst({
      where: {
        unassignedAt: null,
        OR: [{ outletId }, ...(partnerId ? [{ partnerId }] : [])],
      },
      select: { salesUserId: true },
    });
    if (assignment) {
      const edges = await this.loadSalesEdges(user.clientId);
      if (descendantSalesUserIds(caller.id, edges).has(assignment.salesUserId)) return;
    }
    throw new ForbiddenException('This outlet is not within your team.');
  }

  private async requireCallerSalesUser(user: JwtPayload) {
    const caller = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!caller) {
      throw new ForbiddenException('Only sales users may enroll on behalf of an outlet (SALES mode).');
    }
    return caller;
  }

  private async loadSalesEdges(clientId: string): Promise<SalesUserEdge[]> {
    return this.prisma.salesUser.findMany({
      where: { clientId, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
  }

  private async hasActiveAssignment(
    salesUserId: string,
    partnerId: string | null,
    outletId: string | null,
  ): Promise<boolean> {
    const or: Prisma.SalesUserAssignmentWhereInput[] = [];
    if (partnerId) or.push({ partnerId });
    if (outletId) or.push({ outletId });
    if (or.length === 0) return false;
    const a = await this.prisma.salesUserAssignment.findFirst({
      where: { salesUserId, unassignedAt: null, OR: or },
      select: { id: true },
    });
    return Boolean(a);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phone-OTP consent (D16) — bound OtpCode.referenceId = schemeOutletId
  // ───────────────────────────────────────────────────────────────────────────

  private phoneLast10(raw: string | null | undefined): string {
    return (raw ?? '').replace(/\D/g, '').slice(-10);
  }

  private phoneOtpField(form: { formSchema: Prisma.JsonValue } | null): FormField | null {
    if (!form) return null;
    const schema = form.formSchema as unknown as EnrollmentFormSchema;
    return (schema.fields ?? []).find((f) => f.type === 'PHONE_OTP' && f.otpRequired) ?? null;
  }

  /**
   * Resolve the consent-OTP target for a roster row (D16). Precedence:
   *   1. KYC-APPROVED matched outlet with a verified owner number on file → PINNED to
   *      the owner's number (locked). This ALWAYS wins — even when the phone-OTP field
   *      is bound to a roster column — the on-file approved number is the owner decision.
   *   2. Else, a LOCKED phone-OTP field bound to a non-empty roster column
   *      (`prefillValues[prefillKey]`) → server-authoritative Excel number (locked); the
   *      client-sent `typedMobile` is IGNORED (a rep cannot substitute a different one).
   *   3. Else → the typed number (editable, locked:false — unchanged behaviour).
   *
   * A locked column that carries no value (missing/blank) is NOT forced (graceful
   * fall-back to editable); a locked column that carries a non-10-digit value is an
   * admin mis-config and surfaces a clear error.
   */
  private async resolveOtpTarget(
    clientId: string,
    row: RosterRow,
    typedMobile?: string,
    otpField?: FormField | null,
  ): Promise<{ phone: string; locked: boolean }> {
    // (1) Approved-matched on-file number — always wins.
    if (row.matchedPartnerId) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { id: row.matchedPartnerId, clientId },
        select: {
          phone: true,
          kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
        },
      });
      const approved = partner?.kycSubmissions?.[0]?.status === 'APPROVED';
      const onFile = this.phoneLast10(partner?.phone);
      if (approved && onFile.length === 10) {
        return { phone: onFile, locked: true }; // consent guarantee — cannot be redirected
      }
    }

    // (2) Locked phone-OTP field bound to a roster column → the Excel number is authoritative.
    if (otpField?.locked === true && otpField.prefillKey) {
      const prefill = (row.prefillValues ?? null) as Record<string, string> | null;
      const rosterRaw = prefill && typeof prefill === 'object' ? prefill[otpField.prefillKey] : undefined;
      if (typeof rosterRaw === 'string' && rosterRaw !== '') {
        const rosterPhone = this.phoneLast10(rosterRaw);
        if (rosterPhone.length === 10) {
          return { phone: rosterPhone, locked: true }; // server-authoritative — typed number ignored
        }
        throw new BadRequestException(
          'The roster phone number for this outlet is not a valid 10-digit mobile.',
        );
      }
      // Roster has no value for the locked column → fall through to the typed number.
    }

    // (3) Editable — the typed number.
    const typed = this.phoneLast10(typedMobile);
    if (typed.length !== 10) {
      throw new BadRequestException('Enter a valid 10-digit mobile number for OTP.');
    }
    return { phone: typed, locked: false };
  }

  async sendEnrollOtp(user: JwtPayload, schemeId: string, dto: SendEnrollOtpDto, requestedPartnerId?: string) {
    const mode = dto.enrollmentMode ?? 'SELF';
    const scheme = await this.loadSchemeWithForm(user, schemeId);
    this.assertSchemeOpen(scheme);
    const row = await this.resolveRoster(user, scheme, mode, dto, requestedPartnerId);

    const otpField = this.phoneOtpField(scheme.enrollmentForm);
    const { phone, locked } = await this.resolveOtpTarget(user.clientId, row, dto.mobile, otpField);
    const otp = generateNumericOtp();

    // One active OTP per (phone, purpose, roster row) — the referenceId binding keeps
    // concurrent outlets from consuming each other's OTP (redemption pattern, §12).
    await this.prisma.otpCode.deleteMany({
      where: { phone, purpose: SCHEME_OTP_PURPOSE, referenceId: row.id, verifiedAt: null },
    });
    await this.prisma.otpCode.create({
      data: {
        phone,
        code: otp,
        purpose: SCHEME_OTP_PURPOSE,
        referenceId: row.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        maxAttempts: 3,
      },
    });
    // Real send in prod; no-op under FIXED_OTP (msg91 handles it). Global template (undefined).
    await this.msg91.sendOtp(phone, otp, 'SMS');

    return {
      success: true,
      expiresIn: 600,
      locked,
      schemeOutletId: row.id,
      phoneMasked: `******${phone.slice(-4)}`,
    };
  }

  async verifyEnrollOtp(user: JwtPayload, schemeId: string, dto: VerifyEnrollOtpDto, requestedPartnerId?: string) {
    const mode = dto.enrollmentMode ?? 'SELF';
    const scheme = await this.loadSchemeWithForm(user, schemeId);
    const row = await this.resolveRoster(user, scheme, mode, dto, requestedPartnerId);
    const otpField = this.phoneOtpField(scheme.enrollmentForm);
    const { phone } = await this.resolveOtpTarget(user.clientId, row, dto.mobile, otpField);

    const rec = await this.prisma.otpCode.findFirst({
      where: {
        phone,
        purpose: SCHEME_OTP_PURPOSE,
        referenceId: row.id,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec) throw new HttpException('OTP not found or expired', HttpStatus.UNAUTHORIZED);
    if (rec.attempts >= rec.maxAttempts) {
      throw new HttpException('OTP locked due to too many attempts. Request a new OTP.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const fixedOtp = isFixedOtpAllowed() ? process.env.FIXED_OTP : undefined;
    const matches = rec.code === dto.otp || (!!fixedOtp && dto.otp === fixedOtp);
    if (!matches) {
      await this.prisma.otpCode.update({ where: { id: rec.id }, data: { attempts: { increment: 1 } } });
      const remaining = rec.maxAttempts - rec.attempts - 1;
      throw new HttpException(`Invalid OTP. ${remaining} attempt(s) remaining.`, HttpStatus.UNAUTHORIZED);
    }
    await this.prisma.otpCode.update({ where: { id: rec.id }, data: { verifiedAt: new Date() } });
    return { verified: true, phone };
  }

  /** A recently-verified consent OTP exists for this roster row + phone (submit gate). */
  private async hasVerifiedOtp(rosterId: string, phone: string): Promise<boolean> {
    const rec = await this.prisma.otpCode.findFirst({
      where: {
        phone,
        purpose: SCHEME_OTP_PURPOSE,
        referenceId: rosterId,
        verifiedAt: { gt: new Date(Date.now() - OTP_VERIFY_WINDOW_MS) },
      },
      select: { id: true },
    });
    return Boolean(rec);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Enroll / resubmit — versioned, append-only (D10/D11)
  // ───────────────────────────────────────────────────────────────────────────

  async enroll(user: JwtPayload, schemeId: string, dto: EnrollDto, requestedPartnerId?: string) {
    const mode = dto.enrollmentMode ?? 'SELF';
    const scheme = await this.loadSchemeWithForm(user, schemeId);
    this.assertSchemeOpen(scheme);

    const row = await this.resolveRoster(user, scheme, mode, dto, requestedPartnerId);

    // Immutability (D10): a LIVE (deletedAt == null) SUBMITTED enrollment cannot be silently
    // overwritten — it is superseded only via reject → resubmit. A REJECTED enrollment
    // re-enrolls fresh. A SOFT-DELETED enrollment (deletedAt != null) is re-enrollable: the
    // SAME row is reset (submit() clears deletedAt + appends a new version), keeping the 1:1.
    const existing = await this.prisma.schemeEnrollment.findUnique({ where: { schemeOutletId: row.id } });
    if (existing && existing.status === 'SUBMITTED' && existing.deletedAt == null) {
      throw new BadRequestException('This outlet is already enrolled. Use resubmit after a rejection.');
    }

    return this.submit(user, scheme, row, mode, dto.formValues, dto.mobile, existing?.id ?? null);
  }

  async resubmit(
    user: JwtPayload,
    schemeId: string,
    enrollmentId: string,
    dto: ResubmitEnrollmentDto,
    requestedPartnerId?: string,
  ) {
    const scheme = await this.loadSchemeWithForm(user, schemeId);
    this.assertSchemeOpen(scheme);

    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      where: { id: enrollmentId, schemeId: scheme.id },
      include: { schemeOutlet: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');
    // A soft-deleted enrollment reads as absent — it is not an editable live enrollment.
    if (enrollment.deletedAt != null) throw new NotFoundException('Enrollment not found.');
    // Resubmit is the post-rejection correction path (D10). It ALSO doubles as the enroller
    // EDIT path for a live SUBMITTED enrollment — but only when the scheme's admin-set
    // audienceConfig.allowEnrollerEdit flag is on (otherwise a live submission is immutable
    // to the enroller and only an admin can edit it).
    const audience = this.parseAudience(scheme);
    if (enrollment.status === 'REJECTED') {
      // always allowed
    } else if (enrollment.status === 'SUBMITTED') {
      if (!audience?.allowEnrollerEdit) {
        throw new BadRequestException('Editing a submitted enrollment is not enabled for this scheme.');
      }
      // Owner-locked: enroller self-edit of a LIVE submission is a SELF (partner/outlet) correction
      // ONLY. A sales-assisted (SALES-mode) capture is corrected by a GIFSY admin, never re-edited by
      // a rep (the sales sheet re-opens with roster prefill only → blank-overwrite risk). authorizeRoster
      // already blocks a rep from a SELF-mode row (no partnerId), but this makes "SALES self-edit
      // disabled" a server-enforced invariant, not FE-only, closing the non-OTP SALES-mode hole.
      if (enrollment.enrollmentMode !== 'SELF') {
        throw new BadRequestException('Editing a submitted enrollment is not available in sales-assisted mode.');
      }
    } else {
      throw new BadRequestException('Only a rejected enrollment can be resubmitted.');
    }

    const mode = (enrollment.enrollmentMode as EnrollmentMode) ?? 'SELF';
    // Re-authorize the caller against the roster row before accepting a new version.
    await this.authorizeRoster(user, scheme, audience, mode, enrollment.schemeOutlet, requestedPartnerId);

    // A SUBMITTED-edit carries the original OTP consent forward (phone-OTP is read-only on the edit
    // form); a REJECTED resubmit is a fresh re-capture and re-collects consent (no carry-forward).
    const consentedEditFrom = enrollment.status === 'SUBMITTED' ? enrollment.formValues : null;
    return this.submit(
      user, scheme, enrollment.schemeOutlet, mode, dto.formValues, dto.mobile, enrollment.id, consentedEditFrom,
    );
  }

  /**
   * Shared validate → version → persist. Upserts the CURRENT SchemeEnrollment (1:1 on
   * schemeOutletId) and APPENDS an immutable SchemeSubmission version, keeping the §13.3
   * denormalization invariant (enrollment.schemeId == roster.schemeId; each submission's
   * {schemeId,schemeOutletId,enrollmentId} == its enrollment's).
   */
  private async submit(
    user: JwtPayload,
    scheme: { id: string; clientId: string; enrollmentForm?: { formSchema: Prisma.JsonValue; version: number } | null },
    row: RosterRow,
    mode: EnrollmentMode,
    submittedRaw: Record<string, unknown> | undefined,
    typedMobile: string | undefined,
    existingEnrollmentId: string | null,
    // Consent carry-forward (edit paths only): the prior version's persisted formValues. When
    // provided, a PHONE_OTP field reuses the already-verified number instead of demanding a
    // fresh OTP (see the OTP gate below). null on fresh enroll / rejection-resubmit / re-enroll.
    consentedEditFrom: Prisma.JsonValue | null = null,
  ) {
    // Invariant guard (defense-in-depth): the roster row must belong to this scheme.
    if (row.schemeId !== scheme.id) {
      throw new BadRequestException('Roster row does not belong to this scheme.');
    }

    const form = scheme.enrollmentForm ?? null;
    const formVersion = form?.version ?? 1;
    let finalFormValues: Record<string, unknown> | null = null;

    if (form) {
      const schema = form.formSchema as unknown as EnrollmentFormSchema;

      // Dual-source outlet-field values (D13) for a matched row — resolved server-side
      // from the outlet's OWN DB record so a LOCKED outlet-field is pinned to the source
      // of record (a rep/outlet can never substitute it), same guarantee as Excel pins.
      const outletCtx = await this.loadOutletFieldContext(
        scheme.clientId,
        [{ matchedOutletId: row.matchedOutletId, matchedPartnerId: row.matchedPartnerId }],
        schema,
        false, // submit needs only outletFieldValues, never the approval pre-pin hint
      );
      const boundOutletFields =
        outletCtx.get(row.matchedOutletId ?? row.matchedPartnerId ?? '')?.outletFieldValues ?? null;

      // Prefill pins (D13a): overwrite every LOCKED prefill field with its authoritative
      // source value (outlet-master field for a matched row, else the Excel roster column)
      // BEFORE validation, so required/type/option checks run against the pinned value and
      // it flows into finalFormValues below.
      const submitted = applyPrefillPins(
        schema,
        { ...(submittedRaw ?? {}) },
        (row.prefillValues ?? null) as unknown as Record<string, string> | null,
        boundOutletFields,
      );

      // PHONE-OTP consent gate (D16): pin the number + require a verified OTP.
      const otpField = this.phoneOtpField(form);
      if (otpField) {
        // Consent carry-forward (edit paths): an admin edit or an enroller edit of an already
        // SUBMITTED enrollment reuses the phone that was OTP-verified at the ORIGINAL capture.
        // The phone-OTP field is read-only on both edit forms, so the consented number cannot
        // change on an edit — re-collecting a fresh OTP for a data correction is neither possible
        // from those forms (no OTP step) nor meaningful (consent already given). This carries the
        // original consent forward rather than re-pinning to a now-different on-file number, so a
        // data edit never silently changes the consented phone. Fail-closed: if the prior version
        // has no valid phone on file (e.g. the form gained the OTP field AFTER this enrollment was
        // captured), fall through to the normal fresh-OTP gate — the edit is blocked, not bypassed.
        const carried = consentedEditFrom
          ? this.phoneLast10(String((consentedEditFrom as Record<string, unknown>)[otpField.id] ?? ''))
          : '';
        if (carried.length === 10) {
          submitted[otpField.id] = carried;
        } else {
          const { phone } = await this.resolveOtpTarget(scheme.clientId, row, typedMobile, otpField);
          if (!(await this.hasVerifiedOtp(row.id, phone))) {
            throw new ForbiddenException('Phone OTP not verified for this enrollment.');
          }
          // Server ALWAYS writes the verified (and, for approved outlets, PINNED) number —
          // the recorded phone-field value must equal the OTP-verified one, never whatever
          // the client typed into the field (A-MED-1).
          submitted[otpField.id] = phone;
        }
      }

      const { errors, recomputedValues, resolvedValues } = validateSubmittedValues(schema, submitted);
      if (errors.length > 0) {
        throw new BadRequestException(`Form validation failed: ${errors.join(' | ')}`);
      }
      // Server-owned values win: CALCULATED recompute + LOOKUP resolve overwrite client input.
      const merged = { ...submitted, ...recomputedValues, ...resolvedValues };
      // Project to ONLY the schema's field ids so arbitrary client-sent keys are never
      // persisted (A-LOW-6), AND drop fields that are NOT visible under the submitted
      // values so a conditionally-hidden field's stale value is never stored (B-MED-2).
      // Mirrors `validateSubmittedValues`: server-owned CALCULATED/LOOKUP fields are not
      // visibility-gated (their value is server-derived); every other field is dropped
      // when its `visibleWhen` clause evaluates false.
      const fieldById = new Map<string, FormField>((schema.fields ?? []).map((f) => [f.id, f]));
      const isPersistable = (fieldId: string): boolean => {
        const field = fieldById.get(fieldId);
        if (!field) return false;
        if (field.type === 'CALCULATED' || field.type === 'LOOKUP') return true;
        return evaluateVisibleWhen(field, submitted);
      };
      finalFormValues = Object.fromEntries(
        Object.entries(merged).filter(([k]) => isPersistable(k)),
      );
    }

    const submittedByUserId = await this.resolveSubmitter(user, mode, row);
    const now = new Date();
    const jsonValues = (finalFormValues ?? Prisma.JsonNull) as Prisma.InputJsonValue;

    try {
      return await this.prisma.$transaction(async (tx) => {
        let enrollment;
        let version: number;

        if (existingEnrollmentId) {
          const prev = await tx.schemeEnrollment.findUnique({ where: { id: existingEnrollmentId } });
          if (!prev) throw new NotFoundException('Enrollment not found.');
          version = prev.currentVersion + 1;
          enrollment = await tx.schemeEnrollment.update({
            where: { id: existingEnrollmentId },
            data: {
              status: 'SUBMITTED',
              enrollmentMode: mode,
              formValues: jsonValues,
              currentVersion: version,
              formVersion,
              rejectionReason: null,
              // Re-enroll / edit un-deletes the row (soft-delete reset) as well as un-rejecting it.
              deletedAt: null,
              submittedByUserId,
              enrolledAt: now,
              updatedAt: now,
            },
          });
        } else {
          version = 1;
          enrollment = await tx.schemeEnrollment.create({
            data: {
              schemeId: scheme.id,
              schemeOutletId: row.id,
              status: 'SUBMITTED',
              enrollmentMode: mode,
              formValues: jsonValues,
              currentVersion: 1,
              formVersion,
              submittedByUserId,
              enrolledAt: now,
            },
          });
        }

        // Append the immutable submission snapshot (invariant fields denormalized from enrollment).
        const submission = await tx.schemeSubmission.create({
          data: {
            schemeId: enrollment.schemeId,
            schemeOutletId: enrollment.schemeOutletId,
            enrollmentId: enrollment.id,
            version,
            status: 'SUBMITTED',
            formValues: (finalFormValues ?? {}) as Prisma.InputJsonValue,
            formVersion,
            enrollmentMode: mode,
            submittedByUserId,
          },
        });

        return { enrollment, submission };
      });
    } catch (e) {
      // Unique-violation (schemeOutletId 1:1, or the [enrollmentId, version] append) → a
      // concurrent enroll/resubmit raced this one. Surface a clean 409 rather than a raw
      // 500 (A-LOW-4).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'This outlet is already enrolled or a concurrent submission occurred — please retry.',
        );
      }
      throw e;
    }
  }

  /** Audit-only submitter (nullable for a login-less sibling / standalone rep target). */
  private async resolveSubmitter(user: JwtPayload, mode: EnrollmentMode, row: RosterRow): Promise<string | null> {
    // The performing login is always the caller (SELF or the rep in SALES). We store the
    // real caller id when it is a User row; null otherwise. `user.sub` is the user id.
    void mode;
    void row;
    return user.sub ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reject (GIFSY_ADMIN, D10)
  // ───────────────────────────────────────────────────────────────────────────

  async reject(user: JwtPayload, schemeId: string, enrollmentId: string, dto: RejectEnrollmentDto) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);
    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      where: { id: enrollmentId, schemeId: scheme.id },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');
    // A soft-deleted enrollment reads as absent — it cannot be rejected.
    if (enrollment.deletedAt != null) throw new NotFoundException('Enrollment not found.');

    // Status → REJECTED + reason, AND append an immutable REJECTED event to the submission
    // trail (D10). Without the appended row, a later resubmit (which nulls the live
    // enrollment's rejectionReason) erases every trace that this version was rejected and
    // why — the reviewer loses the audit trail. The event snapshots the rejected values +
    // preserves the reason permanently. `currentVersion` advances so the reject occupies a
    // distinct trail version (the [enrollmentId, version] unique) and the next resubmit
    // (`prev.currentVersion + 1`) continues past it without colliding.
    const rejectVersion = enrollment.currentVersion + 1;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.schemeEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: 'REJECTED',
            rejectionReason: dto.reason,
            currentVersion: rejectVersion,
            updatedAt: new Date(),
          },
        });
        const submission = await tx.schemeSubmission.create({
          data: {
            schemeId: enrollment.schemeId,
            schemeOutletId: enrollment.schemeOutletId,
            enrollmentId: enrollment.id,
            version: rejectVersion,
            status: 'REJECTED',
            formValues: (enrollment.formValues ?? {}) as Prisma.InputJsonValue,
            formVersion: enrollment.formVersion,
            enrollmentMode: enrollment.enrollmentMode,
            submittedByUserId: user.sub ?? null,
            rejectionReason: dto.reason,
          },
        });
        return { enrollment: updated, submission };
      });
    } catch (e) {
      // A concurrent double-reject (or a reject racing a resubmit) computes the same
      // [enrollmentId, version] → P2002. The tx rolls back atomically (no partial write);
      // surface a clean 409 rather than a raw 500 (mirrors submit()'s guard).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A concurrent update occurred — please retry.');
      }
      throw e;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admin edit / delete / restore (GIFSY_ADMIN)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Admin edit (GIFSY_ADMIN) — always allowed, from any live state (SUBMITTED or REJECTED).
   * Re-runs the SAME validate → version → persist path as resubmit (submit() with the
   * existing enrollment id), so it appends a new immutable SchemeSubmission version and
   * updates the live values. A soft-deleted enrollment is un-deleted by submit() (deletedAt
   * cleared) as a side effect — an admin editing a deleted row restores it, which is fine.
   */
  async adminEditEnrollment(
    user: JwtPayload,
    schemeId: string,
    enrollmentId: string,
    dto: ResubmitEnrollmentDto,
  ) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadSchemeWithForm(user, schemeId);

    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      where: { id: enrollmentId, schemeId: scheme.id },
      include: { schemeOutlet: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');

    const mode = (enrollment.enrollmentMode as EnrollmentMode) ?? 'SELF';
    // Admin edit reuses the enrollment's original OTP consent (a GIFSY operator cannot perform the
    // outlet's OTP, and the phone-OTP field is read-only on the admin edit form) — carry it forward.
    return this.submit(
      user, scheme, enrollment.schemeOutlet, mode, dto.formValues, dto.mobile, enrollment.id, enrollment.formValues,
    );
  }

  /**
   * Soft-delete (GIFSY_ADMIN) — set deletedAt so the enrollment reads as absent everywhere
   * (the outlet re-enrolls into the SAME row). Idempotent: deleting an already-deleted
   * enrollment is a no-op. History (SchemeSubmission rows) is always retained.
   */
  async deleteEnrollment(user: JwtPayload, schemeId: string, enrollmentId: string) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);
    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      where: { id: enrollmentId, schemeId: scheme.id },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');
    if (enrollment.deletedAt != null) {
      return { enrollment }; // already deleted — idempotent no-op
    }
    const updated = await this.prisma.schemeEnrollment.update({
      where: { id: enrollment.id },
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });
    return { enrollment: updated };
  }

  /**
   * Restore (GIFSY_ADMIN) — clear deletedAt on a soft-deleted enrollment so it reads as live
   * again (recovery path). Idempotent on an already-live enrollment.
   */
  async restoreEnrollment(user: JwtPayload, schemeId: string, enrollmentId: string) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);
    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      where: { id: enrollmentId, schemeId: scheme.id },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');
    if (enrollment.deletedAt == null) {
      return { enrollment }; // already live — idempotent no-op
    }
    const updated = await this.prisma.schemeEnrollment.update({
      where: { id: enrollment.id },
      data: { deletedAt: null, updatedAt: new Date() },
    });
    return { enrollment: updated };
  }

  /**
   * List soft-deleted enrollments (GIFSY_ADMIN) — the recovery view behind the admin list's
   * "Show deleted" toggle. Returns ONLY deletedAt != null rows with the outlet's identity + when
   * it was deleted, so each can be restored via restoreEnrollment. Kept as a dedicated read (never
   * folded into adminListEnrollments) so a soft-deleted row can never leak into the normal list.
   */
  async adminListDeletedEnrollments(user: JwtPayload, schemeId: string) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);
    const rows = await this.prisma.schemeEnrollment.findMany({
      where: { schemeId: scheme.id, deletedAt: { not: null } },
      include: {
        schemeOutlet: {
          select: {
            id: true, outletRef: true, outletName: true,
            matchedOutlet: { select: { name: true, outletCode: true } },
            matchedPartner: { select: { businessName: true } },
          },
        },
      },
      orderBy: { deletedAt: 'desc' },
    });
    return {
      enrollments: rows.map((r) => ({
        id: r.id,
        schemeOutletId: r.schemeOutletId,
        status: r.status,
        currentVersion: r.currentVersion,
        enrolledAt: r.enrolledAt,
        deletedAt: r.deletedAt,
        outletRef: r.schemeOutlet?.matchedOutlet?.outletCode ?? r.schemeOutlet?.outletRef ?? null,
        outletName:
          r.schemeOutlet?.matchedOutlet?.name ??
          r.schemeOutlet?.matchedPartner?.businessName ??
          r.schemeOutlet?.outletName ??
          null,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Enrollee read-back
  // ───────────────────────────────────────────────────────────────────────────

  /** ACTIVE schemes whose audience includes the active partner (opt-in default = all ACTIVE). */
  async getEligibleSchemes(user: JwtPayload, requestedPartnerId?: string) {
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');

    const schemes = await this.prisma.scheme.findMany({
      where: { clientId: user.clientId, status: 'ACTIVE', deletedAt: null },
      // formSchema is included ONLY to project prefillValues to form-bound keys
      // (pickBoundPrefill); it is trimmed off the response below (not shipped in the list).
      include: { enrollmentForm: { select: { campaignType: true, version: true, formSchema: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!partnerId) return { schemes: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: { partnerId, clientId: user.clientId, deletedAt: null },
      select: {
        id: true, outletTypeId: true, programName: true,
        programCategory: true, zone: true, state: true,
      },
    });
    const outletIds = new Set(outlets.map((o) => o.id));

    // Each eligible scheme carries `mySchemeOutletId`: the active partner's MATCHED roster-row
    // id when the scheme has a FIXED roster (EXCEL / FILTER-frozen) — so the outlet portal can
    // self-enroll straight into that fixed row (targetSchemeOutletId). A live-rule scheme has no
    // pre-materialized row (the server lazy-creates on enroll) → null.
    // `prefillValues` (D13): the matched roster row's Excel variables, so the enroll
    // form can prefill/lock fields. Only the partner's OWN matched row is exposed; a
    // live-rule / no-audience scheme has no pre-materialized row → null.
    type EligibleScheme = (typeof schemes)[number] & {
      mySchemeOutletId: string | null;
      prefillValues: Record<string, string> | null;
      // Dual-source prefill (D13) + approved-owner-phone pre-pin hints for the matched row.
      outletFieldValues: Record<string, string> | null;
      outletApproved: boolean;
      ownerPhoneMasked: string | null;
    };
    const NO_MATCH = { outletFieldValues: null, outletApproved: false, ownerPhoneMasked: null } as const;
    const eligible: EligibleScheme[] = [];
    for (const scheme of schemes) {
      const audience = this.parseAudience(scheme);
      if (!audience) {
        // opt-in default: visible to all ACTIVE (no fixed roster row → no prefill)
        eligible.push({ ...scheme, mySchemeOutletId: null, prefillValues: null, ...NO_MATCH });
        continue;
      }
      if (audience.mode === 'EXCEL' || audience.frozen) {
        const rostered = await this.prisma.schemeOutlet.findFirst({
          where: {
            schemeId: scheme.id,
            OR: [{ matchedPartnerId: partnerId }, { matchedOutletId: { in: [...outletIds] } }],
          },
          select: { id: true, outletRef: true, outletName: true, prefillValues: true, matchedOutletId: true, matchedPartnerId: true },
          // Deterministic pick for a multi-outlet partner (A-LOW-1): the portal one-tap
          // self-enroll must always target the same roster row.
          orderBy: { createdAt: 'asc' },
        });
        if (rostered) {
          // Dual-source outlet-field values + approved-owner hints for THIS matched row.
          const ctxMap = await this.loadOutletFieldContext(
            user.clientId,
            [rostered],
            scheme.enrollmentForm?.formSchema,
          );
          const ctx = ctxMap.get(rostered.matchedOutletId ?? rostered.matchedPartnerId ?? '') ?? NO_MATCH;
          eligible.push({
            ...scheme,
            mySchemeOutletId: rostered.id,
            // Project to ONLY the columns the form binds to — unbound admin columns
            // (PAN, internal notes, …) are never shipped to the enroller (MED-1).
            prefillValues: pickBoundPrefill(
              withRosterIdentity(
                rostered.outletRef,
                rostered.outletName,
                rostered.prefillValues as Record<string, string> | null,
              ),
              scheme.enrollmentForm?.formSchema,
            ),
            outletFieldValues: ctx.outletFieldValues,
            outletApproved: ctx.outletApproved,
            ownerPhoneMasked: ctx.ownerPhoneMasked,
          });
        }
      } else {
        // Live-rule FILTER: any of the partner's outlets matches the filter.
        if (outlets.some((o) => this.outletMatchesFilter(o, audience.filter))) {
          eligible.push({ ...scheme, mySchemeOutletId: null, prefillValues: null, ...NO_MATCH });
        }
      }
    }
    // Trim formSchema back off enrollmentForm — it was included only to project
    // prefillValues; the list response keeps its original {campaignType, version} shape.
    const schemesOut = eligible.map(({ enrollmentForm, ...rest }) => ({
      ...rest,
      enrollmentForm: enrollmentForm
        ? { campaignType: enrollmentForm.campaignType, version: enrollmentForm.version }
        : null,
    }));
    return { schemes: schemesOut };
  }

  /** Current enrollment for the active partner's roster row within a scheme (or 404). */
  async getMyEnrollment(user: JwtPayload, schemeId: string, requestedPartnerId?: string) {
    const scheme = await this.loadSchemeWithForm(user, schemeId);
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!partnerId) throw new NotFoundException('Enrollment not found.');

    const outletIds = (
      await this.prisma.outlet.findMany({
        where: { partnerId, clientId: user.clientId, deletedAt: null },
        select: { id: true },
      })
    ).map((o) => o.id);

    const row = await this.prisma.schemeOutlet.findFirst({
      where: {
        schemeId: scheme.id,
        OR: [{ matchedPartnerId: partnerId }, { matchedOutletId: { in: outletIds } }],
      },
      include: { enrollment: true },
    });
    // A soft-deleted enrollment reads as absent (→ 404), so the row is re-enrollable.
    if (!row || !row.enrollment || row.enrollment.deletedAt != null) {
      throw new NotFoundException('Enrollment not found.');
    }
    const ctxMap = await this.loadOutletFieldContext(
      user.clientId,
      [row],
      scheme.enrollmentForm?.formSchema,
    );
    const ctx = ctxMap.get(row.matchedOutletId ?? row.matchedPartnerId ?? '') ?? {
      outletFieldValues: null,
      outletApproved: false,
      ownerPhoneMasked: null,
    };
    return {
      schemeOutlet: {
        id: row.id,
        outletName: row.outletName,
        // Excel prefill variables for THIS matched roster row (D13) — the outlet portal
        // prefills locked/editable fields from these. Only the enroller's own row, and
        // only the columns the form binds to (MED-1 data minimisation).
        prefillValues: pickBoundPrefill(
          withRosterIdentity(row.outletRef, row.outletName, row.prefillValues as Record<string, string> | null),
          scheme.enrollmentForm?.formSchema,
        ),
        // Dual-source (D13): Outlet-master field values for this matched outlet, projected
        // to the form's bound outlet fields.
        outletFieldValues: ctx.outletFieldValues,
      },
      // Renderer pre-pin hints: an approved matched owner's number is server-authoritative
      // for the phone-OTP consent (resolveOtpTarget) — the FE shows it locked.
      outletApproved: ctx.outletApproved,
      ownerPhoneMasked: ctx.ownerPhoneMasked,
      enrollment: row.enrollment,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SALES discovery — the rep's listing side (§13/§14, D19/D20)
  //
  // A SalesUser resolves nothing via `resolveActivePartnerId` (that is the partner
  // login-picker path), so the partner-keyed listing above is blind to reps. These
  // two methods give a rep the discovery surface: all active in-window schemes, and
  // — per scheme — the reachable TARGETS with their current enrollment status.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Active, in-window schemes a rep can enroll into (the enroll window = [startDate,endDate]).
   * A rep sees ALL active in-window schemes (audience/reach scoping is per-scheme, in
   * `getSalesTargets`) with the enrollment-form meta needed to render the picker.
   */
  async getSalesEligibleSchemes(user: JwtPayload) {
    await this.requireCallerSalesUser(user);
    const now = new Date();
    const schemes = await this.prisma.scheme.findMany({
      where: {
        clientId: user.clientId,
        status: 'ACTIVE',
        deletedAt: null,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      include: { enrollmentForm: { select: { campaignType: true, version: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { schemes };
  }

  /**
   * The reachable TARGETS for one scheme, each with its current enrollment status.
   *
   * Reach = `descendantSalesUserIds(caller, edges)` (includes self). We materialize:
   *   • ROSTER rows for this scheme, scoped BY reach — tagged-downline rows (incl.
   *     standalone rows where `matchedPartnerId` is null, D19) OR rows matched to an
   *     outlet/partner the rep holds an active assignment for. The query is bounded by
   *     the reach (never "load the whole roster then filter in JS" at 2,261-outlet scale).
   *   • LIVE-RULE outlets — only when the audience is FILTER + not-frozen (or no
   *     audience): the rep's reachable-subtree outlets that match `outletMatchesFilter`
   *     and are NOT already a roster row → potential `targetOutletRef` targets.
   * Each target LEFT-JOINs its current SchemeEnrollment (by schemeOutletId) for status.
   */
  async getSalesTargets(user: JwtPayload, schemeId: string, q: SalesTargetsQueryDto = {}) {
    const caller = await this.requireCallerSalesUser(user);
    const scheme = await this.loadSchemeWithForm(user, schemeId);

    const edges = await this.loadSalesEdges(scheme.clientId);
    const reach = descendantSalesUserIds(caller.id, edges); // includes self
    const reachArr = [...reach];

    // The outlets/partners the rep's subtree currently holds an active assignment for —
    // bounds BOTH the assignment-reach roster query and the live-rule candidate set.
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: { in: reachArr }, unassignedAt: null },
      select: { outletId: true, partnerId: true },
    });
    const reachOutletIds = new Set<string>();
    const reachPartnerIds = new Set<string>();
    for (const a of assignments) {
      if (a.outletId) reachOutletIds.add(a.outletId);
      if (a.partnerId) reachPartnerIds.add(a.partnerId);
    }

    // Roster rows scoped BY reach: tagged-in-downline OR matched to a reachable assignment.
    const rosterOr: Prisma.SchemeOutletWhereInput[] = [{ taggedSalesUserId: { in: reachArr } }];
    if (reachOutletIds.size > 0) rosterOr.push({ matchedOutletId: { in: [...reachOutletIds] } });
    if (reachPartnerIds.size > 0) rosterOr.push({ matchedPartnerId: { in: [...reachPartnerIds] } });

    const rosterRows = await this.prisma.schemeOutlet.findMany({
      where: { schemeId: scheme.id, clientId: scheme.clientId, OR: rosterOr },
      include: {
        enrollment: { select: { id: true, status: true, rejectionReason: true, currentVersion: true, deletedAt: true } },
      },
    });

    // Dual-source (D13): batch-resolve each matched row's outlet-field values + approved-
    // owner hints (one query per outlet/partner across the whole page).
    const rosterCtx = await this.loadOutletFieldContext(
      scheme.clientId,
      rosterRows.map((r) => ({ matchedOutletId: r.matchedOutletId, matchedPartnerId: r.matchedPartnerId })),
      scheme.enrollmentForm?.formSchema,
    );
    const NO_MATCH = { outletFieldValues: null, outletApproved: false, ownerPhoneMasked: null } as const;

    const rosterTargets: SalesTargetRow[] = rosterRows.map((r) => {
      // A soft-deleted enrollment reads as absent → the row surfaces as NOT_ENROLLED so the
      // rep can re-enroll (into the same row, which submit() resets).
      const liveEnrollment = r.enrollment && r.enrollment.deletedAt == null ? r.enrollment : null;
      return {
      schemeOutletId: r.id,
      targetOutletRef: null,
      outletRef: r.outletRef,
      outletName: r.outletName,
      matched: Boolean(r.matchedOutletId),
      standalone: !r.matchedOutletId,
      status: (liveEnrollment?.status as SalesTargetRow['status']) ?? 'NOT_ENROLLED',
      rejectionReason: liveEnrollment?.rejectionReason ?? null,
      enrollmentId: liveEnrollment?.id ?? null,
      currentVersion: liveEnrollment?.currentVersion ?? null,
      // Only the columns the form binds to (MED-1 data minimisation) + the roster's own
      // Outlet ID/Name so a DATA_DISPLAY bound to them resolves (matched OR standalone).
      prefillValues: pickBoundPrefill(
        withRosterIdentity(r.outletRef, r.outletName, r.prefillValues as Record<string, string> | null),
        scheme.enrollmentForm?.formSchema,
      ),
      ...(rosterCtx.get(r.matchedOutletId ?? r.matchedPartnerId ?? '') ?? NO_MATCH),
      };
    });

    // Live-rule targets — reachable outlets matching the filter, not already rostered.
    const audience = this.parseAudience(scheme);
    const isLiveRule = !audience || (audience.mode === 'FILTER' && !audience.frozen);
    let liveTargets: SalesTargetRow[] = [];
    if (isLiveRule && (reachOutletIds.size > 0 || reachPartnerIds.size > 0)) {
      const alreadyRostered = new Set<string>();
      for (const r of rosterRows) {
        alreadyRostered.add(r.outletRef);
        if (r.matchedOutletId) alreadyRostered.add(r.matchedOutletId);
      }
      const candidateIds = [...reachOutletIds].filter((id) => !alreadyRostered.has(id));

      // Candidate outlets come from BOTH assignment shapes (A-MED-1): outlets the rep's
      // subtree is directly assigned to (reachOutletIds), AND every outlet of a partner
      // the subtree holds a partner-only assignment for (reachPartnerIds). A partner-only
      // assignment contributes no outletId, so without the partner branch a partner-only-
      // assigned rep would see an empty live-rule target list even though the enroll path
      // (`assertSalesReachOutlet`) WOULD authorize them.
      const outletOr: Prisma.OutletWhereInput[] = [];
      if (candidateIds.length > 0) outletOr.push({ id: { in: candidateIds } });
      if (reachPartnerIds.size > 0) outletOr.push({ partnerId: { in: [...reachPartnerIds] } });

      if (outletOr.length > 0) {
        const outlets = await this.prisma.outlet.findMany({
          where: { clientId: scheme.clientId, deletedAt: null, OR: outletOr },
          select: {
            id: true, name: true, partnerId: true, outletTypeId: true, programName: true,
            programCategory: true, zone: true, state: true,
          },
        });
        const candidates = outlets
          // Exclude any outlet already surfaced as a roster row (the partner branch can
          // pull in a partner's outlet that is already rostered).
          .filter((o) => !alreadyRostered.has(o.id))
          .filter((o) => this.outletMatchesFilter(o, audience?.filter));
        // Live-rule matched outlets have no Excel roster — outletField prefill comes straight
        // from the outlet DB record (dual-source, D13).
        const liveCtx = await this.loadOutletFieldContext(
          scheme.clientId,
          candidates.map((o) => ({ matchedOutletId: o.id, matchedPartnerId: o.partnerId })),
          scheme.enrollmentForm?.formSchema,
        );
        liveTargets = candidates.map((o) => ({
          schemeOutletId: null,
          targetOutletRef: o.id,
          outletRef: o.id,
          outletName: o.name,
          matched: true,
          standalone: false,
          status: 'NOT_ENROLLED' as const,
          rejectionReason: null,
          enrollmentId: null,
          currentVersion: null,
          prefillValues: null,
          ...(liveCtx.get(o.id) ?? NO_MATCH),
        }));
      }
    }

    // Privacy (audit F3): a rep listing targets must NOT be able to bulk-read every
    // downline outlet's PAN/GST. Strip those sensitive keys from the rep-facing prefill
    // payload; the owner (SELF) portal keeps them, and submit() still pins a locked
    // PAN/GST field server-side (it re-resolves the full map) — so this only removes the
    // rep's DISPLAY visibility, never the pin.
    const stripSensitive = (v: Record<string, string> | null): Record<string, string> | null => {
      if (!v) return v;
      const { panNumber, gstNumber, ...rest } = v;
      void panNumber;
      void gstNumber;
      return Object.keys(rest).length > 0 ? rest : null;
    };
    let all = [...rosterTargets, ...liveTargets].map((t) => ({
      ...t,
      outletFieldValues: stripSensitive(t.outletFieldValues),
    }));
    if (q.status) all = all.filter((t) => t.status === q.status);

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const total = all.length;
    const targets = all.slice((page - 1) * limit, (page - 1) * limit + limit);

    return { targets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admin captured-data view (GIFSY_ADMIN, D25)
  // ───────────────────────────────────────────────────────────────────────────

  async adminListEnrollments(user: JwtPayload, schemeId: string, q: AdminListEnrollmentsQueryDto) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;

    const outletFilter: Prisma.OutletWhereInput = {};
    if (q.outletTypeId) outletFilter.outletTypeId = q.outletTypeId;
    if (q.programName) outletFilter.programName = q.programName;
    if (q.zone) outletFilter.zone = q.zone;
    if (q.state) outletFilter.state = q.state;
    const hasOutletFilter = Object.keys(outletFilter).length > 0;

    const where: Prisma.SchemeOutletWhereInput = {
      schemeId: scheme.id,
      clientId: scheme.clientId,
      ...(hasOutletFilter ? { matchedOutlet: outletFilter } : {}),
    };

    // Filter to rows that actually have an enrollment (roster rows without one are shown too,
    // but a status/date filter narrows to enrolled rows). A soft-deleted enrollment never
    // satisfies a status/date filter (deletedAt: null on the relation filter), and is nulled
    // out of the shaped row below so a deleted capture never appears in the admin list.
    const enrollmentWhere: Prisma.SchemeEnrollmentWhereInput = {};
    if (q.status) enrollmentWhere.status = q.status;
    if (q.from || q.to) {
      enrollmentWhere.enrolledAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (Object.keys(enrollmentWhere).length > 0) {
      where.enrollment = { is: { ...enrollmentWhere, deletedAt: null } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.schemeOutlet.findMany({
        where,
        include: {
          enrollment: true,
          matchedOutlet: {
            select: {
              id: true, name: true, outletCode: true, outletTypeId: true, programName: true,
              programCategory: true, zone: true, state: true, latitude: true, longitude: true,
            },
          },
          matchedPartner: { select: { id: true, businessName: true, phone: true } },
          taggedSalesUser: { select: { id: true, employeeCode: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.schemeOutlet.count({ where }),
    ]);

    return {
      // A soft-deleted enrollment is nulled out — the roster row shows as NOT_ENROLLED, never
      // as captured data (mirrors the status-filter exclusion above).
      enrollments: rows.map((r) =>
        this.shapeRosterRow({
          ...r,
          enrollment: r.enrollment && r.enrollment.deletedAt == null ? r.enrollment : null,
        }),
      ),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async adminGetEnrollment(user: JwtPayload, schemeId: string, enrollmentId: string) {
    if (!this.isGifsyAdmin(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    const scheme = await this.loadScheme(user, schemeId);
    const enrollment = await this.prisma.schemeEnrollment.findFirst({
      // A soft-deleted enrollment reads as absent (→ 404) in the admin detail view.
      where: { id: enrollmentId, schemeId: scheme.id, deletedAt: null },
      include: {
        schemeOutlet: {
          include: {
            matchedOutlet: {
              select: {
                id: true, name: true, outletCode: true, outletTypeId: true, programName: true,
                programCategory: true, zone: true, state: true, latitude: true, longitude: true,
              },
            },
            matchedPartner: { select: { id: true, businessName: true, phone: true } },
            taggedSalesUser: { select: { id: true, employeeCode: true } },
          },
        },
        submissions: { orderBy: { version: 'desc' } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');

    const formSnapshot = await this.resolveFormSnapshot(scheme.id, enrollment.formVersion);
    return {
      enrollment: {
        ...enrollment,
        media: this.extractMedia(scheme.id, enrollment.formValues, formSnapshot),
        geo: this.extractGeo(enrollment.formValues, formSnapshot),
        // Field id → label/type for the version the submission was captured against, so
        // the admin drawer renders human labels for captured values instead of raw field
        // ids (and can hide display/structural + media/geo fields). Ordered for display.
        formFields: [...(formSnapshot?.fields ?? [])]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((f) => ({ id: f.id, label: f.label, type: f.type })),
      },
    };
  }

  private shapeRosterRow(r: RosterRow & { enrollment?: unknown; matchedOutlet?: unknown; matchedPartner?: unknown; taggedSalesUser?: unknown }) {
    return {
      schemeOutletId: r.id,
      outletRef: r.outletRef,
      outletName: r.outletName,
      standalone: !r.matchedOutletId,
      matchedOutlet: r.matchedOutlet ?? null,
      matchedPartner: r.matchedPartner ?? null,
      taggedSalesUser: r.taggedSalesUser ?? null,
      prefillValues: r.prefillValues ?? null,
      enrollment: r.enrollment ?? null,
    };
  }

  /** The form-version snapshot a submission was captured against (D11), for field typing. */
  private async resolveFormSnapshot(schemeId: string, formVersion: number): Promise<EnrollmentFormSchema | null> {
    const snap = await this.prisma.schemeEnrollmentFormVersion.findFirst({
      where: { schemeId, version: formVersion },
      select: { formSchema: true },
    });
    if (snap) return snap.formSchema as unknown as EnrollmentFormSchema;
    const current = await this.prisma.schemeEnrollmentForm.findUnique({
      where: { schemeId },
      select: { formSchema: true },
    });
    return current ? (current.formSchema as unknown as EnrollmentFormSchema) : null;
  }

  /** Media refs = media-typed fields whose value is a stored object key → an auth-gated view path. */
  private extractMedia(
    schemeId: string,
    formValues: Prisma.JsonValue | null,
    schema: EnrollmentFormSchema | null,
  ): Array<{ fieldId: string; label: string; type: string; key: string; viewPath: string }> {
    if (!formValues || typeof formValues !== 'object' || !schema) return [];
    const vals = formValues as Record<string, unknown>;
    const out: Array<{ fieldId: string; label: string; type: string; key: string; viewPath: string }> = [];
    for (const f of schema.fields ?? []) {
      if (!MEDIA_FIELD_SET.has(f.type)) continue;
      const key = vals[f.id];
      if (typeof key === 'string' && key) {
        out.push({
          fieldId: f.id,
          label: f.label,
          type: f.type,
          key,
          // D30: an auth-gated app route (NOT a raw/long-lived signed GCS URL).
          viewPath: `/v1/schemes/${schemeId}/enrollments/media?key=${encodeURIComponent(key)}`,
        });
      }
    }
    return out;
  }

  private extractGeo(
    formValues: Prisma.JsonValue | null,
    schema: EnrollmentFormSchema | null,
  ): Array<{ fieldId: string; label: string; value: unknown }> {
    if (!formValues || typeof formValues !== 'object' || !schema) return [];
    const vals = formValues as Record<string, unknown>;
    return (schema.fields ?? [])
      .filter((f) => f.type === 'GPS_POINT' && vals[f.id] != null)
      .map((f) => ({ fieldId: f.id, label: f.label, value: vals[f.id] }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Media (upload + auth-gated view) — §12 magic-byte guard + StreamableFile
  // ───────────────────────────────────────────────────────────────────────────

  async uploadMedia(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.buffer?.length) throw new BadRequestException('Empty file');
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BYTES) throw new BadRequestException('File too large (max 5 MB)');

    // Magic-byte sniff — the client mimetype is untrusted (K-guard reuse, §12).
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed) {
      throw new BadRequestException('Unsupported or corrupt file. Upload a JPG, PNG, WEBP, GIF, or PDF.');
    }

    // Tenant-foldered key so the auth-gated view can enforce tenant from the path.
    const key = this.storage.generateKey(
      `scheme-media/${user.clientId}`,
      file.originalname || `capture.${sniffed.ext}`,
    );
    const fileUrl = await this.storage.uploadFile(file.buffer, key, sniffed.mime);
    return { key, fileUrl, mimeType: sniffed.mime, fileSizeBytes: file.size };
  }

  /**
   * Auth-gated media stream (D30). Mirrors the KYC doc-view security posture: a
   * SAFE-mime allowlist decides inline vs. attachment; nosniff; no-store. Tenant is
   * enforced from the object key's tenant folder (`scheme-media/<clientId>/…`) — a
   * GIFSY_ADMIN is the cross-tenant operator; every other caller is pinned to its own
   * tenant. Any failure → bare 404 (no enumeration / info leak).
   */
  async viewMedia(user: JwtPayload, key: string): Promise<{ bytes: Buffer; contentType: string; inline: boolean }> {
    const deny = () => new NotFoundException();
    if (!key || typeof key !== 'string' || !key.startsWith('scheme-media/')) throw deny();

    const keyClientId = key.split('/')[1];
    if (!keyClientId) throw deny();
    // Un-assumed GIFSY reads any tenant's media; every other caller — incl. an ASSUMED
    // operator — is pinned to its (assumed) tenant folder.
    if (!platformWide(user) && keyClientId !== user.clientId) throw deny();

    const file = await this.storage.downloadBytes(key);
    if (!file) throw deny();

    const rawMime = (file.contentType || '').toLowerCase();
    const inline = INLINE_SAFE_MIME.has(rawMime);
    return { bytes: file.bytes, contentType: inline ? rawMime : 'application/octet-stream', inline };
  }
}

/** Media-typed field set — a module-local copy of the helper's set (avoids a cyclic import surprise). */
const MEDIA_FIELD_SET: ReadonlySet<string> = new Set([
  'DOCUMENT',
  'IMAGE',
  'CAMERA',
  'UPI_QR_SCAN',
  'SIGNATURE',
]);
