import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { EmployeeSupportController } from './employee-support.controller';
import { TicketsService } from './tickets.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TicketsController, EmployeeSupportController],
  providers: [TicketsService],
})
export class TicketsModule {}
