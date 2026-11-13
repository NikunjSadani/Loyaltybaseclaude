import { Injectable, Logger } from '@nestjs/common';
import { ExportsProcessorService } from './exports-processor.service';
import { exportsEnv, exportsRunnerMode } from './exports-runner.config';

export type ExportsKickResult = 'inline' | 'job' | 'none';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Starts preparing queued downloads (mirror of SalesImportRunnerService):
 *   EXPORTS_RUNNER=inline → the claim/process loop in-process on the next tick (local dev / e2e / tests only);
 *   EXPORTS_RUNNER=job    → Cloud Run Admin API `POST …/jobs/{EXPORTS_JOB}:run` (no overrides — the job claims QUEUED
 *                           rows itself) with a metadata-server token;
 *   unset / any error     → 'none' (the request stays QUEUED; the self-heal kick / scheduler drain recovers it).
 * MUST never throw to the caller.
 */
@Injectable()
export class ExportsRunnerService {
  private readonly logger = new Logger(ExportsRunnerService.name);
  private inlineRunning = false;
  private inlineAgain = false;
  /** The in-flight inline loop (tests and shutdown can await it). */
  inlineIdle: Promise<void> = Promise.resolve();

  constructor(private readonly processor: ExportsProcessorService) {}

  isConfigured(): boolean {
    return exportsRunnerMode() !== 'none';
  }

  async kick(): Promise<ExportsKickResult> {
    try {
      const mode = exportsRunnerMode();
      if (mode === 'inline') {
        this.startInline();
        return 'inline';
      }
      if (mode === 'job') return await this.runJob();
      this.logger.warn('EXPORTS_RUNNER is not configured (inline|job + EXPORTS_JOB + GCP_PROJECT); requests stay QUEUED.');
      return 'none';
    } catch (e) {
      this.logger.warn(`Exports kick failed: ${(e as Error).message}`);
      return 'none';
    }
  }

  private startInline(): void {
    if (this.inlineRunning) {
      this.inlineAgain = true;
      return;
    }
    this.inlineRunning = true;
    this.inlineIdle = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.drainInline().finally(() => {
          this.inlineRunning = false;
          resolve();
        });
      });
    });
  }

  private async drainInline(): Promise<void> {
    try {
      do {
        this.inlineAgain = false;
        for (let row = await this.processor.claimNext(); row; row = await this.processor.claimNext()) {
          await this.processor.processClaimed(row);
        }
      } while (this.inlineAgain);
      await this.processor.sweep();
    } catch (e) {
      this.logger.error(`Exports inline worker stopped: ${(e as Error).message}`);
    }
  }

  private async runJob(): Promise<ExportsKickResult> {
    const project = exportsEnv(process.env, 'GCP_PROJECT') ?? exportsEnv(process.env, 'GCP_PROJECT_ID');
    const region = exportsEnv(process.env, 'GCP_REGION') ?? 'asia-south1';
    const job = exportsEnv(process.env, 'EXPORTS_JOB');
    if (!project || !job) return 'none';
    const tokenRes = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
    if (!tokenRes.ok) {
      this.logger.warn(`Exports kick: metadata token HTTP ${tokenRes.status}`);
      return 'none';
    }
    const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
    if (!token) {
      this.logger.warn('Exports kick: metadata token response had no access_token');
      return 'none';
    }
    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}:run`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      // 403 here = the one-time IAM grant (roles/run.jobsExecutor on the job) is missing — see DOWNLOADS-PAGE.md runbook.
      this.logger.warn(`Exports kick: jobs:run HTTP ${res.status}`);
      return 'none';
    }
    return 'job';
  }
}
