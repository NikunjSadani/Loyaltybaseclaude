import { Module } from '@nestjs/common';
import { VisibilityController } from './visibility.controller';
import { VisibilityService } from './visibility.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [VisibilityController],
  providers: [VisibilityService],
})
export class VisibilityModule {}
