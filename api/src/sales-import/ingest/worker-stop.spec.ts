import {
  WORKER_STOP_DEADLINE_MS,
  WORKER_STOP_FORCED_EXIT_CODE,
  WorkerStop,
  drainImports,
  installWorkerSignals,
} from './worker-stop';

describe('WorkerStop', () => {
  it('is requested once; listeners fire once (late listeners immediately); unsubscribe works', () => {
    const s = new WorkerStop();
    const a = jest.fn();
    const b = jest.fn();
    const off = s.onStop(b);
    s.onStop(a);
    off();
    expect(s.requested).toBe(false);
    s.request('SIGTERM');
    s.request('SIGINT');
    expect(s.requested).toBe(true);
    expect(s.reason).toBe('SIGTERM');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    const late = jest.fn();
    s.onStop(late);
    expect(late).toHaveBeenCalledWith('SIGTERM');
  });

  it('tracks a critical section (the final READY transaction)', () => {
    const s = new WorkerStop();
    expect(s.inCritical).toBe(false);
    s.enterCritical();
    expect(s.inCritical).toBe(true);
    s.exitCritical();
    s.exitCritical(); // never negative
    expect(s.inCritical).toBe(false);
  });

  it('a throwing listener never prevents the others', () => {
    const s = new WorkerStop();
    const ok = jest.fn();
    s.onStop(() => { throw new Error('x'); });
    s.onStop(ok);
    s.request('SIGTERM');
    expect(ok).toHaveBeenCalled();
  });
});

describe('installWorkerSignals (Cloud Run Jobs: SIGTERM, then SIGKILL after ~10 s)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = () => {
    const handlers: Record<string, () => void> = {};
    const stop = new WorkerStop();
    const deps = { stop, on: jest.fn((sig: string, cb: () => void) => (handlers[sig] = cb)), exit: jest.fn(), log: jest.fn() };
    installWorkerSignals(deps);
    return { handlers, stop, deps };
  };

  it('listens for SIGTERM and SIGINT; a signal requests the stop and logs JSON', () => {
    const { handlers, stop, deps } = setup();
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.SIGTERM();
    expect(stop.requested).toBe(true);
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual(expect.objectContaining({ msg: expect.stringMatching(/stopping/), signal: 'SIGTERM' }));
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it(`forces an exit after ${WORKER_STOP_DEADLINE_MS} ms if the drain has not finished (before SIGKILL)`, () => {
    const { handlers, deps } = setup();
    handlers.SIGTERM();
    handlers.SIGTERM(); // a repeat signal does not start a second deadline
    jest.advanceTimersByTime(WORKER_STOP_DEADLINE_MS - 1);
    expect(deps.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(WORKER_STOP_FORCED_EXIT_CODE);
    expect(WORKER_STOP_DEADLINE_MS).toBeLessThanOrEqual(8_000);
  });

  it('never forces an exit while the READY transaction is in progress (it commits whole or rolls back on SIGKILL)', () => {
    const { handlers, stop, deps } = setup();
    stop.enterCritical();
    handlers.SIGTERM();
    jest.advanceTimersByTime(WORKER_STOP_DEADLINE_MS * 3);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/READY write in progress/);
  });
});

describe('drainImports (worker loop)', () => {
  it('claims until nothing is claimable, passing the stop token to every run', async () => {
    const stop = new WorkerStop();
    const rows = [{ id: 'a' }, { id: 'b' }];
    const proc = { claimNext: jest.fn(async () => rows.shift() ?? null), processClaimed: jest.fn(async () => undefined) };
    expect(await drainImports(proc as never, stop)).toBe(2);
    expect(proc.processClaimed).toHaveBeenCalledWith({ id: 'a' }, stop);
    expect(proc.claimNext).toHaveBeenCalledTimes(3);
  });

  it('stops claiming once a stop is requested (the current import finishes or is released by its run)', async () => {
    const stop = new WorkerStop();
    const proc = {
      claimNext: jest.fn(async () => ({ id: 'x' })),
      processClaimed: jest.fn(async () => { stop.request('SIGTERM'); }),
    };
    expect(await drainImports(proc as never, stop)).toBe(1);
    expect(proc.claimNext).toHaveBeenCalledTimes(1);
  });

  it('a stop requested before the first claim claims nothing', async () => {
    const stop = new WorkerStop();
    stop.request('SIGTERM');
    const proc = { claimNext: jest.fn(), processClaimed: jest.fn() };
    expect(await drainImports(proc as never, stop)).toBe(0);
    expect(proc.claimNext).not.toHaveBeenCalled();
  });

  it('a row claimed while the signal arrived is still handed to the run (which releases it at once)', async () => {
    const stop = new WorkerStop();
    const proc = {
      claimNext: jest.fn(async () => { stop.request('SIGTERM'); return { id: 'late' }; }),
      processClaimed: jest.fn(async () => undefined),
    };
    expect(await drainImports(proc as never, stop)).toBe(1);
    expect(proc.processClaimed).toHaveBeenCalledWith({ id: 'late' }, stop);
    expect(proc.claimNext).toHaveBeenCalledTimes(1);
  });
});
