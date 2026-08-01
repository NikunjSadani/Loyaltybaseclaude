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
  SalesUserEdge,
} from '../sales/sales-hierarchy-access.helper';
import { VisibilityMediaService } from './visibility-media.service';
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
} from './visibility-form.helper';
import { VisibilityFormSchema, GpsCapture } from './visibility-types';
import { evaluatePhotoFence, isValidGeo } from './geo-fence.helper';
import { SubmitCaptureDto, ResubmitCaptureDto } from './dto/visibility-capture.dto';

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

  private async loadSalesEdges(clientId: string): Promise<SalesUserEdge[]> {
    return this.prisma.salesUser.findMany({
      where: { clientId, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
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
    const caller = await this.requireCallerSalesUser(user);

    const levelAllowed = config.allowedSalesLevels.includes(caller.levelCode);
    const now = new Date();
    const freq = this.freqOf(config);
    const windowKey = currentWindowKey(now, freq);
    const { startDay, endDay } = windowBoundsForKey(windowKey, freq);
    const windowClosed = isWindowClosed(windowKey, now, freq);

    const reach = await this.reachOutletIds(user.clientId, caller.id);
    if (reach.size === 0 || config.outletScope.length === 0) {
      return {
        windowKey,
        window: { startDay, endDay },
        levelAllowed,
        outlets: [],
      };
    }

    const outlets = await this.prisma.outlet.findMany({
      where: {
        clientId: user.clientId,
        id: { in: [...reach] },
        deletedAt: null,
        deactivatedAt: null,
        isActive: true,
        outletType: { code: { in: config.outletScope } },
      },
      select: {
        id: true,
        outletCode: true,
        name: true,
        zone: true,
        state: true,
        outletType: { select: { code: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    const captures = await this.prisma.visibilityCapture.findMany({
      where: { clientId: user.clientId, windowKey, outletId: { in: outlets.map((o) => o.id) } },
      select: { outletId: true, id: true, status: true, currentVersion: true, rejectionReason: true },
    });
    const byOutlet = new Map(captures.map((c) => [c.outletId, c]));

    return {
      windowKey,
      window: { startDay, endDay },
      levelAllowed,
      outlets: outlets.map((o) => {
        const cap = byOutlet.get(o.id) ?? null;
        return {
          outletId: o.id,
          outletCode: o.outletCode,
          outletName: o.name,
          zone: o.zone,
          state: o.state,
          outletType: o.outletType,
          captureId: cap?.id ?? null,
          status: cap?.status ?? null,
          currentVersion: cap?.currentVersion ?? null,
          rejectionReason: cap?.rejectionReason ?? null,
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
        outletType: { select: { code: true, name: true } },
      },
    });
    if (!outlet) throw new NotFoundException('Outlet not found.');

    const now = new Date();
    const freq = this.freqOf(config);
    const month = currentWindowKey(now, freq).slice(0, 7); // 'YYYY-MM'
    const windowKeys = windowsForMonth(month, freq);
    const levelAllowed = config.allowedSalesLevels.includes(caller.levelCode);
    const inScope = config.outletScope.includes(outlet.outletType.code);

    const captures = await this.prisma.visibilityCapture.findMany({
      where: { clientId: user.clientId, outletId, windowKey: { in: windowKeys } },
      select: { id: true, windowKey: true, status: true, currentVersion: true, rejectionReason: true },
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
    if (status === 'REJECTED') return 'rejected';
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
    return this.persistCapture(user, config, caller, outlet, dto.formValues, null);
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
    if (capture.status !== 'REJECTED') {
      throw new BadRequestException('Only a rejected capture can be resubmitted.');
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
    return this.persistCapture(user, config, caller, outlet, dto.formValues, capture);
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
        outletType: { select: { code: true } },
      },
    });
    if (!outlet) throw new NotFoundException('Outlet not found.');
    if (!config.outletScope.includes(outlet.outletType.code)) {
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
    outlet: { id: string; outletCode: string; name: string; partnerId: string | null },
    submittedRaw: Record<string, unknown> | undefined,
    existing: { id: string; status: string; currentVersion: number } | null,
  ) {
    const form = await this.prisma.visibilityForm.findUnique({
      where: { clientId: user.clientId },
    });
    if (!form) {
      throw new BadRequestException('No visibility form is configured for this tenant.');
    }
    const schema = form.formSchema as unknown as VisibilityFormSchema;
    const formVersion = form.version;

    const { errors, values } = validateSubmittedValues(schema, submittedRaw ?? {});
    if (errors.length > 0) {
      throw new BadRequestException(`Form validation failed: ${errors.join(' | ')}`);
    }

    // L1 — every submitted CAMERA key must live under THIS caller's tenant media folder;
    // a rep cannot point a capture at an arbitrary/cross-tenant object.
    this.assertMediaKeysOwned(user.clientId, schema, values);

    const now = new Date();
    const freq = this.freqOf(config);
    const windowKey = windowKeyForDate(now, freq);

    // Geo-fence — TWO paths, chosen by the form schema. A form with ≥1 CAMERA field
    // flagged `geoFenceRequired` uses the NEW per-photo path (each such photo's embedded
    // shutter-time geo is fenced); otherwise fall through to the LEGACY single-GPS_POINT
    // path, byte-identical to before. Both fold into the same typed columns
    // (geoFenceOk / distanceMeters / captureLat|Lng|Accuracy / capturedAt).
    const fenceFields = (schema.fields ?? []).filter(
      (f) => f.type === 'CAMERA' && f.geoFenceRequired === true,
    );

    const flags: string[] = [];
    let distanceMeters: number | null;
    let geoFenceOk: boolean | null;
    // `repGeo` = the representative photo used for the map-pin columns (the FIRST
    // fence-required photo that had a fix; legacy path → the single GPS_POINT fix).
    let repGeo: CaptureGeo;

    if (fenceFields.length > 0) {
      // ── NEW PER-PHOTO PATH ──────────────────────────────────────────────────────
      // Resolve the outlet reference geo ONCE (latest APPROVED KYC board-photo geo).
      const reference = await this.outletReferenceGeo(user.clientId, outlet.partnerId);
      const radius = config.geoFence.radiusMeters;

      let anyInside = false;
      let anyOutside = false;
      let anyUnverifiable = false;
      let outsideLabel: string | null = null;
      let worstDistance: number | null = null; // max distance among fence photos with a fix
      let worstGeo: GpsCapture | null = null; // representative pin = the worst (farthest) fixed photo

      for (const f of fenceFields) {
        const g = readMediaValue(values[f.id]).geo ?? null;
        const status = evaluatePhotoFence(g, reference, radius);
        if (reference && isValidGeo(g)) {
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
      if (!config.geoFence.enabled) {
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

      if (config.geoFence.enabled) {
        if (anyOutside) {
          throw new ForbiddenException(
            `Capture is outside the allowed ${radius}m radius of the outlet` +
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
      // ── LEGACY SINGLE-GPS_POINT PATH (unchanged) ────────────────────────────────
      const geo = this.extractCaptureGeo(schema, values);
      const res = await this.evaluateGeoFence(user.clientId, outlet.partnerId, config, geo);
      distanceMeters = res.distanceMeters;
      geoFenceOk = res.geoFenceOk;
      repGeo = geo;

      const captureGeoPresent = geo.lat != null && geo.lng != null;
      if (config.geoFence.enabled) {
        // H1 — FAIL-CLOSED when a reference geo EXISTS but the capture geo is
        // missing/unparseable/out-of-range: a rep must not be able to defeat the fence by
        // sending no/garbage GPS. (No reference geo → allow-but-flag GEO_UNVERIFIABLE below.)
        if (res.referencePresent && !captureGeoPresent) {
          throw new ForbiddenException(
            'A valid GPS location is required to capture at this outlet (geo-fence is enabled).',
          );
        }
        if (geoFenceOk === false) {
          throw new ForbiddenException(
            `Capture is outside the allowed ${config.geoFence.radiusMeters}m radius of the outlet.`,
          );
        }
      }

      // Advisory flags (non-blocking): clock skew + low GPS accuracy.
      if (geo.capturedAt) {
        const skew = Math.abs(now.getTime() - geo.capturedAt.getTime());
        if (skew > CLOCK_SKEW_FLAG_MS) flags.push('CLOCK_SKEW');
      }
      if (geo.accuracy != null && geo.accuracy > LOW_ACCURACY_FLAG_M) flags.push('LOW_ACCURACY');
      if (geoFenceOk === null && config.geoFence.enabled) flags.push('GEO_UNVERIFIABLE');
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
        } else if (current.status === 'REJECTED') {
          version = current.currentVersion + 1;
          capture = await tx.visibilityCapture.update({
            where: { id: current.id },
            data: {
              status: 'SUBMITTED',
              formValues: jsonValues,
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
              // Re-open cleanly: clear the prior rejection + review attribution.
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
  ): Promise<{ distanceMeters: number | null; geoFenceOk: boolean | null; referencePresent: boolean }> {
    // referencePresent distinguishes the two null cases for the caller (H1):
    //   ref exists + no capture geo  → caller HARD-BLOCKS;
    //   no ref                       → allow-but-flag GEO_UNVERIFIABLE.
    const ref = await this.outletReferenceGeo(clientId, partnerId);
    const referencePresent = !!ref;
    if (geo.lat == null || geo.lng == null || !ref) {
      return { distanceMeters: null, geoFenceOk: null, referencePresent };
    }
    const distance = haversineMeters(geo.lat, geo.lng, ref.lat, ref.lng);
    const rounded = Math.round(distance * 100) / 100;
    // geoFenceOk is only meaningful when the fence is enabled; when off we still record
    // the informational distance but leave the pass/fail null (no enforcement).
    const geoFenceOk = config.geoFence.enabled ? distance <= config.geoFence.radiusMeters : null;
    return { distanceMeters: rounded, geoFenceOk, referencePresent };
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
      const file = await this.storage.downloadBytes(key);
      if (file) hashes.push(this.media.computeImageHash(file.bytes));
    }
    return hashes;
  }
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
