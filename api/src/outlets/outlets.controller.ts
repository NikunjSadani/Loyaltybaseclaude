import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { OutletsService }  from './outlets.service';
import { Roles }           from '../common/decorators/roles.decorator';
import { CurrentUser }     from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateOutletDto } from './dto/outlets.dto';

@Controller('outlets')
export class OutletsController {
  constructor(private readonly svc: OutletsService) {}

  @Post()
  create(@Body() dto: CreateOutletDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createOutlet({ ...dto });
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.listOutlets({
      partnerId: q.partnerId,
      state:     q.state,
      isActive:  q.isActive === 'true' ? true : q.isActive === 'false' ? false : undefined,
      page:      q.page  ? +q.page  : 1,
      limit:     q.limit ? +q.limit : 50,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findById(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Query('partnerId') partnerId: string) {
    return this.svc.deleteOutlet(id, partnerId);
  }
}
