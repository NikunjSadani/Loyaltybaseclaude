import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { VisibilityFormSchema } from './visibility-types';
import { MEDIA_FIELD_TYPES } from './visibility-form.helper';
import {
  AdminListCapturesQueryDto,
  VISIBILITY_REJECT_REASON_CODES,
} from './dto/visibility-capture.dto';

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
  ) {}

  private assertGifsy(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') {
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

  // ── Approve / reject (D12) ────────────────────────────────────────────────────

  /** Approve a SUBMITTED/REJECTED capture → APPROVED (satisfies the window, D7). */
  async approve(user: JwtPayload, captureId: string) {
    this.assertGifsy(user);
    const capture = await this.loadCapture(user, captureId);
    await this.assertEnabled(capture.clientId);
    if (capture.status === 'APPROVED') {
      throw new BadRequestException('This capture is already approved.');
    }

    const updated = await this.prisma.visibilityCapture.update({
      where: { id: capture.id },
      data: {
        status: 'APPROVED',
        approvedByUserId: user.sub,
        reviewedAt: new Date(),
        rejectionReason: null,
        rejectionReasonCode: null,
      },
    });
    return { capture: updated };
  }

  /**
   * Reject a capture with a controlled reason code (+ optional free text). Re-opens the
   * window (REJECTED) so the rep resubmits a new version (D11).
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

    const updated = await this.prisma.visibilityCapture.update({
      where: { id: capture.id },
      data: {
        status: 'REJECTED',
        rejectionReasonCode: reasonCode,
        rejectionReason: reason ?? null,
        approvedByUserId: user.sub,
        reviewedAt: new Date(),
      },
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
    const media = this.extractMedia(capture.formValues, schema);
    const geo = this.extractGeo(capture.formValues, schema);

    const dupMatches = await this.findDuplicateMatches(
      capture.clientId,
      capture.id,
      capture.imageHashes.map((h) => h.hash),
    );

    return {
      capture: {
        ...capture,
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

  /** CAMERA fields whose value is a stored key → an auth-gated view path. */
  private extractMedia(
    formValues: Prisma.JsonValue | null,
    schema: VisibilityFormSchema | null,
  ): Array<{ fieldId: string; label: string; type: string; key: string; viewPath: string }> {
    if (!formValues || typeof formValues !== 'object' || !schema) return [];
    const vals = formValues as Record<string, unknown>;
    const out: Array<{ fieldId: string; label: string; type: string; key: string; viewPath: string }> = [];
    for (const f of schema.fields ?? []) {
      if (!MEDIA_FIELD_TYPES.has(f.type)) continue;
      const key = vals[f.id];
      if (typeof key === 'string' && key) {
        out.push({
          fieldId: f.id,
          label: f.label,
          type: f.type,
          key,
          viewPath: `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`,
        });
      }
    }
    return out;
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
