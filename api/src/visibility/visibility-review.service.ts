import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { VisibilityFormSchema } from './visibility-types';
import {
  MEDIA_FIELD_TYPES,
  readMediaValue,
  GpsCapture,
  outletContextValues,
  readPhotoReviews,
  gatingCameraFieldIds,
  presentCameraFieldIds,
  deriveCaptureStatus,
  PhotoReview,
  PhotoReviews,
} from './visibility-form.helper';
import { evaluatePhotoFence, PhotoFenceStatus } from './geo-fence.helper';
import {
  AdminListCapturesQueryDto,
  VISIBILITY_REJECT_REASON_CODES,
} from './dto/visibility-capture.dto';
import { isGifsyOperator } from '../common/tenant-scope';

/**
 * The controlled reject-reason vocabulary for the Visibility review queue (D12).
 * Re-exported from the DTO's single source of truth so callers can import it from the
 * service (the DTO validator and this service validate against the same list).
 */
export const VISIBILITY_REJECT_REASONS = VISIBILITY_REJECT_REASON_CODES;

/**
 * VisibilityReviewService — GIFSY_ADMIN review of Visibility (POSM) captures (Stream B,
 * design D12). Approve / reject-with-reason (reject re-opens the window), plus the
 * captured-data queue: list (filters) + single-capture detail (values + auth-gated media
 * view paths + geo + submission history + cross-outlet duplicate-photo matches).
 *
 * A GIFSY_ADMIN is the cross-tenant operator; the assumed-tenant clientId lives in the
 * JWT (operator-context token). Every read/write is gated on the target capture's own
 * clientId (`visibilityEnabled`) and scoped by it.
 */
@Injectable()
export class VisibilityReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  private assertGifsy(user: JwtPayload): void {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Forbidden - Gifsy Admin only');
    }
  }

  private async assertEnabled(clientId: string): Promise<void> {
    if (!(await this.tenant.resolveVisibilityEnabled(clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /** Load a capture (tenant enforced from the row); 404 on miss. */
  private async loadCapture(user: JwtPayload, captureId: string) {
    const capture = await this.prisma.visibilityCapture.findFirst({
      where: { id: captureId, clientId: user.clientId },
    });
    if (!capture) throw new NotFoundException('Capture not found.');
    return capture;
  }

  // ── Per-photo + whole-capture review (D12 + VISIBILITY-PER-PHOTO-APPROVAL) ──────

  /**
   * The capture's form-version schema + the merged values (stored formValues + the
   * SERVER outlet context used for `requiredWhen`) + the raw formValues. The outlet context
   * is server-authoritative (never from the client), so the required-photo gating cannot be
   * spoofed. Both schema/outlet are null-safe.
   */
  private async resolveReviewContext(capture: {
    clientId: string;
    outletId: string;
    formVersion: number;
    formValues: Prisma.JsonValue | null;
  }): Promise<{
    schema: VisibilityFormSchema | null;
    merged: Record<string, unknown>;
    formValues: Record<string, unknown>;
  }> {
    const schema = await this.resolveFormSnapshot(capture.clientId, capture.formVersion);
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: capture.outletId, clientId: capture.clientId },
      select: { programCategory: true },
    });
    const formValues =
      capture.formValues && typeof capture.formValues === 'object' && !Array.isArray(capture.formValues)
        ? (capture.formValues as Record<string, unknown>)
        : {};
    const merged = { ...formValues, ...outletContextValues(outlet ?? {}) };
    return { schema, merged, formValues };
  }

  /**
   * Persist a review decision: update the live capture row AND mirror the review map onto
   * the CURRENT version's immutable submission snapshot (an additive annotation — the
   * evidence `formValues`/media keys are never touched), so each version retains its review
   * trace. One transaction.
   */
  private async persistReview(
    capture: { id: string; currentVersion: number },
    data: Prisma.VisibilityCaptureUncheckedUpdateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.visibilityCapture.update({ where: { id: capture.id }, data });
      await tx.visibilityCaptureSubmission.updateMany({
        where: { captureId: capture.id, version: capture.currentVersion },
        data: { photoReviews: data.photoReviews ?? Prisma.JsonNull },
      });
      return updated;
    });
  }

  /**
   * Review ONE photo (CAMERA field) individually: set its review and recompute + persist the
   * server-authoritative DERIVED capture status (all required photos APPROVED → APPROVED;
   * any REJECTED → CHANGES_REQUESTED; else SUBMITTED). GIFSY-gated. `fieldId` must be a
   * CAMERA field of the capture's form version that currently holds a submitted photo; a
   * REJECTED decision needs a controlled reasonCode.
   */
  async reviewPhoto(
    user: JwtPayload,
    captureId: string,
    fieldId: string,
    decision: PhotoReview['status'],
    reasonCode?: string,
    reason?: string,
  ) {
    this.assertGifsy(user);
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new BadRequestException('decision must be APPROVED or REJECTED.');
    }
    const capture = await this.loadCapture(user, captureId);
    await this.assertEnabled(capture.clientId);
    if (capture.status === 'APPROVED') {
      throw new BadRequestException('This capture is already approved.');
    }
    if (decision === 'REJECTED' && !(VISIBILITY_REJECT_REASONS as readonly string[]).includes(reasonCode ?? '')) {
      throw new BadRequestException(
        `reasonCode must be one of: ${VISIBILITY_REJECT_REASONS.join(', ')}`,
      );
    }

    const { schema, merged, formValues } = await this.resolveReviewContext(capture);
    const field = (schema?.fields ?? []).find((f) => f.id === fieldId && f.type === 'CAMERA');
    if (!field) {
      throw new BadRequestException(`"${fieldId}" is not a CAMERA field of this capture's form.`);
    }
    if (!readMediaValue(formValues[fieldId]).key) {
      throw new BadRequestException(`Field "${field.label}" has no submitted photo to review.`);
    }

    const now = new Date();
    const review: PhotoReview =
      decision === 'APPROVED'
        ? { status: 'APPROVED', reviewedAt: now.toISOString(), reviewedByUserId: user.sub }
        : {
            status: 'REJECTED',
            reasonCode: reasonCode,
            ...(reason ? { reason } : {}),
            reviewedAt: now.toISOString(),
            reviewedByUserId: user.sub,
          };
    const next: PhotoReviews = { ...readPhotoReviews(capture.photoReviews), [fieldId]: review };
    const derived = deriveCaptureStatus(gatingCameraFieldIds(schema, merged), next);

    const data: Prisma.VisibilityCaptureUncheckedUpdateInput = {
      status: derived,
      photoReviews: next as unknown as Prisma.InputJsonValue,
      reviewedAt: now,
      // Whole-capture rejection columns are reserved for reject-ALL; per-photo reasons live
      // inside photoReviews. Only stamp the final approver when the capture is fully APPROVED.
      rejectionReason: null,
      rejectionReasonCode: null,
      ...(derived === 'APPROVED' ? { approvedByUserId: user.sub } : {}),
    };
    const updated = await this.persistReview(capture, data);
    return { capture: updated };
  }

  /**
   * Approve-ALL (D12): approve every submitted photo and set the capture APPROVED (satisfies
   * the window, D7). REFUSED while any present photo is REJECTED (it must be re-captured
   * first). For a single-photo capture this is byte-identical to the pre-per-photo approve.
   */
  async approve(user: JwtPayload, captureId: string) {
    this.assertGifsy(user);
    const capture = await this.loadCapture(user, captureId);
    await this.assertEnabled(capture.clientId);
    if (capture.status === 'APPROVED') {
      throw new BadRequestException('This capture is already approved.');
    }

    const { schema, merged } = await this.resolveReviewContext(capture);
    const present = presentCameraFieldIds(schema, merged);
    const reviews = readPhotoReviews(capture.photoReviews);
    if (present.some((id) => reviews[id]?.status === 'REJECTED')) {
      throw new BadRequestException(
        'A photo is rejected and must be re-captured before the capture can be approved.',
      );
    }

    const now = new Date();
    const next: PhotoReviews = { ...reviews };
    for (const id of present) {
      next[id] = { status: 'APPROVED', reviewedAt: now.toISOString(), reviewedByUserId: user.sub };
    }

    // Derive the final status (don't force APPROVED): if a photo that is REQUIRED for this outlet
    // now (e.g. a `requiredWhen __subProgram__` photo made required by a post-submit sub-program
    // change) was never captured, it isn't in `present` → not approved → the capture stays SUBMITTED
    // instead of satisfying the window without it. For a complete capture this derives APPROVED, so
    // a single-photo / fully-present capture behaves exactly as the old approve-ALL.
    const derived = deriveCaptureStatus(gatingCameraFieldIds(schema, merged), next);
    const updated = await this.persistReview(capture, {
      status: derived,
      reviewedAt: now,
      rejectionReason: null,
      rejectionReasonCode: null,
      ...(derived === 'APPROVED' ? { approvedByUserId: user.sub } : {}),
      photoReviews: Object.keys(next).length
        ? (next as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    });
    return { capture: updated };
  }

  /**
   * Reject-ALL (D12): reject every submitted photo with a controlled reason code (+ optional
   * free text) and set the capture REJECTED — the explicit whole-capture reject that re-opens
   * the window so the rep resubmits a new version (D11). For a single-photo capture this is
   * byte-identical to the pre-per-photo reject.
   */
  async reject(user: JwtPayload, captureId: string, reasonCode: string, reason?: string) {
    this.assertGifsy(user);
    if (!(VISIBILITY_REJECT_REASONS as readonly string[]).includes(reasonCode)) {
      throw new BadRequestException(
        `reasonCode must be one of: ${VISIBILITY_REJECT_REASONS.join(', ')}`,
      );
    }
    const capture = await this.loadCapture(user, captureId);
    await this.assertEnabled(capture.clientId);
    if (capture.status === 'APPROVED') {
      throw new BadRequestException('An approved capture cannot be rejected.');
    }

    const { schema, merged } = await this.resolveReviewContext(capture);
    const present = presentCameraFieldIds(schema, merged);
    const now = new Date();
    const next: PhotoReviews = { ...readPhotoReviews(capture.photoReviews) };
    for (const id of present) {
      next[id] = {
        status: 'REJECTED',
        reasonCode,
        ...(reason ? { reason } : {}),
        reviewedAt: now.toISOString(),
        reviewedByUserId: user.sub,
      };
    }

    const updated = await this.persistReview(capture, {
      status: 'REJECTED',
      rejectionReasonCode: reasonCode,
      rejectionReason: reason ?? null,
      approvedByUserId: user.sub,
      reviewedAt: now,
      photoReviews: Object.keys(next).length
        ? (next as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    });
    return { capture: updated };
  }

  // ── Admin queue: list + detail (D12) ──────────────────────────────────────────

  async adminListCaptures(user: JwtPayload, q: AdminListCapturesQueryDto) {
    this.assertGifsy(user);
    await this.assertEnabled(user.clientId);

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;

    const where: Prisma.VisibilityCaptureWhereInput = { clientId: user.clientId };
    if (q.windowKey) where.windowKey = q.windowKey;
    if (q.status) where.status = q.status;
    if (q.outletCode) where.outletCode = q.outletCode;

    const [rows, total] = await Promise.all([
      this.prisma.visibilityCapture.findMany({
        where,
        select: {
          id: true,
          outletId: true,
          outletCode: true,
          outletName: true,
          windowKey: true,
          status: true,
          currentVersion: true,
          geoFenceOk: true,
          distanceMeters: true,
          captureAccuracy: true,
          capturedAt: true,
          receivedAt: true,
          rejectionReasonCode: true,
          // Per-photo review map so the queue can badge partial/changes-requested captures.
          photoReviews: true,
          submittedBy: { select: { id: true, employeeCode: true } },
        },
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.visibilityCapture.count({ where }),
    ]);

    return {
      captures: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Single-capture detail: captured values + media view paths (auth-gated
   * `/v1/visibility/captures/media?key=`) + geo (distance/geoFenceOk) + submission
   * history + duplicate matches (other captures in this tenant sharing an image hash).
   */
  async adminGetCapture(user: JwtPayload, captureId: string) {
    this.assertGifsy(user);
    const capture = await this.prisma.visibilityCapture.findFirst({
      where: { id: captureId, clientId: user.clientId },
      include: {
        submissions: { orderBy: { version: 'desc' } },
        imageHashes: { select: { hash: true } },
        submittedBy: { select: { id: true, employeeCode: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    if (!capture) throw new NotFoundException('Capture not found.');
    await this.assertEnabled(capture.clientId);

    const schema = await this.resolveFormSnapshot(capture.clientId, capture.formVersion);
    // Per-photo geo-fence: resolve the SAME outlet reference geo the aggregate fence uses
    // (the outlet owner-partner's latest APPROVED KYC board-photo geo) + the tenant's
    // current fence radius, so each fence-required photo gets its own inside/outside/
    // unverifiable status vs that reference. Both are null/default-safe.
    const config = (await this.tenantSettings.getEffectiveSettings(capture.clientId)).visibilityConfig;
    const referenceGeo = await this.outletReferenceGeo(capture.clientId, capture.outletId);
    // Per-photo review state (VISIBILITY-PER-PHOTO-APPROVAL) — attach each CAMERA field's
    // review (APPROVED/REJECTED/null=pending) so the FE can render per-photo controls.
    const reviews = readPhotoReviews(capture.photoReviews);
    const media = this.extractMedia(
      capture.formValues,
      schema,
      referenceGeo,
      config.geoFence.radiusMeters,
    ).map((m) => ({ ...m, review: reviews[m.fieldId] ?? null }));
    const geo = this.extractGeo(capture.formValues, schema);

    const dupMatches = await this.findDuplicateMatches(
      capture.clientId,
      capture.id,
      capture.imageHashes.map((h) => h.hash),
    );

    return {
      capture: {
        ...capture,
        photoReviews: reviews,
        media,
        geo,
        geoFence: {
          geoFenceOk: capture.geoFenceOk,
          distanceMeters: capture.distanceMeters,
          captureLat: capture.captureLat,
          captureLng: capture.captureLng,
          captureAccuracy: capture.captureAccuracy,
        },
        duplicateMatches: dupMatches,
      },
    };
  }

  /** Other captures (this tenant) sharing any of the given image hashes (dup flag). */
  private async findDuplicateMatches(
    clientId: string,
    captureId: string,
    hashes: string[],
  ): Promise<Array<{ hash: string; captureId: string; outletCode: string; windowKey: string }>> {
    const unique = [...new Set(hashes.filter((h) => typeof h === 'string' && h.length > 0))];
    if (unique.length === 0) return [];

    const matches = await this.prisma.visibilityImageHash.findMany({
      where: { clientId, hash: { in: unique }, captureId: { not: captureId } },
      select: {
        hash: true,
        captureId: true,
        capture: { select: { outletCode: true, windowKey: true } },
      },
    });
    return matches.map((m) => ({
      hash: m.hash,
      captureId: m.captureId,
      outletCode: m.capture.outletCode,
      windowKey: m.capture.windowKey,
    }));
  }

  // ── Form-snapshot + value extraction (mirror scheme extractMedia/extractGeo) ────

  /** The form-version snapshot a capture was taken against (D11), for field typing. */
  private async resolveFormSnapshot(
    clientId: string,
    formVersion: number,
  ): Promise<VisibilityFormSchema | null> {
    const snap = await this.prisma.visibilityFormVersion.findUnique({
      where: { clientId_version: { clientId, version: formVersion } },
      select: { formSchema: true },
    });
    if (snap) return snap.formSchema as unknown as VisibilityFormSchema;
    const current = await this.prisma.visibilityForm.findUnique({
      where: { clientId },
      select: { formSchema: true },
    });
    return current ? (current.formSchema as unknown as VisibilityFormSchema) : null;
  }

  /**
   * CAMERA fields whose value is a stored key → an auth-gated view path.
   *
   * A stored value may be a bare object-key string OR `{ key, geo }` (per-photo geotag);
   * readMediaValue normalises both, so a bare-string capture surfaces exactly as before
   * (no geo, no status). Where a photo carries its own geo it is attached; a
   * fence-required photo additionally gets its per-photo fence status
   * (inside / outside / unverifiable) vs the outlet reference geo — computed by the
   * shared `evaluatePhotoFence` (never a re-implemented haversine).
   */
  private extractMedia(
    formValues: Prisma.JsonValue | null,
    schema: VisibilityFormSchema | null,
    referenceGeo: { lat: number; lng: number } | null,
    radiusMeters: number,
  ): Array<{
    fieldId: string;
    label: string;
    type: string;
    key: string;
    viewPath: string;
    geo?: GpsCapture;
    fenceStatus?: PhotoFenceStatus;
  }> {
    if (!formValues || typeof formValues !== 'object' || !schema) return [];
    const vals = formValues as Record<string, unknown>;
    const out: Array<{
      fieldId: string;
      label: string;
      type: string;
      key: string;
      viewPath: string;
      geo?: GpsCapture;
      fenceStatus?: PhotoFenceStatus;
    }> = [];
    for (const f of schema.fields ?? []) {
      if (!MEDIA_FIELD_TYPES.has(f.type)) continue;
      const { key, geo } = readMediaValue(vals[f.id]);
      if (!key) continue;
      const ref: {
        fieldId: string;
        label: string;
        type: string;
        key: string;
        viewPath: string;
        geo?: GpsCapture;
        fenceStatus?: PhotoFenceStatus;
      } = {
        fieldId: f.id,
        label: f.label,
        type: f.type,
        key,
        viewPath: `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`,
      };
      if (geo) ref.geo = geo;
      // Only a fence-required photo gets a status; evaluatePhotoFence returns
      // 'unverifiable' when the photo has no geo OR there is no reference geo.
      if (f.geoFenceRequired === true) {
        ref.fenceStatus = evaluatePhotoFence(geo ?? null, referenceGeo, radiusMeters);
      }
      out.push(ref);
    }
    return out;
  }

  /**
   * The outlet's reference geo for the per-photo fence — the SAME source the aggregate
   * capture-time fence uses: the outlet owner-partner's latest APPROVED KYC board-photo
   * geo (`Outlet.partnerId` → ChannelPartner.kycSubmissions.boardPhotoLat/Lng). Null when
   * the outlet has no partner or no approved board-photo geo (→ photos read 'unverifiable').
   */
  private async outletReferenceGeo(
    clientId: string,
    outletId: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: outletId, clientId },
      select: { partnerId: true },
    });
    const partnerId = outlet?.partnerId ?? null;
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

  private extractGeo(
    formValues: Prisma.JsonValue | null,
    schema: VisibilityFormSchema | null,
  ): Array<{ fieldId: string; label: string; value: unknown }> {
    if (!formValues || typeof formValues !== 'object' || !schema) return [];
    const vals = formValues as Record<string, unknown>;
    return (schema.fields ?? [])
      .filter((f) => f.type === 'GPS_POINT' && vals[f.id] != null)
      .map((f) => ({ fieldId: f.id, label: f.label, value: vals[f.id] }));
  }
}
