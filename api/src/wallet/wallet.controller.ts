import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { WalletService }  from './wallet.service';
import { Roles }          from '../common/decorators/roles.decorator';
import { CurrentUser }    from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { EarnPointsDto }  from './dto/wallet.dto';

@Controller('wallet')
export class WalletController {
  constructor(private readonly svc: WalletService) {}

  /** Get own wallet balance */
  @Get()
  getBalance(@CurrentUser() user: JwtPayload) {
    return this.svc.getBalance(user.sub);
  }

  /** Get transaction history */
  @Get('transactions')
  getTransactions(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.getTransactions(user.sub, {
      page:  q.page  ? +q.page  : 1,
      limit: q.limit ? +q.limit : 20,
    });
  }

  /** Admin: manually earn points for a partner */
  @Post('earn')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  earn(@Body() dto: EarnPointsDto) {
    return this.svc.earnPoints(dto);
  }
}
