import { Module } from '@nestjs/common';
import { TdsController } from './tds.controller';
import { TdsService } from './tds.service';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TdsController],
  // TdsStatutoryConfigService is the FY-effective statutory-config resolver consumed by the
  // TDS/credits engines (getForFy) and the platform admin controller (getAll/invalidate).
  providers: [TdsService, TdsStatutoryConfigService],
  exports: [TdsService, TdsStatutoryConfigService],
})
export class TdsModule {}
