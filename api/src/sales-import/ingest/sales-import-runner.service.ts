import { Injectable, Logger } from '@nestjs/common';

export type SalesImportKickResult = 'inline' | 'job' | 'none';

/**
 * SalesImportRunnerService — starts processing after an upload completes (plan D-4, task I-8).
 *   SALES_IMPORT_RUNNER=inline → run the worker loop in-process (local dev / e2e);
 *   SALES_IMPORT_RUNNER=job    → Cloud Run Admin API `jobs/{SALES_IMPORT_JOB}:run` with a metadata token;
 *   unset / any error          → 'none' (the import stays QUEUED; the drain endpoint recovers it).
 * MUST never throw to the caller. OWNER: Lane I. Lane-0 skeleton always returns 'none'.
 */
@Injectable()
export class SalesImportRunnerService {
  private readonly logger = new Logger(SalesImportRunnerService.name);

  async kick(): Promise<SalesImportKickResult> {
    this.logger.warn('Sales Import runner not implemented yet (Lane I, task I-8); import stays QUEUED.');
    return 'none';
  }
}
