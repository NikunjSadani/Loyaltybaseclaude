import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }        from '../common/decorators/roles.decorator';
import { CurrentUser }  from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { RewardsService }         from './rewards.service';
import { CreateCatalogItemDto, UpdateCatalogItemDto } from './dto/rewards-admin.dto';

@Controller('rewards/catalog')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class RewardsAdminController {
  constructor(private readonly rewardsService: RewardsService) {}

  /** Admin: list all catalog items (including inactive) */
  @Get('admin')
  listAdmin(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ) {
    return this.rewardsService.listAdminCatalog(user.clientId, {
      status,
      page:  page  ? parseInt(page, 10)  : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Admin: create a new reward catalog item */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createItem(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCatalogItemDto,
  ) {
    return this.rewardsService.createCatalogItem(user.clientId, dto);
  }

  /** Admin: update a catalog item */
  @Patch(':id')
  updateItem(
    @Param('id')   id:   string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateCatalogItemDto,
  ) {
    return this.rewardsService.updateCatalogItem(id, user.clientId, dto);
  }

  /** Admin: soft-delete a catalog item */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteItem(
    @Param('id')   id:   string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.rewardsService.softDeleteCatalogItem(id, user.clientId);
  }
}
