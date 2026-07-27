import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VisibilityAdminController } from './visibility-admin.controller';
import { VisibilityCaptureController } from './visibility-capture.controller';
import { VisibilityReviewController } from './visibility-review.controller';
import { VisibilityReportController } from './visibility-report.controller';
import { VisibilityNotifyController } from './visibility-notify.controller';
import { VisibilityAdminService } from './visibility-admin.service';
import { VisibilityMediaService } from './visibility-media.service';
import { VisibilityCaptureService } from './visibility-capture.service';
import { VisibilityReviewService } from './visibility-review.service';
import { VisibilityReportService } from './visibility-report.service';
import { VisibilityNotifyService } from './visibility-notify.service';

/**
 * Visibility (POSM) module — recurring per-window, sales-captured, geo-fenced, Gifsy-approved
 * proof of point-of-sale material, built on the Scheme instrument. See
 * docs/plans/VISIBILITY-POSM-DESIGN.md. The legacy partner-photo path was dead scaffolding and
 * was removed; the Excel AMOUNT_UPLOAD path lives in the admin-programs module (untouched).
 *
 * Route-ordering: VisibilityAdminController (owns the STATIC `GET captures/media`) MUST be listed
 * before VisibilityReviewController (owns the PARAM `GET captures/:id`) — Nest matches in
 * registration order, else `media` is swallowed by `:id`.
 * (TenantService/TenantSettingsService/StorageService are @Global — no extra imports needed.)
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    VisibilityAdminController,
    VisibilityCaptureController,
    VisibilityReviewController,
    VisibilityReportController,
    VisibilityNotifyController,
  ],
  providers: [
    VisibilityAdminService,
    VisibilityMediaService,
    VisibilityCaptureService,
    VisibilityReviewService,
    VisibilityReportService,
    VisibilityNotifyService,
  ],
})
export class VisibilityModule {}
