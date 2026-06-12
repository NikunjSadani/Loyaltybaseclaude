import {
  Controller, Get, Post, Body, Query, Param, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }        from '../common/decorators/roles.decorator';
import { CurrentUser }  from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { RewardsService }       from './rewards.service';
import { InitiateRedemptionDto, ConfirmRedemptionDto } from './dto/rewards.dto';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  /** Browse reward catalog with wallet-affordability flag */
  @Get('catalog')
  getCatalog(
    @CurrentUser() user: JwtPayload,
    @Query('page')      page?:      string,
    @Query('limit')     limit?:     string,
    @Query('minPoints') minPoints?: string,
    @Query('maxPoints') maxPoints?: string,
  ) {
    return this.rewardsService.getCatalog(user.clientId, user.sub, {
      page:      page      ? parseInt(page, 10)      : undefined,
      limit:     limit     ? parseInt(limit, 10)     : undefined,
      minPoints: minPoints ? parseInt(minPoints, 10) : undefined,
      maxPoints: maxPoints ? parseInt(maxPoints, 10) : undefined,
    });
  }

  /** Initiate a reward redemption — generates OTP */
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  initiateRedemption(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateRedemptionDto,
  ) {
    return this.rewardsService.initiateRedemption(user.sub, user.clientId, dto);
  }

  /** Confirm redemption with OTP — deducts points atomically */
  @Post('redeem/confirm')
  @HttpCode(HttpStatus.OK)
  confirmRedemption(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmRedemptionDto,
  ) {
    return this.rewardsService.confirmRedemption(user.sub, user.clientId, dto.orderId, dto.otp);
  }

  /** List partner's redemption orders */
  @Get('orders')
  getOrders(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ) {
    return this.rewardsService.getOrders(user.sub, user.clientId, {
      status,
      page:  page  ? parseInt(page, 10)  : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
