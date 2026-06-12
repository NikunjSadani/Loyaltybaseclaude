import {
  Controller, Get, Post, Patch, Body, Query, Param, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }              from '../common/decorators/roles.decorator';
import { CurrentUser }        from '../common/decorators/current-user.decorator';
import type { JwtPayload }    from '../common/decorators/current-user.decorator';
import { VisibilityService }  from './visibility.service';
import { SubmitPhotoDto, RejectSubmissionDto } from './dto/visibility.dto';

@Controller('visibility')
export class VisibilityController {
  constructor(private readonly visibilityService: VisibilityService) {}

  /** Partner: submit a visibility photo */
  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  submitPhoto(@CurrentUser() user: JwtPayload, @Body() dto: SubmitPhotoDto) {
    return this.visibilityService.submitPhoto(user.sub, user.clientId, dto);
  }

  /** Admin: list all submissions (paginated, filterable by status) */
  @Get('submissions')
  listSubmissions(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ) {
    return this.visibilityService.listSubmissions(user.clientId, {
      status,
      page:  page  ? parseInt(page, 10)  : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Admin: approve a submission (awards points to partner) */
  @Patch('submissions/:id/approve')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  approveSubmission(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.visibilityService.approveSubmission(id, user.sub, user.clientId);
  }

  /** Admin: reject a submission */
  @Patch('submissions/:id/reject')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  rejectSubmission(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectSubmissionDto,
  ) {
    return this.visibilityService.rejectSubmission(id, user.sub, user.clientId, dto.reason);
  }
}
