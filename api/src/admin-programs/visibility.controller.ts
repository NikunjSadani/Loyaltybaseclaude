import {
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { LimitedFileInterceptor, SPREADSHEET_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import { VisibilityService } from './visibility.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListVisibilityRecordsQueryDto } from './dto/visibility.dto';

/**
 * Outlet Visibility admin — re-homed from
 * platform/src/app/api/admin/visibility/* onto /v1.
 *
 * GET /records uses a partner-role denylist (enforced in the service), so it is
 * intentionally not gated with @Roles (which is allowlist-only); the
 * visibility:read permission still applies.
 */
@Controller('admin/visibility')
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get('records')
  @RequirePermission('visibility:read')
  listRecords(@CurrentUser() user: JwtPayload, @Query() query: ListVisibilityRecordsQueryDto) {
    return this.visibility.listRecords(user, query);
  }

  @Post('bulk-upload')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('visibility:write')
  @UseInterceptors(LimitedFileInterceptor('file', SPREADSHEET_UPLOAD_MAX_BYTES))
  bulkUpload(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.visibility.bulkUpload(user, file);
  }
}

/**
 * GET /v1/visibility/outlet-statuses — AMOUNT_UPLOAD (Excel record) status per outlet for a
 * month, for the SALES outlets / tasks / dashboard badges (`platform/src/lib/visibility-upload.ts`).
 * Sales roles see only their downline's outlets; tenant admins see the tenant. Partner logins are
 * refused in the service. Static path — no collision with the photo controllers' routes.
 */
@Controller('visibility')
export class VisibilityOutletStatusesController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get('outlet-statuses')
  @Roles('SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN')
  @RequirePermission('visibility:read')
  outletStatuses(
    @CurrentUser() user: JwtPayload,
    @Query('outletCodes') outletCodes?: string,
    @Query('month') month?: string,
  ) {
    return this.visibility.getOutletStatuses(user, outletCodes, month);
  }
}
