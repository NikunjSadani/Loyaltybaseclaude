/**
 * Help & Guides registry. Add a guide by creating its module (see payouts.ts) and
 * listing it here — the index page and viewer pick it up automatically. Guides are
 * plain markdown (GFM), rendered on the portal and printable. Audience-gating is at
 * the route level (Gifsy operators only); this registry is just the content list.
 */
export interface Guide {
  /** URL slug: /admin/guides/<slug> */
  slug: string;
  /** Card + page title. */
  title: string;
  /** One-line description on the index card. */
  summary: string;
  /** ISO date last reviewed, shown on the page. */
  updated: string;
  /** The guide body, GitHub-flavored markdown. Images: /guides/<slug>/*.png (public). */
  markdown: string;
}

// payouts.ts / tds.ts import only the `Guide` TYPE from here (erased at build) — no runtime cycle.
import { payoutsGuide } from './payouts';
import { tdsGuide } from './tds';

export const GUIDES: Guide[] = [payoutsGuide, tdsGuide];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
