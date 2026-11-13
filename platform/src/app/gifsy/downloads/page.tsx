'use client';

/** Downloads in the Gifsy console shell (dark) — same list as /admin/downloads (DOWNLOADS-PAGE.md). */
import { DownloadsPanel } from '@/components/exports/downloads-panel';

export default function GifsyDownloadsPage() {
  return <DownloadsPanel tone="dark" />;
}
