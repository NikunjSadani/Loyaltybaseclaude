import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, VisibilityCaptureStatus } from '@prisma/client';
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
import {
  classifyPhotoFence,
  outletMasterFencePolicy,
  PhotoFencePolicy,
  PhotoFenceStatus,
} from './geo-fence.helper';
import {
  AdminListCapturesQueryDto,
  VISIBILITY_REJECT_REASON_CODES,
} from './dto/visibility-capture.dto';
import { isGifsyOperator } from '../common/tenant-scope';
import {
  appendReviewEvents,
  compareEventsNewestFirst,
  IMPORTED_REVIEW_ACTOR_LABEL,
  ReviewEventInput,
} from './visibility-review-events';
import { isImportedVisibilityCapture } from './visibility-portal-go-live';
import { windowClosedSafe } from './visibility-metrics';

/** 409 text when a review lost a race with another change to the same capture (L2). */
export const CAPTURE_CHANGED_MESSAGE = 'This visit was just changed by someone else — reload';

/**
 * The controlled reject-reason vocabulary for the Visibility review queue (D12).
 * Re-exported from the DTO's single source of truth so callers can import it from the
 * service (the DTO validator and this service validate against the same list).
 */
export const VISIBILITY_REJECT_REASONS = VISIBILITY_REJECT_REASON_CODES;

/**
 * The outlet's programme (`Outlet.programName`, e.g. Bajaj "Unnati"/"SAMT"), sub-programme
 * (`Outlet.programCategory`, e.g. "Elite"/"Privilege"), and its State / Zone from the outlet master
 * (owner 2026-11-23: the reviewer needs to see which state / zone a capture belongs to) — reviewer
 * context for the queue + detail; additive fields; null when the outlet has none (blank values are null).
 */
function outletProgram(
  outlet:
    | { programName: string | null; programCategory: string | null; state?: string | null; zone?: string | null }
    | null
    | undefined,
): { programName: string | null; programCategory: string | null; outletState: string | null; outletZone: string | null } {
  const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    programName: outlet?.programName ?? null,
    programCategory: outlet?.programCategory ?? null,
    outletState: clean(outlet?.state),
    outletZone: clean(outlet?.zone),
  };
}

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
    capture: { id: string; currentVersion: number; status: VisibilityCaptureStatus | string; updatedAt?: Date | null },
    data: Prisma.VisibilityCaptureUncheckedUpdateInput,
    events: ReviewEventInput[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Lost-update guard: the decision was computed from the row as READ above, so write only if
      // the row is still exactly that one (same status, version and updatedAt). Postgres re-checks
      // this WHERE under the row lock, so of two concurrent reviews / a review racing a resubmit only
      // the first wins; the other gets a clear 409 and writes NO event — history and the live row
      // can never diverge.
      let updated;
      try {
        updated = await tx.visibilityCapture.update({
          where: {
            id: capture.id,
            status: capture.status as VisibilityCaptureStatus,
            currentVersion: capture.currentVersion,
            ...(capture.updatedAt ? { updatedAt: capture.updatedAt } : {}),
          },
          data,
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new ConflictException(CAPTURE_CHANGED_MESSAGE);
        }
        throw e;
      }
      await tx.visibilityCaptureSubmission.updateMany({
        where: { captureId: capture.id, version: capture.currentVersion },
        data: { photoReviews: data.photoReviews ?? Prisma.JsonNull },
      });
      // Permanent review history — same transaction, so a decision is never stored without its event.
      await appendReviewEvents(tx, events);
      return updated;
    });
  }

  /** The common identity of a review event for this capture + reviewer. */
  private eventBase(
    capture: { id: string; clientId: string; outletId: string; windowKey: string; currentVersion: number },
    user: JwtPayload,
    at: Date,
  ) {
    return {
      clientId: capture.clientId,
      captureId: capture.id,
      outletId: capture.outletId,
      windowKey: capture.windowKey,
      version: capture.currentVersion,
      actorUserId: user.sub,
      actorName: user.name ?? null,
      createdAt: at,
    };
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
    // Approving a photo that is ALREADY approved changes nothing → no write, no second history event.
    if (decision === 'APPROVED' && readPhotoReviews(capture.photoReviews)[fieldId]?.status === 'APPROVED') {
      return { capture };
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
    const base = this.eventBase(capture, user, now);
    const events: ReviewEventInput[] = [
      {
        ...base,
        action: decision === 'APPROVED' ? 'PHOTO_APPROVED' : 'PHOTO_REJECTED',
        statusAfter: derived,
        fieldId,
        fieldLabel: field.label ?? null,
        reasonCode: decision === 'REJECTED' ? reasonCode : null,
        reason: decision === 'REJECTED' ? reason ?? null : null,
      },
    ];
    // The capture just moved INTO Needs re-take → record the result explicitly.
    if (derived === 'CHANGES_REQUESTED' && capture.status !== 'CHANGES_REQUESTED') {
      events.push({ ...base, action: 'CHANGES_REQUESTED_RESULT', statusAfter: derived });
    }
    const updated = await this.persistReview(capture, data, events);
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
    }, [{ ...this.eventBase(capture, user, now), action: 'CAPTURE_APPROVED_ALL', statusAfter: derived }]);
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
    }, [{
      ...this.eventBase(capture, user, now),
      action: 'CAPTURE_REJECTED_ALL',
      statusAfter: 'REJECTED',
      reasonCode,
      reason: reason ?? null,
    }]);
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
          // The outlet's programme / sub-programme (reviewer context) — flattened below.
          outlet: { select: { programName: true, programCategory: true, state: true, zone: true } },
        },
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.visibilityCapture.count({ where }),
    ]);
    // Additive `windowClosed` (IST, the tenant's frequency): the queue shows a re-take / rejection left when its window
    // closed as "Not approved — window closed" — the same words as the report screen + Excel (plainStatusOf).
    const freq = (await this.tenantSettings.getEffectiveSettings(user.clientId)).visibilityConfig.frequencyPerMonth ?? 1;
    const now = new Date();

    return {
      // Additive: programName / programCategory flattened from the live outlet master
      // (Outlet.programName = programme, Outlet.programCategory = sub-programme).
      captures: rows.map(({ outlet, ...r }) => ({
        ...r,
        ...outletProgram(outlet),
        windowClosed: windowClosedSafe(r.windowKey, now, freq),
      })),
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
        outlet: { select: { programName: true, programCategory: true, state: true, zone: true } },
      },
    });
    if (!capture) throw new NotFoundException('Capture not found.');
    await this.assertEnabled(capture.clientId);
    const { outlet: captureOutlet, ...captureRow } = capture;

    const schema = await this.resolveFormSnapshot(capture.clientId, capture.formVersion);
    // Per-photo geo-fence: the SAME policy the capture verdict uses (geo-fence.helper), so a badge can never disagree
    // with the verdict. Outlet-master tenants (Bajaj, features.outletMasterGeo): outlet-master coordinates (guarded by
    // isUsableReference), forced 200 m, accuracy buffer. Every other tenant: the outlet owner-partner's latest
    // APPROVED KYC board-photo geo + the tenant's configured radius, no buffer (exactly as before).
    const config = (await this.tenantSettings.getEffectiveSettings(capture.clientId)).visibilityConfig;
    const fencePolicy = await this.photoFencePolicy(capture.clientId, capture.outletId, config.geoFence.radiusMeters);
    // Per-photo review state (VISIBILITY-PER-PHOTO-APPROVAL) — attach each CAMERA field's
    // review (APPROVED/REJECTED/null=pending) so the FE can render per-photo controls.
    const reviews = readPhotoReviews(capture.photoReviews);
    const media = this.extractMedia(capture.formValues, schema, fencePolicy).map((m) => ({ ...m, review: reviews[m.fieldId] ?? null }));
    const geo = this.extractGeo(capture.formValues, schema);

    const dupMatches = await this.findDuplicateMatches(
      capture.clientId,
      capture.id,
      capture.imageHashes.map((h) => h.hash),
    );
    // An imported old-app capture (photos under /vendor-import/): its approvedBy is only the admin who ran
    // the import — the review is shown as the old app's approval, never as that admin's (B1).
    const imported = isImportedVisibilityCapture(capture.formValues);
    const { reviewHistory, lastReview } = await this.loadReviewHistory(
      capture.clientId,
      capture.id,
      capture.currentVersion,
      imported,
    );

    return {
      capture: {
        ...captureRow,
        // Additive: the outlet's programme / sub-programme for the review header.
        ...outletProgram(captureOutlet),
        // Imported old-app capture → never expose the importing admin as the approver.
        imported,
        // Additive: the capture's window has closed (IST, tenant frequency) → a re-take / rejection is final.
        windowClosed: windowClosedSafe(capture.windowKey, new Date(), config.frequencyPerMonth ?? 1),
        ...(imported ? { approvedBy: null, approvedByUserId: null } : {}),
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
        // Permanent review timeline (newest first) + the latest review decision of the
        // CURRENT version (header "Reviewed by <name> on <date>"; null = not reviewed yet).
        reviewHistory,
        lastReview,
      },
    };
  }

  /**
   * The capture's permanent review history (visibility_review_events), newest first. The actor's
   * name is the snapshot taken at the time; a row with no snapshot (backfill without a user match)
   * falls back to the user's CURRENT name, else null (the UI says "Unknown user" — never blank).
   */
  private async loadReviewHistory(clientId: string, captureId: string, currentVersion: number, imported = false) {
    const found = await this.prisma.visibilityReviewEvent.findMany({
      where: { clientId, captureId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    // Deterministic newest-first order, incl. same-timestamp events (see compareEventsNewestFirst).
    const rows = [...found].sort(compareEventsNewestFirst).map((r) =>
      // Imported old-app capture: a review event is the old app's approval — no admin name / id, ever
      // (the backfill already writes it this way; this also covers any row that says otherwise).
      imported && r.action !== 'SUBMITTED' && r.action !== 'RESUBMITTED'
        ? { ...r, actorUserId: null, actorName: IMPORTED_REVIEW_ACTOR_LABEL }
        : r,
    );
    const missing = [
      ...new Set(rows.filter((r) => !r.actorName && r.actorUserId).map((r) => r.actorUserId as string)),
    ];
    const names = new Map<string, string>();
    if (missing.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: missing } },
        select: { id: true, name: true },
      });
      for (const u of users) names.set(u.id, u.name);
    }
    const reviewHistory = rows.map((r) => ({
      id: r.id,
      version: r.version,
      action: r.action,
      statusAfter: r.statusAfter,
      fieldId: r.fieldId,
      fieldLabel: r.fieldLabel,
      reasonCode: r.reasonCode,
      reason: r.reason,
      actorUserId: r.actorUserId,
      actorName: r.actorName ?? (r.actorUserId ? names.get(r.actorUserId) ?? null : null),
      backfilled: r.backfilled,
      createdAt: r.createdAt,
    }));
    const latest = reviewHistory.find(
      (e) => e.version === currentVersion && e.action !== 'SUBMITTED' && e.action !== 'RESUBMITTED',
    );
    const lastReview = latest
      ? { actorName: latest.actorName, actorUserId: latest.actorUserId, at: latest.createdAt, action: latest.action }
      : null;
    return { reviewHistory, lastReview };
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
    fencePolicy: PhotoFencePolicy,
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
        ref.fenceStatus = classifyPhotoFence(geo ?? null, fencePolicy).status;
      }
      out.push(ref);
    }
    return out;
  }

  /** The per-photo fence policy for this capture's outlet — the capture verdict's own resolution (see above). */
  private async photoFencePolicy(clientId: string, outletId: string, configRadius: number): Promise<PhotoFencePolicy> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
    if ((client?.features as Record<string, unknown> | null)?.outletMasterGeo === true) {
      const outlet = await this.prisma.outlet.findFirst({
        where: { id: outletId, clientId },
        select: { latitude: true, longitude: true },
      });
      return outletMasterFencePolicy(outlet ?? {});
    }
    return {
      reference: await this.outletReferenceGeo(clientId, outletId),
      radiusMeters: configRadius,
      accuracyBuffer: false,
    };
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
