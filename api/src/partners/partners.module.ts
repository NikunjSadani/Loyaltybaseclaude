import { Module } from '@nestjs/common';
import { PartnersService }    from './partners.service';
import { PartnersController } from './partners.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule }   from '../auth/auth.module';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [PartnersController],
  providers:   [PartnersService],
  exports:     [PartnersService],
})
export class PartnersModule {}
