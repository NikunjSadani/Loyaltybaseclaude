'use client';

/** Downloads — the caller's own background report files in the current brand (DOWNLOADS-PAGE.md). The API enforces access. */
import { DownloadsPanel } from '@/components/exports/downloads-panel';

export default function AdminDownloadsPage() {
  return <DownloadsPanel tone="light" />;
}
