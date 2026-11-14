'use client';

/**
 * Downloads in the Gifsy console shell (dark). Lists the files the operator requested OUTSIDE a brand
 * (or, while working in a brand, that brand's) — the page says which (DOWNLOADS-PAGE.md).
 */
import { DownloadsPanel } from '@/components/exports/downloads-panel';

export default function GifsyDownloadsPage() {
  return <DownloadsPanel tone="dark" console />;
}
