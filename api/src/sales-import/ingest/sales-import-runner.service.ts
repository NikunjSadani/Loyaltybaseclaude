import { Injectable, Logger } from '@nestjs/common';
import { SalesImportProcessorService } from './sales-import-processor.service';
import { SalesImportRetentionService } from './sales-import-retention.service';
import { salesImportRunnerConfigured } from './sales-import-runner.config';

export type SalesImportKickResult = 'inline' | 'job' | 'none';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Env values can carry a BOM / trailing CR from Windows-written secrets (see StorageService). */
function env(name: string): string | undefined {
  return process.env[name]?.replace(/^﻿/, '').trim() || undefined;
}

/**
 * SalesImportRunnerService — starts processing after an upload completes (plan D-4, task I-8).
 *   SALES_IMPORT_RUNNER=inline → run the claim/process loop in-process on the next tick (local dev / e2e);
 *   SALES_IMPORT_RUNNER=job    → Cloud Run Admin API `POST …/jobs/{SALES_IMPORT_JOB}:run` (NO overrides:
 *                                the job claims QUEUED rows itself) with a metadata-server token;
 *   unset / any error          → 'none' (the import stays QUEUED; the drain endpoint recovers it).
 * MUST never throw to the caller. OWNER: Lane I.
 */
@Injectable()
export class SalesImportRunnerService {
  private readonly logger = new Logger(SalesImportRunnerService.name);
  private inlineRunning = false;
  private inlineAgain = false;
  /** The in-flight inline loop (tests and shutdown can await it). */
  inlineIdle: Promise<void> = Promise.resolve();
  /**
   * More work the SAME worker drains (background Apply / Recalculate jobs, registered by SalesImportModule — the jobs
   * service lives in the KPI module, which this ingest module must not import). Inline mode runs them after the imports.
   */
  private readonly extraDrains: Array<() => Promise<unknown>> = [];

  registerDrain(fn: () => Promise<unknown>): void {
    this.extraDrains.push(fn);
  }

  constructor(
    private readonly processor: SalesImportProcessorService,
    private readonly retention?: SalesImportRetentionService,
  ) {}

  /** M1: false when kick() could never start processing here (see sales-import-runner.config.ts). */
  isConfigured(): boolean {
    return salesImportRunnerConfigured();
  }

  async kick(): Promise<SalesImportKickResult> {
    try {
      const mode = env('SALES_IMPORT_RUNNER');
      if (mode === 'inline') {
        this.startInline();
        return 'inline';
      }
      if (mode === 'job') return await this.runJob();
      this.logger.warn('SALES_IMPORT_RUNNER is not set (inline|job); the import stays QUEUED until the worker runs.');
      return 'none';
    } catch (e) {
      this.logger.warn(`Sales Import kick failed: ${(e as Error).message}`);
      return 'none';
    }
  }

  /** One loop at a time per process; a kick during a run makes the loop look again before it stops. */
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
        for (const drain of this.extraDrains) await drain();
      } while (this.inlineAgain);
      // S5: the inline drain sweeps retention like the job does (never throws).
      await this.retention?.sweep({ limit: 50 });
    } catch (e) {
      this.logger.error(`Sales Import inline worker stopped: ${(e as Error).message}`);
    }
  }

  private async runJob(): Promise<SalesImportKickResult> {
    const project = env('GCP_PROJECT') ?? env('GCP_PROJECT_ID');
    const region = env('GCP_REGION') ?? 'asia-south1';
    const job = env('SALES_IMPORT_JOB');
    if (!project || !job) {
      this.logger.warn('SALES_IMPORT_RUNNER=job but GCP_PROJECT / SALES_IMPORT_JOB is not set; import stays QUEUED.');
      return 'none';
    }
    const tokenRes = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
    if (!tokenRes.ok) {
      this.logger.warn(`Sales Import kick: metadata token HTTP ${tokenRes.status}`);
      return 'none';
    }
    const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
    if (!token) {
      this.logger.warn('Sales Import kick: metadata token response had no access_token');
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
      this.logger.warn(`Sales Import kick: jobs:run HTTP ${res.status}`);
      return 'none';
    }
    return 'job';
  }
}
