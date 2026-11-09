import { Controller } from '@nestjs/common';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';

/**
 * POST /v1/sales-import/drain: `@Public`, header `x-drain-secret` = SALES_IMPORT_DRAIN_SECRET,
 * constant-time compare, FAIL-CLOSED when the secret is unset (copy the kyc.controller.ts drain). Kicks
 * the job when QUEUED or heartbeat-stale PROCESSING imports exist (Cloud Scheduler fallback).
 * OWNER: Lane I.
 */
@Controller('sales-import')
export class SalesImportDrainController {
  constructor(readonly runner: SalesImportRunnerService) {}
}
