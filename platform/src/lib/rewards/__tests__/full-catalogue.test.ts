import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { fetchFullCatalogue, CATALOGUE_PAGE_SIZE } from '../full-catalogue';

const page = (ids: number[], p: number, pages: number, total: number, userBalance = 1000) => ({
  success: true as const,
  data: { items: ids.map((id) => ({ id: `r${id}` })), userBalance, pagination: { page: p, limit: CATALOGUE_PAGE_SIZE, total, pages } },
});

describe('fetchFullCatalogue — the partner/sales catalogue must never silently stop at the server default page (20)', () => {
  beforeEach(() => get.mockReset());

  it('FC1: asks for the largest page the API allows, page 1 first', async () => {
    get.mockResolvedValueOnce(page([1, 2], 1, 1, 2));
    await fetchFullCatalogue();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(`/api/rewards/catalog?page=1&limit=${CATALOGUE_PAGE_SIZE}`);
    expect(CATALOGUE_PAGE_SIZE).toBe(200); // API DTO @Max(200)
  });

  it('FC2: follows every page and returns all items + the first page balance', async () => {
    const p1 = Array.from({ length: 200 }, (_, i) => i);
    const p2 = Array.from({ length: 34 }, (_, i) => 200 + i);
    get.mockResolvedValueOnce(page(p1, 1, 2, 234, 750)).mockResolvedValueOnce(page(p2, 2, 2, 234, 999));
    const r = await fetchFullCatalogue();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.items).toHaveLength(234);
    expect(r.data.userBalance).toBe(750);
    expect(get.mock.calls[1][0]).toBe(`/api/rewards/catalog?page=2&limit=${CATALOGUE_PAGE_SIZE}`);
  });

  it('FC3: a response without pagination is treated as the whole catalogue (older API / test mocks)', async () => {
    get.mockResolvedValueOnce({ success: true, data: { items: [{ id: 'a' }], userBalance: 5 } });
    const r = await fetchFullCatalogue();
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.success && r.data.items).toEqual([{ id: 'a' }]);
  });

  it('FC4: a failed later page fails the whole load — never a silently partial catalogue', async () => {
    get.mockResolvedValueOnce(page(Array.from({ length: 200 }, (_, i) => i), 1, 2, 250))
      .mockResolvedValueOnce({ success: false, error: 'boom', status: 500 });
    const r = await fetchFullCatalogue();
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/boom/);
  });

  it('FC5: a failed first page is passed through unchanged', async () => {
    get.mockResolvedValueOnce({ success: false, error: 'nope', status: 401 });
    const r = await fetchFullCatalogue();
    expect(r).toEqual({ success: false, error: 'nope', status: 401 });
  });

  it('FC6: an item repeated across pages (sort ties shifting) is kept once', async () => {
    get.mockResolvedValueOnce(page([1, 2], 1, 2, 3)).mockResolvedValueOnce(page([2, 3], 2, 2, 3));
    const r = await fetchFullCatalogue();
    expect(r.success && r.data.items.map((x: { id: string }) => x.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('FC7: stops at a hard page ceiling instead of looping forever on a bad pages value', async () => {
    get.mockImplementation((url: string) => {
      const p = Number(new URL(url, 'http://x').searchParams.get('page'));
      return Promise.resolve(page([p], p, 10_000, 10_000));
    });
    const r = await fetchFullCatalogue();
    expect(get.mock.calls.length).toBeLessThanOrEqual(50);
    expect(r.success).toBe(false);
  });
});
