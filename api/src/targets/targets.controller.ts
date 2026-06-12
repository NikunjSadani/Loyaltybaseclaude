import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { TargetsService }   from './targets.service';
import { Roles }            from '../common/decorators/roles.decorator';
import { CurrentUser }      from '../common/decorators/current-user.decorator';
import type { JwtPayload }  from '../common/decorators/current-user.decorator';
import { UpsertTargetsDto } from './dto/targets.dto';

@Controller('targets')
export class TargetsController {
  constructor(private readonly svc: TargetsService) {}

  /** Admin uploads targets from Excel */
  @Post('upsert')
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_HO')
  upsert(@Body() dto: UpsertTargetsDto) {
    return this.svc.upsertTargets(dto.schemeId ?? null, dto.rows as any);
  }

  /** List targets â€” partners see own, admin sees all */
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: any) {
    const isAdmin = ['ADMIN', 'GIFSY_ADMIN', 'SALES_HO', 'SALES_STATE_HEAD'].includes(user.role);
    return this.svc.listTargets({
      partnerId: isAdmin ? q.partnerId : user.sub,
      schemeId:  q.schemeId,
      month:     q.month,
      page:      q.page  ? +q.page  : 1,
      limit:     q.limit ? +q.limit : 50,
    });
  }
}
