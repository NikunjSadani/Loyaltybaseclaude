/// <reference types="vitest/globals" />
/**
 * salesImportApi.historyCombos — plain fetch with an AbortSignal (re-check L-c): same envelope + error conventions as the
 * shared api client (403 → the standard permission message).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { salesImportApi } from '../api';

const respond = (status: number, body: unknown, statusText = '') =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status, statusText }));

afterEach(() => vi.restoreAllMocks());

describe('salesImportApi.historyCombos', () => {
  it('GETs the route with the query and passes the AbortSignal through; returns the envelope', async () => {
    const spy = respond(200, { success: true, data: { months: ['2026-10'] } });
    const ctrl = new AbortController();
    const r = await salesImportApi.historyCombos({ lastMonths: 3 }, ctrl.signal);
    expect(spy).toHaveBeenCalledWith('/api/admin/sales-import/history-combos?lastMonths=3', expect.objectContaining({ method: 'GET', signal: ctrl.signal }));
    expect(r).toEqual({ success: true, data: { months: ['2026-10'] } });
    await salesImportApi.historyCombos({ month: '2026-09' });
    expect(spy).toHaveBeenLastCalledWith('/api/admin/sales-import/history-combos?month=2026-09', expect.anything());
  });

  it("a 403 without a body error gets the standard \"You don't have permission\" message", async () => {
    respond(403, {}, 'Forbidden');
    expect(await salesImportApi.historyCombos({ lastMonths: 1 })).toEqual({ success: false, error: "You don't have permission to do that", status: 403 });
  });

  it('other errors carry the body error, else the status text', async () => {
    respond(404, { success: false, error: 'No stored sales lines for that month.' });
    expect(await salesImportApi.historyCombos({ month: '2026-01' })).toEqual({ success: false, error: 'No stored sales lines for that month.', status: 404 });
    vi.restoreAllMocks();
    respond(503, undefined, 'Service Unavailable');
    expect(await salesImportApi.historyCombos({ lastMonths: 12 })).toEqual({ success: false, error: 'Service Unavailable', status: 503 });
  });

  it('an aborted / failed request resolves to an error envelope (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    const r = await salesImportApi.historyCombos({ lastMonths: 1 });
    expect(r.success).toBe(false);
  });
});
