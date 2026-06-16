import { Module } from '@nestjs/common';
import { SchemesController } from './schemes.controller';
import { SchemesService } from './schemes.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SchemesController],
  providers: [SchemesService],
})
export class SchemesModule {}
