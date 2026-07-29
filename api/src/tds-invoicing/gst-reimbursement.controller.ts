import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { GstReimbursementService } from './gst-reimbursement.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { platformWide } from '../common/tenant-scope';
import { ListGstReimbursementQueryDto, ReleaseGstReimbursementDto } from './dto/gst-reimbursement.dto';

/**
 * GST-reimbursement (holdback → release) controller — Wave 1 Stream C, design D5.
 *
 * GIFSY_ADMIN-ONLY (the release screen is a platform-operator surface — TGSL, the deductor,
 * releases the held GST on the retailer's deposit proof). CLIENT_ADMIN gets 403 from RolesGuard.
 *
 *   GET  /v1/admin/gst-reimbursements?status=HELD&clientId=&period=YYYY-MM  → release queue
 *   POST /v1/admin/gst-reimbursements/:id/release  { proofUrl, releasePayoutRef, notes? }
 */
@Controller('admin/gst-reimbursements')
@Roles('GIFSY_ADMIN')
export class GstReimbursementController {
  constructor(private readonly reimbursements: GstReimbursementService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() query: ListGstReimbursementQueryDto) {
    // GIFSY-only, but an ASSUMED operator is pinned to their assumed tenant — the ?clientId=
    // filter is honoured only for an un-assumed GIFSY at platform home.
    const clientId = platformWide(user) ? query.clientId : user.clientId;
    return this.reimbursements.list({ ...query, clientId });
  }

  @Post(':id/release')
  release(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReleaseGstReimbursementDto,
  ) {
    return this.reimbursements.release(user, id, dto);
  }
}
