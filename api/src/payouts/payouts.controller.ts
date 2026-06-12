import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { PayoutsService }   from './payouts.service';
import { Roles }            from '../common/decorators/roles.decorator';
import { CurrentUser }      from '../common/decorators/current-user.decorator';
import type { JwtPayload }  from '../common/decorators/current-user.decorator';
import { RequestPayoutDto, CreateBatchDto, UploadResultsDto } from './dto/payouts.dto';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly svc: PayoutsService) {}

  /** Partner requests a payout */
  @Post()
  request(@Body() dto: RequestPayoutDto, @CurrentUser() user: JwtPayload) {
    return this.svc.requestPayout({ ...dto, clientId: user.clientId, partnerId: user.sub });
  }

  /** List own payouts */
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.listPayouts({
      partnerId: user.sub,
      status:    q.status,
      page:      q.page  ? +q.page  : 1,
      limit:     q.limit ? +q.limit : 20,
    });
  }

  /** Admin: create batch from all pending payouts */
  @Post('batches')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  createBatch(@Body() dto: CreateBatchDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createBatch({ clientId: user.clientId, createdByUserId: user.sub, notes: dto.notes });
  }

  /** Admin: upload UTR results for a batch */
  @Post('batches/:id/results')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  uploadResults(@Param('id') id: string, @Body() dto: UploadResultsDto, @CurrentUser() user: JwtPayload) {
    return this.svc.uploadPayoutResults(id, dto.rows as any, user.sub);
  }
}
