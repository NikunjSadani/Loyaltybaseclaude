/**
 * Whether THIS environment can actually process a Sales Import (integration-audit M1).
 *
 * The runner (sales-import-runner.service.ts) only starts processing when:
 *   SALES_IMPORT_RUNNER=inline                                   → in-process (local dev / e2e), or
 *   SALES_IMPORT_RUNNER=job + SALES_IMPORT_JOB + GCP_PROJECT(_ID) → the Cloud Run worker job.
 * Anything else ('none') leaves every import QUEUED forever. While that is the case the API refuses to switch
 * `features.salesImport` ON for any tenant, and refuses new uploads / reprocesses for a tenant that already has it on.
 * Pure (reads env at call time) so the gifsy console path can use it without depending on the ingest module.
 */
export const SALES_IMPORT_RUNNER_NOT_CONFIGURED_MESSAGE =
  "Sales Import can't be switched on here yet: the background processor isn't set up in this environment.";

/** Env values can carry a BOM / trailing CR from Windows-written secrets (mirrors the runner's `env`). */
function envOf(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return source[name]?.replace(/^﻿/, '').trim() || undefined;
}

export function salesImportRunnerConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  const mode = envOf(source, 'SALES_IMPORT_RUNNER');
  if (mode === 'inline') return true;
  if (mode === 'job') {
    return !!(envOf(source, 'GCP_PROJECT') ?? envOf(source, 'GCP_PROJECT_ID')) && !!envOf(source, 'SALES_IMPORT_JOB');
  }
  return false;
}
