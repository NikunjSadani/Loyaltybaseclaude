import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/roles.decorator';

@Controller({ version: VERSION_NEUTRAL })
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /health
   * Liveness probe used by Cloud Run and load balancers.
   * Must be @Public — no JWT required.
   */
  @Get('health')
  @Public()
  health(): { status: string } {
    return { status: 'ok' };
  }
}
