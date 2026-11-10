import { salesImportRunnerConfigured } from './sales-import-runner.config';

describe('salesImportRunnerConfigured (integration-audit M1)', () => {
  it('unset / none / unknown → not configured', () => {
    expect(salesImportRunnerConfigured({})).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'none' })).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: '' })).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'cron' })).toBe(false);
  });

  it('inline → configured (local dev / e2e), tolerating a Windows CR/BOM', () => {
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'inline' })).toBe(true);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: '﻿inline\r\n' })).toBe(true);
  });

  it('job → configured only with SALES_IMPORT_JOB and a GCP project (exactly what the runner needs)', () => {
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'job' })).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'job', SALES_IMPORT_JOB: 'j' })).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'job', GCP_PROJECT: 'p' })).toBe(false);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'job', SALES_IMPORT_JOB: 'j', GCP_PROJECT: 'p' })).toBe(true);
    expect(salesImportRunnerConfigured({ SALES_IMPORT_RUNNER: 'job', SALES_IMPORT_JOB: 'j', GCP_PROJECT_ID: 'p' })).toBe(true);
  });

  it('defaults to process.env', () => {
    const saved = process.env.SALES_IMPORT_RUNNER;
    try {
      process.env.SALES_IMPORT_RUNNER = 'inline';
      expect(salesImportRunnerConfigured()).toBe(true);
      delete process.env.SALES_IMPORT_RUNNER;
      expect(salesImportRunnerConfigured()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SALES_IMPORT_RUNNER;
      else process.env.SALES_IMPORT_RUNNER = saved;
    }
  });
});
