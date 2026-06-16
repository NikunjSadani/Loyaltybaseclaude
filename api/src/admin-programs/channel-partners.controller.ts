import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ChannelPartnersService } from './channel-partners.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  ListChannelPartnersQueryDto,
  UpdateChannelPartnerDto,
} from './dto/channel-partners.dto';

/**
 * Channel Partners admin — re-homed from
 * platform/src/app/api/admin/channel-partners/* onto /v1.
 */
@Controller('admin/channel-partners')
export class ChannelPartnersController {
  constructor(private readonly partners: ChannelPartnersService) {}

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  @RequirePermission('partners:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListChannelPartnersQueryDto) {
    return this.partners.list(user, query);
  }

  @Get(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  @RequirePermission('partners:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.partners.getOne(user, id);
  }

  @Patch(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('partners:write')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateChannelPartnerDto,
  ) {
    return this.partners.update(user, id, dto);
  }
}
