import { Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { hasClaimableExports } from './exports-claim';
import { ExportsProcessorService } from './exports-processor.service';
import { ExportsRunnerService } from './exports-runner.service';

/**
 * POST /v1/exports/drain — OPTIONAL Cloud Scheduler fallback (the Downloads list already self-heals). `@Public`,
 * header `x-drain-secret`, constant-time compare, FAIL-CLOSED when no secret is set. Secret: EXPORTS_DRAIN_SECRET when
 * set, else the EXISTING SALES_IMPORT_DRAIN_SECRET (already bound to the API in both environments) — so no new Secret
 * Manager secret is needed. Kicks the worker when something is claimable; when idle, runs the bounded retention sweep
 * inside the request (no work outlives the response — the API runs with CPU throttling). Reveals only `kicked`.
 */
@Controller('exports')
export class ExportsDrainController {
  constructor(
    private readonly runner: ExportsRunnerService,
    private readonly prisma: PrismaService,
    private readonly processor: ExportsProcessorService,
  ) {}

  @Public()
  @Post('drain')
  @HttpCode(200)
  async drain(@Headers('x-drain-secret') secret?: string): Promise<{ kicked: boolean }> {
    const clean = (v?: string) => v?.replace(/^﻿/, '').trim() || undefined;
    const expected = clean(process.env.EXPORTS_DRAIN_SECRET) ?? clean(process.env.SALES_IMPORT_DRAIN_SECRET);
    if (!expected) throw new ForbiddenException('Drain disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ForbiddenException('Invalid drain secret');
    if (!(await hasClaimableExports(this.prisma))) {
      await this.processor.sweep();
      return { kicked: false };
    }
    return { kicked: (await this.runner.kick()) !== 'none' };
  }
}
