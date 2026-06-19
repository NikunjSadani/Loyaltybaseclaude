import {
  Body,
  Controller,
  Get,
  Param,
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
import {
  ListFraudLogQueryDto,
  ListSubmissionsQueryDto,
  OutletStatusesQueryDto,
  RejectSubmissionDto,
  SubmitVisibilityDto,
} from './dto/visibility.dto';

/**
 * Visibility API — re-homed from platform/src/app/api/visibility/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only approve/reject/fraud-log via @Roles.
 * Responses are enveloped globally by TransformInterceptor.
 *
 * The source POST /visibility/submit route is NOT ported here — it depends on
 * multipart image upload + GCS storage infra owned centrally (see service note).
 */
@Controller('visibility')
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get('submissions')
  @RequirePermission('visibility:read')
  listSubmissions(@CurrentUser() user: JwtPayload, @Query() query: ListSubmissionsQueryDto) {
    return this.visibility.listSubmissions(user, query);
  }

  /**
   * POST /v1/visibility/submit — partner photo submission (multipart/form-data,
   * field `image`). Partner-only (the partner is re-resolved from the JWT in the
   * service; a sales user has no ChannelPartner row and is rejected there too).
   */
  @Post('submit')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('visibility:write')
  @UseInterceptors(FileInterceptor('image'))
  submit(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: SubmitVisibilityDto,
  ) {
    return this.visibility.submit(user, file, dto);
  }

  @Post('submissions/:id/approve')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:approve')
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.visibility.approve(user, id);
  }

  @Post('submissions/:id/reject')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:reject')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RejectSubmissionDto) {
    return this.visibility.reject(user, id, dto);
  }

  @Get('outlet-statuses')
  @RequirePermission('visibility:read')
  outletStatuses(@CurrentUser() user: JwtPayload, @Query() query: OutletStatusesQueryDto) {
    return this.visibility.outletStatuses(user, query);
  }

  @Get('fraud-log')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:view_fraud_log')
  listFraudLog(@CurrentUser() user: JwtPayload, @Query() query: ListFraudLogQueryDto) {
    return this.visibility.listFraudLog(user, query);
  }
}
