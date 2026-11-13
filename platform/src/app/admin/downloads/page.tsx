'use client';

/** Downloads — the caller's background report files (DOWNLOADS-PAGE.md). The API enforces access. */
import { DownloadsPanel } from '@/components/exports/downloads-panel';

export default function AdminDownloadsPage() {
  return <DownloadsPanel tone="light" />;
}
