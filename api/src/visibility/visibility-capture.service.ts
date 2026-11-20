import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import {
  TenantSettingsService,
  VisibilityConfigSettings,
} from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  descendantSalesUserIds,
  promotedActiveReportIds,
  SalesUserEdge,
} from '../sales/sales-hierarchy-access.helper';
import { loadSalesHierarchy } from '../sales/sales-hierarchy.loader';
import { VisibilityMediaService } from './visibility-media.service';
import { visibilityLocationRefusal } from './visibility-location.helper';
import {
  isLocationRequiredFor,
  isPhoneClockWrong,
  isRealFix,
  PHONE_CLOCK_WRONG_MESSAGE,
  recordFenceBlock,
} from '../common/location-gate.helper';
import {
  currentWindowKey,
  isWindowClosed,
  windowBoundsForKey,
  windowKeyForDate,
  windowsForMonth,
} from './visibility-window.helper';
import {
  validateSubmittedValues,
  parseGpsPoint,
  MEDIA_FIELD_TYPES,
  readMediaValue,
  readPhotoReviews,
  PhotoReviews,
  applicableCameraFields,
} from './visibility-form.helper';
import {
  VisibilityFormSchema,
  GpsCapture,
  outletContextValues,
} from './visibility-types';
import {
  isValidGeo,
  OUTLET_MASTER_GEOFENCE_RADIUS_M,
  outletMasterReference,
  classifyPhotoFence,
  PhotoFencePolicy,
} from './geo-fence.helper';
import { SubmitCaptureDto, ResubmitCaptureDto } from './dto/visibility-capture.dto';
import { visibilityProgramMatches, visibilityUniverseBase, withVisibilityProgramWhere } from './visibility-scope.helper';

/** Object-key tenant folder for all visibility media (mirrors VisibilityMediaService). */
const MEDIA_FOLDER_PREFIX = 'visibility-media/';
/** Skew (ms) beyond which the client-reported capturedAt vs server receivedAt is flagged. */
const CLOCK_SKEW_FLAG_MS = 10 * 60 * 1000;
/** GPS accuracy (metres) above which a capture is flagged "low accuracy". */
const LOW_ACCURACY_FLAG_M = 100;

/** Per-outlet capture state for the sales listing (D8/D13). */
export type CaptureUiState = 'due' | 'awaiting' | 'approved' | 'rejected' | 'late';

/** The caller's resolved sales identity (id + level code). */
interface CallerSalesUser {
  id: string;
  levelCode: string;
}

/** Parsed capture geo taken from the submitted GPS field. */
interface CaptureGeo {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  capturedAt: Date | null;
}

/**
 * VisibilityCaptureService — the sales-facing capture surface for the Visibility
 * (POSM) feature (Stream B, design D6/D7/D8/D10/D11).
 *
 * A rep sees the in-scope outlets in their downline and, if their sales level is
 * allowed, captures a per-window photo+geo proof. Submit computes the window key at
 * write time (IST), enforces the geo-fence against the outlet's KYC board-photo
 * reference geo, records image hashes for the duplicate flag, and — inside ONE
 * transaction — enforces first-approved-wins + append-only versioning (reject →
 * resubmit bumps the version). Every path is gated on `visibilityEnabled` +
 * capture-mode PHOTO_APPROVAL; capture additionally on allowed-level + downline reach.
 *
 * Clone-and-adapt of scheme-enrollment.service.ts (submit/resubmit versioning + reach
 * model) keyed by (outlet, window) instead of a roster row. Does NOT import/modify the
 * scheme module.
 */
@Injectable()
export class VisibilityCaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly media: VisibilityMediaService,
  ) {}

  // ── Gates ─────────────────────────────────────────────────────────────────

  /** Master switch — every method 403s when the tenant is OFF (fail-closed). */
  private async assertEnabled(clientId: string): Promise<void> {
    if (!(await this.tenant.resolveVisibilityEnabled(clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /** Capture only applies in PHOTO_APPROVAL mode (AMOUNT_UPLOAD is a separate path). */
  private async assertPhotoMode(clientId: string): Promise<void> {
    const mode = await this.tenant.resolveVisibilityCaptureMode(clientId);
    if (mode !== 'PHOTO_APPROVAL') {
      throw new ForbiddenException(
        'Visibility photo-approval mode is not active for this tenant.',
      );
    }
  }

  private async getConfig(clientId: string): Promise<VisibilityConfigSettings> {
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return settings.visibilityConfig;
  }

  private freqOf(config: VisibilityConfigSettings): number {
    return config.frequencyPerMonth;
  }

  /**
   * Sales-safe read of the tenant's ACTIVE capture form schema (D9). GIFSY owns form
   * authoring (`GET /form` is GIFSY-only); this is the read a rendering rep needs to draw
   * the capture form. Gated identically to the capture path (enabled + PHOTO_APPROVAL) and
   * requires a sales user. Returns null when no form has been published yet.
   */
  async getSalesForm(
    user: JwtPayload,
  ): Promise<{ formSchema: VisibilityFormSchema; version: number } | null> {
    await this.assertEnabled(user.clientId);
    await this.assertPhotoMode(user.clientId);
    await this.requireCallerSalesUser(user);
    const form = await this.prisma.visibilityForm.findUnique({
      where: { clientId: user.clientId },
      select: { formSchema: true, version: true },
    });
    if (!form) return null;
    return {
      formSchema: form.formSchema as unknown as VisibilityFormSchema,
      version: form.version,
    };
  }

  /**
   * H2 — sales-reachable capture-photo upload. A rep needs a stored object key to put in
   * a CAMERA field, but the only upload used to be the GIFSY-only admin `/media` route.
   * Gated identically to the capture path (enabled + PHOTO_APPROVAL + a sales user), then
   * delegates to the shared media service, which tenant-folders the key under the caller's
   * clientId (so L1's ownership check later passes for this rep's own uploads).
   */
  async uploadCaptureMedia(user: JwtPayload, file: Express.Multer.File) {
    await this.assertEnabled(user.clientId);
    await this.assertPhotoMode(user.clientId);
    await this.requireCallerSalesUser(user);
    return this.media.uploadMedia(user, file);
  }

  // ── Caller / reach resolution ───────────────────────────────────────────────

  /** The caller's SalesUser (id + level code) or a 403 — visibility is sales-captured (D8). */
  private async requireCallerSalesUser(user: JwtPayload): Promise<CallerSalesUser> {
    const su = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
      select: { id: true, hierarchyLevel: { select: { code: true } } },
    });
    if (!su) {
      throw new ForbiddenException('Only sales users may capture visibility.');
    }
    return { id: su.id, levelCode: su.hierarchyLevel.code };
  }

  /** G3: deleted-aware tenant edges — the reach walks THROUGH a soft-deleted manager (never returns them). */
  private async loadSalesEdges(clientId: string): Promise<SalesUserEdge[]> {
    return loadSalesHierarchy(this.prisma, clientId);
  }

  /** The set of outletIds the caller's downline currently holds an active assignment to. */
  private async reachOutletIds(clientId: string, callerId: string): Promise<Set<string>> {
    const edges = await this.loadSalesEdges(clientId);
    const subtree = [...descendantSalesUserIds(callerId, edges)];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: { in: subtree }, unassignedAt: null, outletId: { not: null } },
      select: { outletId: true },
    });
    const ids = new Set<string>();
    for (const a of assignments) if (a.outletId) ids.add(a.outletId);
    return ids;
  }

  // ── Sales: eligible outlets + current-window status (D8/D13) ─────────────────

  /**
   * The caller's IN-SCOPE downline outlets with their current-window capture state.
   *
   * Scope = outletType.code ∈ config.outletScope, addressable (not deleted/deactivated,
   * isActive), AND in the caller's downline (active assignment to a subtree rep). A rep
   * whose level ∈ config.allowedSalesLevels may capture (canCapture true); everyone else
   * is VIEW-ONLY (D8) — they still see status but canCapture=false.
   */
  async getSalesEligible(user: JwtPayload) {
    await this.assertEnabled(user.clientId);
    const config = await this.getConfig(user.clientId);

    // Caller identity + DIRECT reports (the manager-only "Team Member" filter options) in ONE
    // read — mirrors sales.service getMyOutlets. A leaf rep has no subordinates → members [] →
    // the FE hides the filter.
    const callerSu = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
      select: {
        id: true,
        hierarchyLevel: { select: { code: true } },
        subordinates: {
          where: { isActive: true, deletedAt: null },
          select: { id: true, employeeCode: true, user: { select: { name: true } } },
          orderBy: { employeeCode: 'asc' },
        },
      },
    });
    if (!callerSu) {
      throw new ForbiddenException('Only sales users may capture visibility.');
    }
    const caller: CallerSalesUser = {
      id: callerSu.id,
      levelCode: callerSu.hierarchyLevel.code,
    };

    const levelAllowed = config.allowedSalesLevels.includes(caller.levelCode);
    const now = new Date();
    const freq = this.freqOf(config);
    const windowKey = currentWindowKey(now, freq);
    const { startDay, endDay } = windowBoundsForKey(windowKey, freq);
    const windowClosed = isWindowClosed(windowKey, now, freq);

    // Hierarchy edges loaded ONCE (reused for the subtree reach + each direct report's
    // submitter sub-tree) — the SAME walk getMyOutlets uses, no N+1.
    // G3: deleted-aware (loadSalesHierarchy) — the reach and each member's branch pass THROUGH a deleted SO.
    const edges = await loadSalesHierarchy(this.prisma, user.clientId);
    const userIdBySalesUserId = new Map(edges.map((e) => [e.id, e.userId]));

    // G3 Team-Member filter: a REMOVED (deleted) direct report's ACTIVE reports are PROMOTED to selectable
    // members under the caller — the same rule as the Outlets screen (SalesService.getMyOutlets). F2: an
    // inactive report is never walked through. F8: direct reports first (their existing employeeCode
    // order), then promoted ones in WALK order — the same promoted order as the Team / Outlets screens.
    const promotedIds = promotedActiveReportIds(callerSu.id, edges);
    const promotedRows = promotedIds.length
      ? await this.prisma.salesUser.findMany({
          where: { id: { in: promotedIds }, clientId: user.clientId, deletedAt: null, isActive: true },
          select: { id: true, employeeCode: true, user: { select: { name: true } } },
        })
      : [];
    const pos = new Map(promotedIds.map((id, i) => [id, i]));
    const promoted = (Array.isArray(promotedRows) ? promotedRows : []).sort(
      (a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0),
    );
    const directMembers = [...(callerSu.subordinates ?? []), ...promoted];

    // Each DIRECT report enriched with the login-User ids of that report PLUS their whole
    // downline (submitterUserIds). The Team Member filter matches an outlet whose assignedUserId
    // is anywhere in that sub-tree — the SAME sub-tree semantics as the Outlets-screen member
    // filter. Each member's branch is a slice of the caller's own subtree (descendantSalesUserIds
    // walks DOWN only), so a manager can never filter another manager's team.
    const members = directMembers.map((sub) => ({
      id: sub.id,
      name: sub.user?.name ?? '',
      submitterUserIds: [...descendantSalesUserIds(sub.id, edges)]
        .map((id) => userIdBySalesUserId.get(id))
        .filter((v): v is string => !!v),
    }));

    // Active assignments across the caller's subtree → reach outletIds + the rep each outlet is
    // assigned to (assignedUserId = that rep's login-User id — the member-filter key). Same
    // scoping as reachOutletIds, plus the assignee's userId so the FE can filter by member.
    const subtree = [...descendantSalesUserIds(caller.id, edges)];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: { in: subtree }, unassignedAt: null, outletId: { not: null } },
      select: { outletId: true, salesUser: { select: { userId: true } } },
    });
    const reach = new Set<string>();
    const assignedUserIdByOutlet = new Map<string, string | null>();
    for (const a of assignments) {
      if (!a.outletId) continue;
      reach.add(a.outletId);
      // First active assignment wins (an outlet normally has exactly one).
      if (!assignedUserIdByOutlet.has(a.outletId)) {
        assignedUserIdByOutlet.set(a.outletId, a.salesUser?.userId ?? null);
      }
    }

    if (reach.size === 0 || config.outletScope.length === 0) {
      return {
        windowKey,
        window: { startDay, endDay },
        levelAllowed,
        members,
        outlets: [],
      };
    }

    const outlets = await this.prisma.outlet.findMany({
      // THE single in-scope rule (visibilityUniverseBase — shared with the report / dashboards / digest) ∩ the
      // caller's reach. APPLIES-TO (D12): programs/subPrograms narrow the type scope (no-op when neither is set).
      where: withVisibilityProgramWhere(
        { ...visibilityUniverseBase(user.clientId, config.outletScope), id: { in: [...reach] } },
        config,
      ),
      select: {
        id: true,
        outletCode: true,
        name: true,
        zone: true,
        state: true,
        // Program (e.g. Unnati/SAMT/BSC) — drives the sales Visibility list's Program filter.
        programName: true,
        // Drives the Sub-Program conditional-photo clause on the capture form (__subProgram__).
        programCategory: true,
        outletType: { select: { code: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    const captures = await this.prisma.visibilityCapture.findMany({
      where: { clientId: user.clientId, windowKey, outletId: { in: outlets.map((o) => o.id) } },
      select: {
        outletId: true,
        id: true,
        status: true,
        currentVersion: true,
        rejectionReason: true,
        // Per-photo review map — on a CHANGES_REQUESTED capture the rep needs to know WHICH
        // photos to re-shoot (and why); the whole-capture rejectionReason is null for per-photo.
        photoReviews: true,
      },
    });
    const byOutlet = new Map(captures.map((c) => [c.outletId, c]));

    return {
      windowKey,
      window: { startDay, endDay },
      levelAllowed,
      members,
      outlets: outlets.map((o) => {
        const cap = byOutlet.get(o.id) ?? null;
        return {
          outletId: o.id,
          outletCode: o.outletCode,
          outletName: o.name,
          zone: o.zone,
          state: o.state,
          programName: o.programName ?? null,
          programCategory: o.programCategory ?? null,
          outletType: o.outletType,
          // The rep this outlet is assigned to (login-User id) — the Team Member filter key.
          assignedUserId: assignedUserIdByOutlet.get(o.id) ?? null,
          captureId: cap?.id ?? null,
          status: cap?.status ?? null,
          currentVersion: cap?.currentVersion ?? null,
          rejectionReason: cap?.rejectionReason ?? null,
          photoReviews: cap?.photoReviews ?? null,
          windowState: this.deriveState(cap?.status ?? null, windowClosed),
          // canCapture (D8): allowed level AND in the caller's subtree (every listed
          // outlet is in-subtree, so this reduces to the level check).
          canCapture: levelAllowed,
        };
      }),
    };
  }

  /**
   * Per-outlet ALL windows of the CURRENT month, each with its capture status — the
   * outlet-view "Visibility — this period" card (D13). Authorizes the caller can see
   * the outlet (downline reach).
   */
  async getOutletStatus(user: JwtPayload, outletId: string) {
    await this.assertEnabled(user.clientId);
    const config = await this.getConfig(user.clientId);
    const caller = await this.requireCallerSalesUser(user);

    const reach = await this.reachOutletIds(user.clientId, caller.id);
    if (!reach.has(outletId)) {
      throw new ForbiddenException('This outlet is not within your team.');
    }

    const outlet = await this.prisma.outlet.findFirst({
      where: { id: outletId, clientId: user.clientId, deletedAt: null },
      select: {
        id: true,
        outletCode: true,
        name: true,
        // APPLIES-TO program facets (visibility programs/subPrograms) — not returned.
        programName: true,
        programCategory: true,
        outletType: { select: { code: true, name: true } },
      },
    });
    if (!outlet) throw new NotFoundException('Outlet not found.');

    const now = new Date();
    const freq = this.freqOf(config);
    const month = currentWindowKey(now, freq).slice(0, 7); // 'YYYY-MM'
    const windowKeys = windowsForMonth(month, freq);
    const levelAllowed = config.allowedSalesLevels.includes(caller.levelCode);
    const inScope =
      config.outletScope.includes(outlet.outletType.code) &&
      visibilityProgramMatches(config, { program: outlet.programName, subProgram: outlet.programCategory });

    const captures = await this.prisma.visibilityCapture.findMany({
      where: { clientId: user.clientId, outletId, windowKey: { in: windowKeys } },
      select: {
        id: true,
        windowKey: true,
        status: true,
        currentVersion: true,
        rejectionReason: true,
        photoReviews: true,
      },
    });
    const byWindow = new Map(captures.map((c) => [c.windowKey, c]));

    return {
      outlet: {
        outletId: outlet.id,
        outletCode: outlet.outletCode,
        outletName: outlet.name,
        outletType: outlet.outletType,
      },
      inScope,
      canCapture: levelAllowed && inScope,
      windows: windowKeys.map((key) => {
        const { startDay, endDay } = windowBoundsForKey(key, freq);
        const cap = byWindow.get(key) ?? null;
        const closed = isWindowClosed(key, now, freq);
        return {
          windowKey: key,
          startDay,
          endDay,
          closed,
          captureId: cap?.id ?? null,
          status: cap?.status ?? null,
          currentVersion: cap?.currentVersion ?? null,
          rejectionReason: cap?.rejectionReason ?? null,
          photoReviews: cap?.photoReviews ?? null,
          state: this.deriveState(cap?.status ?? null, closed),
        };
      }),
    };
  }

  /** Map a capture status + window-closed flag to a UI state (D7). */
  private deriveState(status: string | null, windowClosed: boolean): CaptureUiState {
    if (status === 'APPROVED') return 'approved';
    if (windowClosed) return 'late'; // closed with no approval → missed/late
    if (status === 'SUBMITTED') return 'awaiting';
    // CHANGES_REQUESTED is treated exactly like the old whole-capture REJECTED "re-open":
    // the rep must re-capture the rejected photo(s); the window is NOT satisfied.
    if (status === 'REJECTED' || status === 'CHANGES_REQUESTED') return 'rejected';
    return 'due';
  }

  // ── Sales: submit / resubmit (D10/D11) ───────────────────────────────────────

  /**
   * Submit a capture for one in-scope outlet in the CURRENT window. Fail-closed auth
   * (allowed level + downline reach), form validation, IST window-key, geo-fence
   * enforcement, dup-hash recording, and — in ONE transaction — first-approved-wins +
   * versioned upsert (v1 SUBMITTED, or a REJECTED row → version+1 SUBMITTED).
   */
  async submitCapture(user: JwtPayload, dto: SubmitCaptureDto) {
    await this.assertEnabled(user.clientId);
    await this.assertPhotoMode(user.clientId);
    const config = await this.getConfig(user.clientId);
    const caller = await this.requireCallerSalesUser(user);

    // AUTH fail-closed (D8): allowed level AND the outlet in the caller's subtree.
    if (!config.allowedSalesLevels.includes(caller.levelCode)) {
      throw new ForbiddenException('Your sales level is not permitted to capture visibility.');
    }
    const reach = await this.reachOutletIds(user.clientId, caller.id);
    if (!reach.has(dto.outletId)) {
      throw new ForbiddenException('This outlet is not within your team.');
    }

    const outlet = await this.loadInScopeOutlet(user.clientId, dto.outletId, config);
    return this.persistCapture(user, config, caller, outlet, dto.formValues, null, { captureGeo: dto.captureGeo, clientNow: dto.clientNow });
  }

  /** Re-capture after a rejection (D11) — only a REJECTED capture, re-authorized. */
  async resubmitCapture(user: JwtPayload, captureId: string, dto: ResubmitCaptureDto) {
    await this.assertEnabled(user.clientId);
    await this.assertPhotoMode(user.clientId);
    const config = await this.getConfig(user.clientId);
    const caller = await this.requireCallerSalesUser(user);

    const capture = await this.prisma.visibilityCapture.findFirst({
      where: { id: captureId, clientId: user.clientId },
    });
    if (!capture) throw new NotFoundException('Capture not found.');
    // Re-open statuses: the explicit whole-capture REJECTED, OR the per-photo
    // CHANGES_REQUESTED (some photos rejected → re-capture only those, merge the rest).
    if (capture.status !== 'REJECTED' && capture.status !== 'CHANGES_REQUESTED') {
      throw new BadRequestException(
        'Only a rejected or changes-requested capture can be resubmitted.',
      );
    }

    // M1 — a resubmit is valid ONLY within the SAME window the rejected capture belongs to.
    // If the window has rolled over, persistCapture would recompute windowKey=now and write
    // a NEW windowKey into the submission while updating the OLD capture row — retro-satisfying
    // a closed window. Block it: the current window needs a fresh capture.
    const currentKey = currentWindowKey(new Date(), this.freqOf(config));
    if (capture.windowKey !== currentKey) {
      throw new ConflictException(
        'This window has closed; the current window needs a fresh capture (start a new capture).',
      );
    }

    // Re-authorize (level + reach) before accepting a new version.
    if (!config.allowedSalesLevels.includes(caller.levelCode)) {
      throw new ForbiddenException('Your sales level is not permitted to capture visibility.');
    }
    const reach = await this.reachOutletIds(user.clientId, caller.id);
    if (!reach.has(capture.outletId)) {
      throw new ForbiddenException('This outlet is not within your team.');
    }

    const outlet = await this.loadInScopeOutlet(user.clientId, capture.outletId, config);
    return this.persistCapture(user, config, caller, outlet, dto.formValues, capture, { captureGeo: dto.captureGeo, clientNow: dto.clientNow });
  }

  /**
   * Load an addressable outlet and assert its type is in the configured scope. M2 — the
   * predicate mirrors the coverage DENOMINATOR (deletedAt + deactivatedAt null) so a rep
   * cannot create an APPROVED capture for a deactivated/excluded outlet that the report
   * denominator drops (which would let coverage exceed the addressable universe).
   */
  private async loadInScopeOutlet(
    clientId: string,
    outletId: string,
    config: VisibilityConfigSettings,
  ) {
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: outletId, clientId, deletedAt: null, deactivatedAt: null },
      select: {
        id: true,
        outletCode: true,
        name: true,
        partnerId: true,
        // Outlet-master coords — the geo-fence REFERENCE when the tenant's outletMasterGeo
        // feature is on (Bajaj). Nullable; a null → 'unverifiable' (allow, never block).
        latitude: true,
        longitude: true,
        // Sub-program (Design B) — the authoritative outlet attribute that drives
        // conditional capture fields (e.g. a `requiredWhen __subProgram__ == X` 2nd photo).
        programCategory: true,
        // APPLIES-TO program facet (visibility `programs` narrowing).
        programName: true,
        outletType: { select: { code: true } },
      },
    });
    if (!outlet) throw new NotFoundException('Outlet not found.');
    // Type scope AND (D12) the optional program / sub-program narrowing, evaluated LIVE on the
    // outlet's current attributes (D9) — the same predicate as the listing + coverage denominator.
    if (
      !config.outletScope.includes(outlet.outletType.code) ||
      !visibilityProgramMatches(config, { program: outlet.programName, subProgram: outlet.programCategory })
    ) {
      throw new ForbiddenException('This outlet is not in the visibility scope.');
    }
    return outlet;
  }

  /**
   * Shared validate → window-key → geo-fence → dup-hash → transaction (create v1 or
   * version+1 over a REJECTED row). `existing` is null for a fresh submit; a REJECTED
   * row for a resubmit.
   */
  private async persistCapture(
    user: JwtPayload,
    config: VisibilityConfigSettings,
    caller: CallerSalesUser,
    outlet: {
      id: string;
      outletCode: string;
      name: string;
      partnerId: string | null;
      // Outlet-master coords (Prisma Decimal | null) — the geo-fence reference under outletMasterGeo.
      latitude?: Prisma.Decimal | null;
      longitude?: Prisma.Decimal | null;
      programCategory?: string | null;
    },
    submittedRaw: Record<string, unknown> | undefined,
    existing: {
      id: string;
      status: string;
      currentVersion: number;
      formValues?: Prisma.JsonValue | null;
      photoReviews?: Prisma.JsonValue | null;
    } | null,
    /** Location gate: the phone's submit-time fix + clock (requireLocation tenants only; see visibility-location.helper). */
    gateInput: { captureGeo?: unknown; clientNow?: unknown } = {},
  ) {
    const form = await this.prisma.visibilityForm.findUnique({
      where: { clientId: user.clientId },
    });
    if (!form) {
      throw new BadRequestException('No visibility form is configured for this tenant.');
    }
    const schema = form.formSchema as unknown as VisibilityFormSchema;
    const formVersion = form.version;

    // Design B (sub-program-driven conditional photos): merge the SERVER-AUTHORITATIVE
    // outlet context into the values map used to evaluate visibleWhen / requiredWhen, so a
    // clause can key on the outlet's Sub-Program. ANTI-SPOOF: strip any reserved `__…__`
    // keys the client sent (a crafted payload must not be able to drop a required photo)
    // and inject the server-derived ctx LAST. The ctx keys are NOT form fields, so
    // validateSubmittedValues projects them out — they are never persisted in formValues.
    const ctx = outletContextValues(outlet);
    const cleaned = stripReservedKeys(submittedRaw ?? {});

    const now = new Date();
    const freq = this.freqOf(config);
    const windowKey = windowKeyForDate(now, freq);

    // ── PARTIAL RE-CAPTURE MERGE (VISIBILITY-PER-PHOTO-APPROVAL) ─────────────────────
    // When the prior (outlet, window) capture is CHANGES_REQUESTED, carry the APPROVED
    // photos forward UNTOUCHED and accept new media ONLY for the non-approved CAMERA fields.
    // The prior row is the passed resubmit row, else the existing row for this window (so a
    // rep cannot bypass the merge by calling plain submit instead of resubmit).
    const priorRow =
      existing ??
      (await this.prisma.visibilityCapture.findUnique({
        where: {
          clientId_outletId_windowKey: {
            clientId: user.clientId,
            outletId: outlet.id,
            windowKey,
          },
        },
        select: { id: true, status: true, formValues: true, photoReviews: true, currentVersion: true },
      }));

    const isMerge = !!priorRow && priorRow.status === 'CHANGES_REQUESTED';
    const priorValues: Record<string, unknown> =
      isMerge && priorRow!.formValues && typeof priorRow!.formValues === 'object' && !Array.isArray(priorRow!.formValues)
        ? (priorRow!.formValues as Record<string, unknown>)
        : {};
    const carriedReviews: PhotoReviews = {};
    let effectiveRaw: Record<string, unknown> = cleaned;

    if (isMerge) {
      const priorReviews = readPhotoReviews(priorRow!.photoReviews);
      // Start from the full prior snapshot (keeps non-photo answers stable) and overlay only
      // the rep's new media for the non-approved photos.
      const merged: Record<string, unknown> = { ...priorValues };
      for (const f of schema.fields ?? []) {
        if (f.type !== 'CAMERA') continue;
        const pr = priorReviews[f.id];
        if (pr && pr.status === 'APPROVED') {
          // ANTI-TAMPER: the STORED approved photo is authoritative — a resubmit payload can
          // never replace it. Keep the stored media value + carry its APPROVED review untouched.
          merged[f.id] = priorValues[f.id];
          carriedReviews[f.id] = pr;
        } else if (Object.prototype.hasOwnProperty.call(cleaned, f.id)) {
          // Rejected/pending photo → accept the rep's new media; its review is cleared (pending).
          merged[f.id] = cleaned[f.id];
        }
      }
      effectiveRaw = merged;
    }

    const { errors, values } = validateSubmittedValues(schema, { ...effectiveRaw, ...ctx });
    if (errors.length > 0) {
      throw new BadRequestException(`Form validation failed: ${errors.join(' | ')}`);
    }

    // Defensive anti-tamper re-assert: an APPROVED photo always resolves to the STORED value,
    // regardless of what the resubmit payload contained (the merge already forced this).
    if (isMerge) {
      for (const fieldId of Object.keys(carriedReviews)) {
        if (Object.prototype.hasOwnProperty.call(priorValues, fieldId)) {
          values[fieldId] = priorValues[fieldId];
        }
      }
    }

    // L1 — every submitted CAMERA key must live under THIS caller's tenant media folder;
    // a rep cannot point a capture at an arbitrary/cross-tenant object.
    this.assertMediaKeysOwned(user.clientId, schema, values);

    // The photoReviews to persist on the re-opened capture: carried-forward APPROVED photos
    // on a partial re-capture; nothing (null) on a fresh submit / whole-capture re-capture.
    const resubmitReviews: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      Object.keys(carriedReviews).length > 0
        ? (carriedReviews as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    // ── OUTLET-MASTER GEO-FENCE GATE (Bajaj-only via clients.features.outletMasterGeo) ──────
    // When ON: the fence REFERENCE becomes the OUTLET-MASTER lat/long (not the KYC board photo),
    // the fence is FORCE-ENABLED at OUTLET_MASTER_GEOFENCE_RADIUS_M (ignoring visibilityConfig.
    // geoFence.enabled/radiusMeters), and an OUTSIDE capture is blocked with the owner's exact
    // message. Missing outlet-master coords OR no photo GPS fix → 'unverifiable' (allow + flag),
    // never a hard-block. When OFF → EXACTLY today's behavior (KYC board-photo ref + the tenant's
    // visibilityConfig.geoFence), byte-identical for Deoleo / every non-gated tenant.
    const geoFeatures = await this.resolveGeoFeatures(user.clientId);
    const outletMasterGeoEnabled = geoFeatures.outletMasterGeo === true;

    // ── LOCATION GATE ("no location, no use" — features.requireLocation, sales reps only; LOCATION-GATE.md) ──
    // OFF (default, every tenant incl. Deoleo) → nothing here runs. ON → every location-tagged photo the rep submits
    // NOW must carry a valid fix (carried-forward approved photos are not re-checked), else 400 before any write.
    const locationRequired = isLocationRequiredFor(geoFeatures, user.role);
    if (locationRequired) {
      if (isPhoneClockWrong(gateInput.clientNow)) throw new BadRequestException(PHONE_CLOCK_WRONG_MESSAGE);
      const refusal = visibilityLocationRefusal(schema, values, new Set(Object.keys(carriedReviews)), cleaned, gateInput.captureGeo, {
        clientNow: gateInput.clientNow,
        evalValues: { ...effectiveRaw, ...ctx }, // the exact map validation evaluated
      });
      if (refusal) throw new BadRequestException(refusal);
    }
    const recordOutside = (distanceM: number | null, accuracyM: number | null) =>
      locationRequired
        ? recordFenceBlock(this.prisma, {
            actorId: user.sub,
            clientId: user.clientId,
            flow: 'VISIBILITY',
            outletId: outlet.id,
            distanceM,
            accuracyM,
          })
        : Promise.resolve();
    // isUsableReference (not just a null-check) guards the OUTLET-MASTER coords: a 0/0 sentinel
    // or out-of-range master value → treated as NO reference → 'unverifiable' (allow+flag) in
    // both fence paths below, never a spurious block of a rep at the real outlet.
    // Shared with the review badges (geo-fence.helper outletMasterReference) so the two never drift.
    const outletMasterRef = outletMasterGeoEnabled ? outletMasterReference(outlet) : null;
    // Effective fence params: forced on at the shared 200 m under the gate; the tenant's config otherwise.
    const fenceEnabled = outletMasterGeoEnabled ? true : config.geoFence.enabled;
    const fenceRadius = outletMasterGeoEnabled
      ? OUTLET_MASTER_GEOFENCE_RADIUS_M
      : config.geoFence.radiusMeters;
    const OUTSIDE_FENCE_MESSAGE =
      'You are far from the outlet. Please go to the outlet and try again.';

    // Geo-fence — TWO paths, chosen by the form schema. A form with ≥1 CAMERA field
    // flagged `geoFenceRequired` uses the NEW per-photo path (each such photo's embedded
    // shutter-time geo is fenced); otherwise fall through to the LEGACY single-GPS_POINT
    // path, byte-identical to before. Both fold into the same typed columns
    // (geoFenceOk / distanceMeters / captureLat|Lng|Accuracy / capturedAt).
    const fenceFields = (schema.fields ?? []).filter(
      (f) => f.type === 'CAMERA' && f.geoFenceRequired === true,
    );
    // Which fence photos are EVALUATED. Outlet-master fence tenants (Bajaj): only the fence photos that APPLY to this
    // outlet — visible under its visibleWhen (incl. the outlet's Sub-Program) and required or actually captured. A
    // hidden conditional slot (Privilege-only Window 2 at an Elite outlet) or an optional empty slot is no longer read
    // as an "unverifiable" photo (prod bug 2026-11-19). A required-but-empty slot never gets here — validation already
    // refused it. Every other tenant (Deoleo): all fence fields, exactly as before. The PATH choice (per-photo vs legacy)
    // still follows the schema, so a capture whose applicable list is empty stays on the per-photo path (unverifiable).
    const evaluatedFenceFields = outletMasterGeoEnabled
      ? applicableCameraFields(schema, { ...effectiveRaw, ...ctx }, (f) => f.geoFenceRequired === true, values)
      : fenceFields;

    const flags: string[] = [];
    let distanceMeters: number | null;
    let geoFenceOk: boolean | null;
    // `repGeo` = the representative photo used for the map-pin columns (the FIRST
    // fence-required photo that had a fix; legacy path → the single GPS_POINT fix).
    let repGeo: CaptureGeo;
    // The fence reference, kept for the location-gate STORED location below (switch-on tenants only).
    let storeReference: { lat: number; lng: number } | null = null;

    if (fenceFields.length > 0) {
      // ── NEW PER-PHOTO PATH ──────────────────────────────────────────────────────
      // Reference geo, resolved ONCE: the OUTLET-MASTER lat/long under the outletMasterGeo gate,
      // else the legacy latest-APPROVED KYC board-photo geo. Radius likewise is the forced 200 m
      // under the gate, else the tenant's configured radius.
      const reference = outletMasterGeoEnabled
        ? outletMasterRef
        : await this.outletReferenceGeo(user.clientId, outlet.partnerId);
      const radius = fenceRadius;
      storeReference = reference;

      let anyInside = false;
      let anyOutside = false;
      let anyUnverifiable = false;
      let outsideLabel: string | null = null;
      let worstDistance: number | null = null; // max distance among fence photos with a fix
      let worstGeo: GpsCapture | null = null; // representative pin = the worst (farthest) fixed photo

      if (evaluatedFenceFields.length === 0) anyUnverifiable = true; // nothing applicable with a photo = "no fix", as today
      // ONE policy for every photo — the SAME resolution the reviewer's per-photo badges use
      // (geo-fence.helper classifyPhotoFence). ACCURACY BUFFER (outlet-master tenants only): a fix whose OWN reported
      // accuracy is worse than the fence radius cannot place the photo in/out → 'unverifiable' (allow + flag), never a
      // block. Non-gated tenants: no buffer (byte-identical).
      const policy: PhotoFencePolicy = {
        reference,
        radiusMeters: radius,
        accuracyBuffer: outletMasterGeoEnabled,
        nullIslandUnverifiable: outletMasterGeoEnabled,
      };
      for (const f of evaluatedFenceFields) {
        const g = readMediaValue(values[f.id]).geo ?? null;
        const { status, accuracyTooLow } = classifyPhotoFence(g, policy);
        if (accuracyTooLow) {
          // unverifiable — no distance for an untrustworthy fix
        } else if (status !== 'unverifiable' && reference && isValidGeo(g)) {
          const d = haversineMeters(g.lat, g.lng, reference.lat, reference.lng);
          const rounded = Math.round(d * 100) / 100;
          // Track the worst (farthest) fixed photo so the map pin (repGeo) and distanceMeters
          // always reference the SAME photo (audit fix — a pin/distance mismatch misled the reviewer).
          if (worstDistance === null || rounded > worstDistance) {
            worstDistance = rounded;
            worstGeo = g;
          }
        }
        if (status === 'inside') anyInside = true;
        else if (status === 'outside') {
          anyOutside = true;
          if (!outsideLabel) outsideLabel = f.label;
        } else {
          anyUnverifiable = true; // 'unverifiable'
        }
      }

      // Aggregate verdict (audit HIGH fix — "geoFenceOk === true" must mean GENUINELY verified
      // at the outlet, never "merely not caught outside"):
      //   • fence DISABLED            → null  (nothing was enforced; mirror the legacy path)
      //   • any photo OUTSIDE         → false (blocked below when enabled)
      //   • EVERY fence photo inside  → true  (a real pass — no unverifiable, no outside)
      //   • else (≥1 unverifiable, none outside) → null (surfaces UNVERIFIABLE to the approver;
      //     an absent fix per owner D1 flags-but-doesn't-block, but must NOT read as a clean pass).
      if (!fenceEnabled) {
        geoFenceOk = null;
      } else if (anyOutside) {
        geoFenceOk = false;
      } else if (anyUnverifiable || !anyInside) {
        geoFenceOk = null;
      } else {
        geoFenceOk = true;
      }
      distanceMeters = worstDistance;
      repGeo = this.photoToCaptureGeo(worstGeo);

      if (fenceEnabled) {
        if (anyOutside) {
          await recordOutside(worstDistance, typeof worstGeo?.accuracy === 'number' ? worstGeo.accuracy : null);
          throw new ForbiddenException(
            outletMasterGeoEnabled
              ? OUTSIDE_FENCE_MESSAGE
              : `Capture is outside the allowed ${radius}m radius of the outlet` +
                  (outsideLabel ? ` — photo "${outsideLabel}" is out of range.` : '.'),
          );
        }
        if (anyUnverifiable) flags.push('GEO_UNVERIFIABLE');
      }

      // Advisory flags (non-blocking) from the representative photo geo.
      if (repGeo.capturedAt) {
        const skew = Math.abs(now.getTime() - repGeo.capturedAt.getTime());
        if (skew > CLOCK_SKEW_FLAG_MS) flags.push('CLOCK_SKEW');
      }
      if (repGeo.accuracy != null && repGeo.accuracy > LOW_ACCURACY_FLAG_M) {
        flags.push('LOW_ACCURACY');
      }
    } else {
      // ── LEGACY SINGLE-GPS_POINT PATH ────────────────────────────────────────────
      // Byte-identical to before when outletMasterGeo is OFF. Under the gate, the reference +
      // enabled + radius are OVERRIDDEN to the outlet-master coords / forced 200 m (the override
      // is undefined otherwise, so evaluateGeoFence runs its original config-driven logic).
      const extracted = this.extractCaptureGeo(schema, values);
      // Outlet-master tenants: a 0,0 GPS value is the "no location" default, never a fix — unverifiable (allow + flag),
      // never "far from the outlet". Every other tenant: exactly as before.
      const geo =
        outletMasterGeoEnabled && extracted.lat === 0 && extracted.lng === 0
          ? { lat: null, lng: null, accuracy: null, capturedAt: null }
          : extracted;
      const res = await this.evaluateGeoFence(
        user.clientId,
        outlet.partnerId,
        config,
        geo,
        outletMasterGeoEnabled
          ? { reference: outletMasterRef, enabled: fenceEnabled, radiusMeters: fenceRadius }
          : undefined,
      );
      // ACCURACY BUFFER (gated path only): a fix whose OWN reported accuracy is worse than the
      // fence radius cannot be trusted to place the capture in/out — treat as 'unverifiable'
      // (allow + flag via the geoFenceOk===null branch below), never a distance-based block.
      // Non-gated tenants never take this branch (byte-identical).
      const accuracyTooLow =
        outletMasterGeoEnabled &&
        geo.accuracy != null &&
        Number.isFinite(geo.accuracy) &&
        geo.accuracy > fenceRadius;
      distanceMeters = accuracyTooLow ? null : res.distanceMeters;
      geoFenceOk = accuracyTooLow ? null : res.geoFenceOk;
      repGeo = geo;
      if (locationRequired) {
        storeReference = outletMasterGeoEnabled ? outletMasterRef : await this.outletReferenceGeo(user.clientId, outlet.partnerId);
      }

      const captureGeoPresent = geo.lat != null && geo.lng != null;
      if (fenceEnabled) {
        // H1 — FAIL-CLOSED when a reference geo EXISTS but the capture geo is
        // missing/unparseable/out-of-range: a rep must not be able to defeat the fence by
        // sending no/garbage GPS. (No reference geo → allow-but-flag GEO_UNVERIFIABLE below.)
        // SKIPPED under the outletMasterGeo gate — the owner's rule there is "no photo GPS →
        // UNVERIFIABLE (allow + flag), never block"; only an OUTSIDE fix is blocked.
        if (!outletMasterGeoEnabled && res.referencePresent && !captureGeoPresent) {
          throw new ForbiddenException(
            'A valid GPS location is required to capture at this outlet (geo-fence is enabled).',
          );
        }
        if (geoFenceOk === false) {
          await recordOutside(res.distanceMeters, geo.accuracy);
          throw new ForbiddenException(
            outletMasterGeoEnabled
              ? OUTSIDE_FENCE_MESSAGE
              : `Capture is outside the allowed ${config.geoFence.radiusMeters}m radius of the outlet.`,
          );
        }
      }

      // Advisory flags (non-blocking): clock skew + low GPS accuracy.
      if (geo.capturedAt) {
        const skew = Math.abs(now.getTime() - geo.capturedAt.getTime());
        if (skew > CLOCK_SKEW_FLAG_MS) flags.push('CLOCK_SKEW');
      }
      if (geo.accuracy != null && geo.accuracy > LOW_ACCURACY_FLAG_M) flags.push('LOW_ACCURACY');
      if (geoFenceOk === null && fenceEnabled) flags.push('GEO_UNVERIFIABLE');
    }

    // ── LOCATION GATE (switch-on tenants only) — always STORE a representative real fix (audit #1) ──
    // The fence above only sets the map-pin columns when it could measure a distance (outlet coordinates on file, a
    // usable accuracy, or a GPS_POINT form). Without that, a capture whose photos DID carry a fix would be stored with
    // NULL captureLat/Lng and counted as "No GPS" by the Location report / digest. Fallback order: the first real
    // tagged-photo fix, else the phone's submit-time captureGeo, else a GPS field. Only the stored location columns
    // change — the fence verdict (geoFenceOk / distanceMeters) and the flags are untouched, so a poor-accuracy fix is
    // reported as poor accuracy. Switch-off tenants (Deoleo) store exactly what they stored before.
    // Round 4 #2: on switch-on tenants the STORED representative location is ALWAYS chosen fresh-first (new photos of
    // this request → captureGeo → GPS sent now → carried-forward), never the farthest of the MERGED values (which can be
    // an old carried photo). The fence VERDICT (geoFenceOk, blocking, flags) still uses every photo as before. The stored
    // distance is recomputed for that same stored fix (pin and distance always describe one fix; null without a
    // reference or when the fix's own accuracy is worse than the fence radius — the same buffer rule as the fence).
    if (locationRequired) {
      const chosen = this.firstRealFix(schema, values, gateInput.captureGeo, cleaned, new Set(Object.keys(carriedReviews)));
      if (chosen) {
        repGeo = this.photoToCaptureGeo(chosen);
        const acc = typeof chosen.accuracy === 'number' && Number.isFinite(chosen.accuracy) ? chosen.accuracy : null;
        distanceMeters =
          storeReference && !(acc != null && acc > fenceRadius)
            ? Math.round(haversineMeters(chosen.lat, chosen.lng, storeReference.lat, storeReference.lng) * 100) / 100
            : null;
      }
    }

    // Hash the capture photos BEFORE the transaction (network I/O outside the tx).
    const hashes = await this.hashCaptureMedia(user.clientId, schema, values);

    const jsonValues = values as Prisma.InputJsonValue;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // FIRST-APPROVED-WINS (D7): an APPROVED capture already satisfies this window.
        const approved = await tx.visibilityCapture.findFirst({
          where: {
            clientId: user.clientId,
            outletId: outlet.id,
            windowKey,
            status: 'APPROVED',
          },
          select: { id: true },
        });
        if (approved) {
          throw new ConflictException('This window is already satisfied by an approved capture.');
        }

        // Re-read the current row inside the tx (or the passed REJECTED row for resubmit).
        const current = existing
          ? await tx.visibilityCapture.findUnique({ where: { id: existing.id } })
          : await tx.visibilityCapture.findUnique({
              where: {
                clientId_outletId_windowKey: {
                  clientId: user.clientId,
                  outletId: outlet.id,
                  windowKey,
                },
              },
            });

        let capture;
        let version: number;

        if (!current) {
          version = 1;
          capture = await tx.visibilityCapture.create({
            data: {
              clientId: user.clientId,
              outletId: outlet.id,
              outletCode: outlet.outletCode,
              outletName: outlet.name,
              windowKey,
              status: 'SUBMITTED',
              formValues: jsonValues,
              // Fresh v1 — no reviews yet.
              photoReviews: Prisma.JsonNull,
              currentVersion: 1,
              formVersion,
              captureLat: repGeo.lat,
              captureLng: repGeo.lng,
              captureAccuracy: repGeo.accuracy,
              distanceMeters,
              geoFenceOk,
              capturedAt: repGeo.capturedAt,
              receivedAt: now,
              submittedBySalesUserId: caller.id,
            },
          });
        } else if (current.status === 'REJECTED' || current.status === 'CHANGES_REQUESTED') {
          version = current.currentVersion + 1;
          capture = await tx.visibilityCapture.update({
            where: { id: current.id },
            data: {
              // Re-opened for re-review (always SUBMITTED): the rejected photo(s) are now
              // pending again; a whole-capture REJECTED re-capture carries no reviews.
              status: 'SUBMITTED',
              formValues: jsonValues,
              // Partial re-capture carries the APPROVED photos' reviews forward; a whole-capture
              // re-capture clears them (null).
              photoReviews: resubmitReviews,
              currentVersion: version,
              formVersion,
              captureLat: repGeo.lat,
              captureLng: repGeo.lng,
              captureAccuracy: repGeo.accuracy,
              distanceMeters,
              geoFenceOk,
              capturedAt: repGeo.capturedAt,
              receivedAt: now,
              submittedBySalesUserId: caller.id,
              // Re-open cleanly: clear the prior whole-capture rejection + review attribution.
              rejectionReason: null,
              rejectionReasonCode: null,
              approvedByUserId: null,
              reviewedAt: null,
              updatedAt: now,
            },
          });
        } else {
          // SUBMITTED (awaiting review) — a fresh submit cannot silently overwrite it.
          throw new BadRequestException(
            'This outlet already has a capture awaiting review for the current window.',
          );
        }

        await tx.visibilityCaptureSubmission.create({
          data: {
            clientId: user.clientId,
            captureId: capture.id,
            outletId: outlet.id,
            windowKey,
            version,
            status: 'SUBMITTED',
            formValues: jsonValues,
            // Per-version snapshot of the reviews carried into this version (null for v1 /
            // whole-capture re-capture; carried APPROVED reviews on a partial re-capture).
            photoReviews: resubmitReviews,
            formVersion,
            captureLat: repGeo.lat,
            captureLng: repGeo.lng,
            captureAccuracy: repGeo.accuracy,
            distanceMeters,
            geoFenceOk,
            submittedBySalesUserId: caller.id,
          },
        });

        const { dupHashes } = await this.media.recordImageHashes(
          tx,
          user.clientId,
          capture.id,
          hashes,
        );

        return {
          capture,
          version,
          geoFenceOk,
          distanceMeters,
          flags,
          duplicatePhoto: dupHashes.length > 0,
        };
      });
    } catch (e) {
      // The (clientId,outletId,windowKey) or (captureId,version) unique raced a concurrent
      // submit → clean 409 rather than a raw 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A concurrent capture occurred for this window — please retry.');
      }
      throw e;
    }
  }

  // ── Geo helpers ─────────────────────────────────────────────────────────────

  /** Parse the capture geo from the schema's GPS_POINT field of the validated values. */
  private extractCaptureGeo(
    schema: VisibilityFormSchema,
    values: Record<string, unknown>,
  ): CaptureGeo {
    const gpsField = (schema.fields ?? []).find((f) => f.type === 'GPS_POINT');
    const empty: CaptureGeo = { lat: null, lng: null, accuracy: null, capturedAt: null };
    if (!gpsField) return empty;

    const raw = values[gpsField.id];
    // Range-validated lat/lng ONLY (lat −90..90, lng −180..180); garbage/out-of-range
    // yields null lat/lng so the geo-fence treats it as "no usable capture geo" (H1).
    const point = parseGpsPoint(raw);
    if (!point) return empty;

    // accuracy + capturedAt are advisory; pull them from the (already object-or-JSON) blob.
    let obj: Record<string, unknown> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      obj = raw as Record<string, unknown>;
    } else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>;
        }
      } catch {
        obj = {};
      }
    }
    const accuracy = this.toNum(obj.accuracy);
    let capturedAt: Date | null = null;
    const at = obj.capturedAt ?? values['capturedAt'];
    if (typeof at === 'string' || typeof at === 'number') {
      const d = new Date(at);
      if (!isNaN(d.getTime())) capturedAt = d;
    }
    return { lat: point.lat, lng: point.lng, accuracy, capturedAt };
  }

  private toNum(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Project a per-photo `GpsCapture` (the embedded shutter-time fix) onto the internal
   * CaptureGeo shape used for the map-pin columns. `null` (no representative photo) →
   * all-null. Mirrors extractCaptureGeo's accuracy/capturedAt coercion.
   */
  /**
   * Location gate: the representative real fix to STORE — FRESH sources first (round-3 #8): new tagged photos of this
   * request, then the submit-time `captureGeo`, then GPS fields sent in this request; carried-forward photos / merged
   * GPS values only when nothing fresh exists (the gate rule normally guarantees a fresh one).
   */
  private firstRealFix(
    schema: VisibilityFormSchema,
    values: Record<string, unknown>,
    captureGeo: unknown,
    requestValues: Record<string, unknown> = {},
    carried: ReadonlySet<string> = new Set(),
  ): GpsCapture | null {
    const inRequest = (id: string) => Object.prototype.hasOwnProperty.call(requestValues, id) && !carried.has(id);
    const asCapture = (raw: unknown): GpsCapture | null => {
      const val = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
      const p = parseGpsPoint(val);
      if (!p || !isRealFix(p)) return null;
      const o = (val ?? {}) as Record<string, unknown>;
      return {
        lat: p.lat,
        lng: p.lng,
        accuracy: typeof o.accuracy === 'number' && Number.isFinite(o.accuracy) ? o.accuracy : undefined,
        capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : undefined,
      };
    };
    const fields = schema.fields ?? [];
    const tagged = fields.filter((f) => f.type === 'CAMERA' && (f.geoFenceRequired === true || f.geotag === true));
    const gps = fields.filter((f) => f.type === 'GPS_POINT');
    const photoFix = (id: string) => {
      const g = readMediaValue(values[id]).geo;
      return g && isRealFix(g) ? g : null;
    };
    for (const f of tagged) if (inRequest(f.id)) { const g = photoFix(f.id); if (g) return g; }
    const submitFix = asCapture(captureGeo);
    if (submitFix) return submitFix;
    for (const f of gps) if (inRequest(f.id)) { const g = asCapture(values[f.id]); if (g) return g; }
    // Nothing fresh — fall back to carried-forward / merged-back values.
    for (const f of tagged) { const g = photoFix(f.id); if (g) return g; }
    for (const f of gps) { const g = asCapture(values[f.id]); if (g) return g; }
    return null;
  }

  private photoToCaptureGeo(g: GpsCapture | null): CaptureGeo {
    if (!g) return { lat: null, lng: null, accuracy: null, capturedAt: null };
    let capturedAt: Date | null = null;
    if (typeof g.capturedAt === 'string' || typeof g.capturedAt === 'number') {
      const d = new Date(g.capturedAt);
      if (!isNaN(d.getTime())) capturedAt = d;
    }
    return { lat: g.lat, lng: g.lng, accuracy: this.toNum(g.accuracy), capturedAt };
  }

  /**
   * Compare the capture geo to the outlet's reference geo (latest APPROVED
   * KycSubmission.boardPhotoLat/Lng of the owner partner). Returns:
   *   geoFenceOk = true  → within radius; false → outside (caller BLOCKS on false);
   *   null → reference geo unavailable OR no capture geo → ALLOW but FLAG (D10).
   */
  private async evaluateGeoFence(
    clientId: string,
    partnerId: string | null,
    config: VisibilityConfigSettings,
    geo: CaptureGeo,
    // Outlet-master geo-fence OVERRIDE (Bajaj-only). When present it supplies the reference geo +
    // forced enabled/radius, replacing the KYC-board reference and config.geoFence. Undefined →
    // the original config-driven logic (byte-identical for every non-gated tenant).
    override?: { reference: { lat: number; lng: number } | null; enabled: boolean; radiusMeters: number },
  ): Promise<{ distanceMeters: number | null; geoFenceOk: boolean | null; referencePresent: boolean }> {
    // referencePresent distinguishes the two null cases for the caller (H1):
    //   ref exists + no capture geo  → caller HARD-BLOCKS (non-gated path only);
    //   no ref                       → allow-but-flag GEO_UNVERIFIABLE.
    const ref = override ? override.reference : await this.outletReferenceGeo(clientId, partnerId);
    const referencePresent = !!ref;
    if (geo.lat == null || geo.lng == null || !ref) {
      return { distanceMeters: null, geoFenceOk: null, referencePresent };
    }
    const distance = haversineMeters(geo.lat, geo.lng, ref.lat, ref.lng);
    const rounded = Math.round(distance * 100) / 100;
    // geoFenceOk is only meaningful when the fence is enabled; when off we still record
    // the informational distance but leave the pass/fail null (no enforcement).
    const fenceEnabled = override ? override.enabled : config.geoFence.enabled;
    const fenceRadius = override ? override.radiusMeters : config.geoFence.radiusMeters;
    const geoFenceOk = fenceEnabled ? distance <= fenceRadius : null;
    return { distanceMeters: rounded, geoFenceOk, referencePresent };
  }

  /**
   * Outlet-master geo-fence gate (Bajaj-only). Reuses the SAME feature resolution
   * admin-outlets.service.ts uses — a direct Client.features read. OFF for every other tenant
   * (incl. live Deoleo), so the gated behavior never touches them.
   */
  private async resolveGeoFeatures(clientId: string): Promise<Record<string, unknown>> {
    const c = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { features: true },
    });
    return ((c?.features ?? {}) as Record<string, unknown>) ?? {};
  }

  /**
   * Latest APPROVED KYC board-photo geo for THIS outlet's own owner partner, if any.
   *
   * M3 TOPOLOGY (owner-group model = "Option B", PARTNER-MULTI-OUTLET.md): each child
   * outlet keeps its OWN operating ChannelPartner; the parent grouping is carried by
   * `Outlet.parentId`, NEVER by `Outlet.partnerId`. So `partnerId` is one-to-one with the
   * outlet in the operating sense, and its latest APPROVED KYC board geo IS that outlet's
   * physical location. (`Outlet.latitude/longitude` columns exist but are never written,
   * so they cannot serve as a per-outlet reference.) Resolution is therefore already
   * per-outlet and correct — left as-is.
   */
  private async outletReferenceGeo(
    clientId: string,
    partnerId: string | null,
  ): Promise<{ lat: number; lng: number } | null> {
    if (!partnerId) return null;
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: partnerId, clientId },
      select: {
        kycSubmissions: {
          where: { status: 'APPROVED', boardPhotoLat: { not: null }, boardPhotoLng: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { boardPhotoLat: true, boardPhotoLng: true },
        },
      },
    });
    const sub = partner?.kycSubmissions?.[0];
    if (!sub || sub.boardPhotoLat == null || sub.boardPhotoLng == null) return null;
    return { lat: Number(sub.boardPhotoLat), lng: Number(sub.boardPhotoLng) };
  }

  // ── Media hashing ─────────────────────────────────────────────────────────────

  /**
   * L1 — assert every CAMERA field's stored key lives under `visibility-media/<clientId>/`
   * so a rep cannot submit (or later have exported) a capture that references an arbitrary
   * or cross-tenant object. A non-string / foreign-prefixed key is a 400.
   */
  private assertMediaKeysOwned(
    clientId: string,
    schema: VisibilityFormSchema,
    values: Record<string, unknown>,
  ): void {
    const tenantPrefix = `${MEDIA_FOLDER_PREFIX}${clientId}/`;
    for (const f of schema.fields ?? []) {
      if (f.type !== 'CAMERA') continue;
      const v = values[f.id];
      if (v == null || v === '') continue; // absent/optional — required-ness already validated
      // A value may be a bare key string OR a `{ key, geo }` object (per-photo geotag) —
      // extract the object key BEFORE the tenant-ownership check so a geotagged capture
      // is not rejected as "not a string".
      const key = readMediaValue(v).key;
      if (!key.startsWith(tenantPrefix)) {
        throw new BadRequestException(
          `Field "${f.label}" (${f.id}) references an invalid or cross-tenant media key.`,
        );
      }
    }
  }

  /**
   * Download + SHA-256 the tenant-owned CAMERA photos of the submission (outside any
   * transaction). Only keys under this tenant's media folder are fetched — an arbitrary
   * key is never downloaded. Returns the list of hex hashes for recordImageHashes.
   */
  private async hashCaptureMedia(
    clientId: string,
    schema: VisibilityFormSchema,
    values: Record<string, unknown>,
  ): Promise<string[]> {
    const tenantPrefix = `${MEDIA_FOLDER_PREFIX}${clientId}/`;
    const keys: string[] = [];
    for (const f of schema.fields ?? []) {
      if (!MEDIA_FIELD_TYPES.has(f.type)) continue;
      // Extract `.key` via readMediaValue so the hash is stable whether the value is a
      // bare key string or a `{ key, geo }` object (the embedded geo never affects it).
      const key = readMediaValue(values[f.id]).key;
      if (key.startsWith(tenantPrefix)) keys.push(key);
    }
    const hashes: string[] = [];
    for (const key of keys) {
      // Streamed into the hash (memory-safety): the photo is never held whole in memory.
      // Missing / oversize / unreadable object → skipped, exactly as before.
      const file = await this.storage.openBoundedObject(key);
      if (!file) continue;
      const hash = await this.media.computeImageHashFromStream(file.stream);
      if (hash) hashes.push(hash);
    }
    return hashes;
  }
}

/**
 * Strip reserved outlet-context keys (`__…__`) from a client-submitted values map
 * (Design B). The capture service re-injects the SERVER-derived context for clause
 * evaluation only — a client must never be able to supply (and thus spoof) one of these
 * values, e.g. to suppress a `requiredWhen __subProgram__ == X` photo. Pure + module-local.
 */
function stripReservedKeys(
  v: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v ?? {})) {
    if (/^__.*__$/.test(k)) continue;
    out[k] = val;
  }
  return out;
}

/**
 * Great-circle distance in metres between two lat/lng points (haversine). Pure — kept
 * module-local so the geo-fence math is unit-testable without the DI container.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000; // Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
