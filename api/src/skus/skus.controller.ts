import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { SkusService }    from './skus.service';
import { Roles }          from '../common/decorators/roles.decorator';
import { CurrentUser }    from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateSkuDto }   from './dto/skus.dto';

@Controller('skus')
export class SkusController {
  constructor(private readonly svc: SkusService) {}

  @Post()
  @Roles('ADMIN', 'GIFSY_ADMIN')
  create(@Body() dto: CreateSkuDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createSku({ ...dto, clientId: user.clientId });
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.listSkus(user.clientId, {
      brand:    q.brand,
      isActive: q.isActive === 'true' ? true : q.isActive === 'false' ? false : undefined,
      page:     q.page  ? +q.page  : 1,
      limit:    q.limit ? +q.limit : 50,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.findById(id, user.clientId);
  }

  @Delete(':id')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.deleteSku(id, user.clientId);
  }
}
