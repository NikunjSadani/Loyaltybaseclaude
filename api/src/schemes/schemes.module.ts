import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SchemesController } from './schemes.controller';
import { SchemesService } from './schemes.service';
import { SchemeAdminController } from './scheme-admin.controller';
import { SchemeAdminService } from './scheme-admin.service';
import { SchemeEnrollmentController } from './scheme-enrollment.controller';
import { SchemeEnrollmentService } from './scheme-enrollment.service';
import { SchemeNotifyService } from './scheme-notify.service';
import { SchemeReportController } from './scheme-report.controller';
import { SchemeReportService } from './scheme-report.service';

/**
 * Scheme Data-Collection module (Wave-0). One `schemes` base path, four
 * controllers with non-colliding sub-paths:
 *   - SchemesController          — legacy read surface (list / getOne / delete / enrollment-form GET)
 *   - SchemeAdminController      — GIFSY authoring (create / edit / status / form / audience / roster)
 *   - SchemeEnrollmentController — enrollment engine (enroll / otp / media / reject / admin views)
 *   - SchemeReportController     — notifications (broadcast) + reports (D26) + media-link export (D30)
 *
 * Msg91Service (notifications) and StorageService (storage) are @Global(), so
 * SchemeNotifyService / SchemeEnrollmentService pick them up without importing
 * those modules here (same pattern as KycModule). No JwtModule is needed — the
 * scheme media view is session-gated (no self-authenticating token).
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    SchemesController,
    SchemeAdminController,
    SchemeEnrollmentController,
    SchemeReportController,
  ],
  providers: [
    SchemesService,
    SchemeAdminService,
    SchemeEnrollmentService,
    SchemeNotifyService,
    SchemeReportService,
  ],
})
export class SchemesModule {}
