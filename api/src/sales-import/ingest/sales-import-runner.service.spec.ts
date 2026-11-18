import { SalesImportRunnerService } from './sales-import-runner.service';

const ENV_KEYS = ['SALES_IMPORT_RUNNER', 'SALES_IMPORT_JOB', 'GCP_PROJECT', 'GCP_PROJECT_ID', 'GCP_REGION'] as const;

describe('SalesImportRunnerService.kick', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let processor: { claimNext: jest.Mock; processClaimed: jest.Mock };
  let runner: SalesImportRunnerService;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    processor = { claimNext: jest.fn().mockResolvedValue(null), processClaimed: jest.fn().mockResolvedValue(undefined) };
    runner = new SalesImportRunnerService(processor as never);
    jest.spyOn((runner as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('M1: isConfigured() mirrors what kick() can do (unset/job-without-job → false; inline / full job → true)', () => {
    expect(runner.isConfigured()).toBe(false);
    process.env.SALES_IMPORT_RUNNER = 'job';
    expect(runner.isConfigured()).toBe(false);
    process.env.SALES_IMPORT_JOB = 'gifsy-sales-import';
    process.env.GCP_PROJECT = 'p';
    expect(runner.isConfigured()).toBe(true);
    process.env.SALES_IMPORT_RUNNER = 'inline';
    expect(runner.isConfigured()).toBe(true);
  });

  it('unset → none, nothing called', async () => {
    await expect(runner.kick()).resolves.toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processor.claimNext).not.toHaveBeenCalled();
  });

  it('inline → runs the claim/process loop in-process until nothing is claimable', async () => {
    process.env.SALES_IMPORT_RUNNER = 'inline\r\n';
    processor.claimNext.mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce({ id: 'b' }).mockResolvedValue(null);
    await expect(runner.kick()).resolves.toBe('inline');
    await runner.inlineIdle;
    expect(processor.processClaimed.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
  });

  it('inline → registered drains (background Apply / Recalculate jobs) run after the imports, in the same loop', async () => {
    process.env.SALES_IMPORT_RUNNER = 'inline';
    const order: string[] = [];
    processor.claimNext.mockResolvedValueOnce({ id: 'a' }).mockResolvedValue(null);
    processor.processClaimed.mockImplementation(async (row: { id: string }) => { order.push(`import:${row.id}`); });
    runner.registerDrain(async () => { order.push('applyJobs'); });
    await runner.kick();
    await runner.inlineIdle;
    expect(order).toEqual(['import:a', 'applyJobs']);
  });

  it('inline → after the drain: the retention sweep only (no background combos rebuild)', async () => {
    process.env.SALES_IMPORT_RUNNER = 'inline';
    const retention = { sweep: jest.fn(async () => ({ abandoned: 0, purged: 0 })) };
    const r = new SalesImportRunnerService(processor as never, retention as never);
    await expect(r.kick()).resolves.toBe('inline');
    await r.inlineIdle;
    expect(retention.sweep).toHaveBeenCalledWith({ limit: 50 });
    expect(Object.keys(retention)).toEqual(['sweep']); // nothing else may be called on it
  });

  it('inline → a kick during a run makes the single loop look again (no second loop)', async () => {
    process.env.SALES_IMPORT_RUNNER = 'inline';
    let release!: () => void;
    processor.claimNext.mockResolvedValueOnce({ id: 'a' }).mockResolvedValue(null);
    processor.processClaimed.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    await runner.kick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await expect(runner.kick()).resolves.toBe('inline');
    release();
    await runner.inlineIdle;
    // first pass: claim a, claim null; second pass (again): claim null
    expect(processor.claimNext).toHaveBeenCalledTimes(3);
  });

  it('inline → a crashing loop is contained', async () => {
    process.env.SALES_IMPORT_RUNNER = 'inline';
    processor.claimNext.mockRejectedValue(new Error('db down'));
    jest.spyOn((runner as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    await expect(runner.kick()).resolves.toBe('inline');
    await runner.inlineIdle;
  });

  it('job → metadata token, then POST jobs/{job}:run with a Bearer token and no overrides', async () => {
    process.env.SALES_IMPORT_RUNNER = 'job';
    process.env.GCP_PROJECT = 'proj-1';
    process.env.SALES_IMPORT_JOB = 'gifsy-sales-import-staging';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(runner.kick()).resolves.toBe('job');
    expect(fetchMock.mock.calls[0][0]).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Metadata-Flavor': 'Google' });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://run.googleapis.com/v2/projects/proj-1/locations/asia-south1/jobs/gifsy-sales-import-staging:run',
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', headers: { Authorization: 'Bearer tok' } });
  });

  it('job → falls back to GCP_PROJECT_ID and honours GCP_REGION', async () => {
    process.env.SALES_IMPORT_RUNNER = 'job';
    process.env.GCP_PROJECT_ID = 'p2';
    process.env.GCP_REGION = 'europe-west1';
    process.env.SALES_IMPORT_JOB = 'j';
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 't' }) }).mockResolvedValueOnce({ ok: true });
    await runner.kick();
    expect(fetchMock.mock.calls[1][0]).toBe('https://run.googleapis.com/v2/projects/p2/locations/europe-west1/jobs/j:run');
  });

  it.each([
    ['missing job env', () => undefined, []],
    ['metadata unreachable', () => fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND')), ['tok']],
    ['metadata non-200', () => fetchMock.mockResolvedValueOnce({ ok: false, status: 404 }), ['tok']],
    ['no access_token', () => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }), ['tok']],
    [
      'jobs:run 403',
      () => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 't' }) }).mockResolvedValueOnce({ ok: false, status: 403 }),
      ['tok'],
    ],
  ])('job → %s → none (never throws)', async (_label, arrange, withJob) => {
    process.env.SALES_IMPORT_RUNNER = 'job';
    process.env.GCP_PROJECT = 'p';
    if ((withJob as string[]).length) process.env.SALES_IMPORT_JOB = 'j';
    (arrange as () => void)();
    await expect(runner.kick()).resolves.toBe('none');
  });
});
