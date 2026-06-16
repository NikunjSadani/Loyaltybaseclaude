import {
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  @UseInterceptors(FileInterceptor('file'))
  bulkUpload(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.visibility.bulkUpload(user, file);
  }
}
