import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { HeldOpeningBalancesService } from './held-opening-balances.service';

export class HeldReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/**
 * HELD OPENING BALANCES — Gifsy console (GIFSY_ADMIN only). Tenant = the assumed tenant, or ?clientId= for an
 * un-assumed Gifsy session (never a silent write to the home tenant). Every write is audited.
 */
@Controller('admin/held-opening-balances')
@Roles('GIFSY_ADMIN')
export class HeldOpeningBalancesController {
  constructor(private readonly held: HeldOpeningBalancesService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.held.list(user, { clientId, status, q, page, pageSize });
  }

  /** Run the automatic sweep now (applies every waiting row whose wallet exists and is empty; all tenants). */
  @Post('sweep')
  sweep() {
    return this.held.sweepNow();
  }

  @Get(':id/preview')
  preview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('clientId') clientId?: string) {
    return this.held.preview(user, id, clientId);
  }

  @Post(':id/apply')
  apply(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('clientId') clientId?: string,
    @Body() body?: HeldReasonDto,
  ) {
    return this.held.applyNow(user, id, clientId, body?.reason);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('clientId') clientId?: string,
    @Body() body?: HeldReasonDto,
  ) {
    return this.held.cancel(user, id, clientId, body?.reason);
  }
}
