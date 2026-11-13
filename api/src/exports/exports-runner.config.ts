/**
 * Whether THIS environment can prepare background downloads (mirrors sales-import-runner.config.ts):
 *   EXPORTS_RUNNER=inline                               → in-process (local dev / e2e / tests ONLY — it builds the file
 *                                                         inside the API, which is exactly the memory risk the Downloads
 *                                                         page exists to remove; never set it on staging/prod);
 *   EXPORTS_RUNNER=job + EXPORTS_JOB + GCP_PROJECT(_ID) → the Cloud Run job gifsy-exports(-staging).
 * Anything else: a heavy download answers 503 "Downloads aren't set up on this server yet" — it is NEVER built inside
 * the API as a fallback. Pure (reads env at call time).
 */
function envOf(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return source[name]?.replace(/^﻿/, '').trim() || undefined;
}

export type ExportsRunnerMode = 'inline' | 'job' | 'none';

export function exportsRunnerMode(source: NodeJS.ProcessEnv = process.env): ExportsRunnerMode {
  const mode = envOf(source, 'EXPORTS_RUNNER');
  if (mode === 'inline') return 'inline';
  if (mode === 'job' && !!(envOf(source, 'GCP_PROJECT') ?? envOf(source, 'GCP_PROJECT_ID')) && !!envOf(source, 'EXPORTS_JOB')) {
    return 'job';
  }
  return 'none';
}

export function exportsRunnerConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  return exportsRunnerMode(source) !== 'none';
}

export { envOf as exportsEnv };
