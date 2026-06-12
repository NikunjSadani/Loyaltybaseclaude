import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { PartnersService }  from './partners.service';
import { Roles, Public }    from '../common/decorators/roles.decorator';
import { CurrentUser }      from '../common/decorators/current-user.decorator';
import type { JwtPayload }  from '../common/decorators/current-user.decorator';
import { CreatePartnerDto } from './dto/partners.dto';

@Controller('partners')
export class PartnersController {
  constructor(private readonly svc: PartnersService) {}

  /** Partner registers themselves */
  @Post()
  create(@Body() dto: CreatePartnerDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createPartner({ ...dto, clientId: user.clientId, userId: user.sub });
  }

  /** Current partner's own profile */
  @Get('me')
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.svc.findByUserId(user.sub, user.clientId);
  }

  /** Admin: list all partners */
  @Get()
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_HO')
  list(@CurrentUser() user: JwtPayload, @Query() query: any) {
    return this.svc.listPartners(user.clientId, {
      isActive: query.isActive === 'true' ? true : query.isActive === 'false' ? false : undefined,
      page:     query.page  ? +query.page  : 1,
      limit:    query.limit ? +query.limit : 20,
    });
  }

  /** Get partner by ID */
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.findById(id, user.clientId);
  }
}
