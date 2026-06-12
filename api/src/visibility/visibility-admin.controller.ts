import {
  Controller, Get, Post, Patch,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }        from '../common/decorators/roles.decorator';
import { CurrentUser }  from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { VisibilityService }             from './visibility.service';
import { CreateVisibilityProgramDto, UpdateVisibilityProgramDto } from './dto/visibility-admin.dto';

@Controller('visibility/programs')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class VisibilityAdminController {
  constructor(private readonly visibilityService: VisibilityService) {}

  /** Admin: list all visibility programs */
  @Get()
  listPrograms(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ) {
    return this.visibilityService.listPrograms(user.clientId, {
      status,
      page:  page  ? parseInt(page, 10)  : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Admin: create a new visibility program */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createProgram(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVisibilityProgramDto,
  ) {
    return this.visibilityService.createProgram(user.clientId, user.sub, dto);
  }

  /** Admin: update a visibility program */
  @Patch(':id')
  updateProgram(
    @Param('id')   id:   string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateVisibilityProgramDto,
  ) {
    return this.visibilityService.updateProgram(id, user.clientId, dto);
  }
}
