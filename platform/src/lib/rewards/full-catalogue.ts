import { api, type ApiResponse } from '@/lib/api-client';

/**
 * Load the WHOLE partner reward catalogue (GET /api/rewards/catalog), every page.
 *
 * Why: the API pages the catalogue (default 20, max 200 per page, ordered by points cost). The partner
 * Rewards page and the sales Catalogue page used to call it with no page size, so a tenant with more than
 * 20 items only ever saw the 20 cheapest — on Bajaj prod that was the 20 "choose an amount" vouchers
 * (points cost 0), hiding every physical gift (found 2026-11-27).
 *
 * No silent partial result: if any page fails, the whole load fails (callers already show their
 * error / empty state), and a runaway `pages` value stops at MAX_PAGES with an explicit error.
 */
export const CATALOGUE_PAGE_SIZE = 200; // API ListCatalogQuery @Max(200)
const MAX_PAGES = 50; // 10,000 items — far beyond any real catalogue

interface CataloguePage<TItem> {
  items: TItem[];
  userBalance?: number;
  pagination?: { page: number; limit: number; total: number; pages: number };
}

export async function fetchFullCatalogue<TItem extends { id: string } = { id: string }>(): Promise<
  ApiResponse<{ items: TItem[]; userBalance?: number }>
> {
  const items: TItem[] = [];
  const seen = new Set<string>();
  let userBalance: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await api.get<CataloguePage<TItem>>(`/api/rewards/catalog?page=${page}&limit=${CATALOGUE_PAGE_SIZE}`);
    if (!res.success) {
      return page === 1 ? res : { ...res, error: `Could not load the full catalogue (page ${page}): ${res.error}` };
    }
    const data = res.data;
    if (page === 1) userBalance = data.userBalance;
    for (const it of data.items ?? []) {
      if (it && typeof it.id === 'string') {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
      }
      items.push(it);
    }
    const pages = data.pagination?.pages;
    const got = data.items?.length ?? 0;
    if (typeof pages !== 'number' || page >= pages || got === 0) return { success: true, data: { items, userBalance } };
  }
  return { success: false, error: `The catalogue has more than ${MAX_PAGES} pages — stopped loading it.` };
}
