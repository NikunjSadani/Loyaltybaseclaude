import { Controller, Post, Get, Param, Body, Query } from '@nestjs/common';
import { KycService }    from './kyc.service';
import { Roles }         from '../common/decorators/roles.decorator';
import { CurrentUser }   from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  SubmitKycDto, RejectKycDto, ApprovePhotoDto,
  BulkGstDto, BulkPennyDropDto,
} from './dto/kyc.dto';

@Controller('kyc')
export class KycController {
  constructor(private readonly svc: KycService) {}

  /** Sales rep submits KYC for a partner */
  @Post('submit')
  @Roles('SALES_ISR', 'SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'SALES_HO')
  submit(@CurrentUser() user: JwtPayload, @Body() dto: SubmitKycDto) {
    return this.svc.submitKyc({
      submitterRole:   user.role,
      submitterUserId: user.sub,
      partnerId:       dto.partnerId,
      clientId:        user.clientId,
      phones:          dto.phones as any,
    });
  }

  /** Field manager (SO/ASM/RSM) gives first approval */
  @Post(':id/approve')
  @Roles('SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD')
  firstApprove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.firstApprove(id, user.role, user.sub);
  }

  /** Any approver can reject */
  @Post(':id/reject')
  @Roles('SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'ADMIN', 'GIFSY_ADMIN')
  reject(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: RejectKycDto) {
    return this.svc.rejectKyc(id, user.role, user.sub, dto.reason);
  }

  /** Gifsy admin bulk-verifies GST from Excel upload */
  @Post('bulk/gst')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  bulkGst(@CurrentUser() user: JwtPayload, @Body() dto: BulkGstDto) {
    return this.svc.processBulkGstVerification(dto.rows as any, user.sub);
  }

  /** Gifsy admin bulk penny-drop verification */
  @Post('bulk/penny-drop')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  bulkPennyDrop(@CurrentUser() user: JwtPayload, @Body() dto: BulkPennyDropDto) {
    return this.svc.processBulkPennyDrop(dto.rows as any, user.sub);
  }

  /** Gifsy admin final KYC approval (all checks passed) */
  @Post(':id/gifsy-approve')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  gifsyApprove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.gifsyFinalApprove(id, user.sub);
  }

  /** Gifsy admin approves/rejects partner photo */
  @Post(':id/photo')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  approvePhoto(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: ApprovePhotoDto) {
    return this.svc.approvePhoto(id, user.sub, dto.approved, dto.reason);
  }

  /** Outlet photos (OUTLET_PHOTO + SHOP_ESTABLISHMENT) for a KYC submission.
   *  Used by the outlet information page in the sales app. */
  @Get(':id/outlet-photos')
  @Roles('SALES_ISR', 'SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'SALES_HO', 'ADMIN', 'GIFSY_ADMIN')
  getOutletPhotos(@Param('id') id: string) {
    return this.svc.getOutletPhotos(id);
  }

  /** List KYC submissions (admin) */
  @Get()
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_STATE_HEAD', 'SALES_HO')
  list(@Query() q: any) {
    return this.svc.listSubmissions({
      status: q.status,
      page:   q.page  ? +q.page  : 1,
      limit:  q.limit ? +q.limit : 20,
    });
  }
}
