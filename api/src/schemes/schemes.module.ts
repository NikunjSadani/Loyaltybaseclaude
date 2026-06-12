import { Module } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { SchemesController } from './schemes.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [SchemesController],
  providers:   [SchemesService],
  exports:     [SchemesService],
})
export class SchemesModule {}