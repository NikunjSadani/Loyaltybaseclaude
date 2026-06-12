import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { SchemesService }  from './schemes.service';
import { Roles }           from '../common/decorators/roles.decorator';
import { CurrentUser }     from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateSchemeDto } from './dto/schemes.dto';

@Controller('schemes')
export class SchemesController {
  constructor(private readonly svc: SchemesService) {}

  @Post()
  @Roles('ADMIN', 'GIFSY_ADMIN')
  create(@Body() dto: CreateSchemeDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createScheme({ ...dto, clientId: user.clientId, createdByUserId: user.sub });
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.listSchemes(user.clientId, {
      status: q.status,
      page:   q.page  ? +q.page  : 1,
      limit:  q.limit ? +q.limit : 20,
    });
  }

  @Patch(':id/activate')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  activate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.activateScheme(id, user.clientId);
  }

  @Patch(':id/pause')
  @Roles('ADMIN', 'GIFSY_ADMIN')
  pause(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.pauseScheme(id, user.clientId);
  }
}
