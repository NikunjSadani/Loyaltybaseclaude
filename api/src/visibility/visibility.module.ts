import { Module }                    from '@nestjs/common';
import { VisibilityController }      from './visibility.controller';
import { VisibilityAdminController } from './visibility-admin.controller';
import { VisibilityService }         from './visibility.service';

@Module({
  controllers: [VisibilityController, VisibilityAdminController],
  providers:   [VisibilityService],
  exports:     [VisibilityService],
})
export class VisibilityModule {}
