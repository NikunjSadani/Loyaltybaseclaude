import { Module } from '@nestjs/common';
import { GifsyController } from './gifsy.controller';
import { GifsyService } from './gifsy.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [GifsyController],
  providers: [GifsyService],
})
export class GifsyModule {}
