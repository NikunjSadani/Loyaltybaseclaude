'use client';

/**
 * "New downloads" badge (M6) — which READY files this person has already seen or downloaded, kept in the
 * browser only (no API). Keyed per user + brand so two brands (or two people on one machine) never share
 * a count. Every storage access is wrapped: a private window / blocked storage just means "nothing seen yet",
 * and the badge still renders (it then counts every Ready file on the first page).
 */
import type { ExportRequestDto } from '@/lib/exports/types';

const PREFIX = 'gifsy.downloads.seen';
/** Fired on `window` whenever the seen set (or the list) changes, so the nav badge recounts at once. */
export const DOWNLOADS_CHANGED_EVENT = 'gifsy:downloads-changed';
/** Never keep more ids than this (oldest dropped) — the list only shows recent files anyway. */
const MAX_IDS = 300;

export function seenStorageKey(userId: string | null | undefined, brandKey: string | null | undefined): string {
  return `${PREFIX}:${userId || 'anon'}:${brandKey || 'platform'}`;
}

export function readSeen(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Mark ids as seen. Returns true when something new was recorded. Never throws. */
export function markSeen(key: string, ids: string[]): boolean {
  if (ids.length === 0) return false;
  const seen = readSeen(key);
  let changed = false;
  for (const id of ids) {
    if (!seen.has(id)) { seen.add(id); changed = true; }
  }
  if (!changed) return false;
  try {
    const arr = [...seen];
    window.localStorage.setItem(key, JSON.stringify(arr.slice(Math.max(0, arr.length - MAX_IDS))));
  } catch {
    /* storage blocked — the badge simply keeps counting these */
  }
  notifyDownloadsChanged();
  return true;
}

export function notifyDownloadsChanged(): void {
  try {
    window.dispatchEvent(new Event(DOWNLOADS_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
}

/** Ready (not past expiry) files that are not in the seen set. */
export function countUnseenReady(items: Pick<ExportRequestDto, 'id' | 'status' | 'expiresAt'>[], seen: Set<string>, now = Date.now()): number {
  return items.filter((i) =>
    i.status === 'READY'
    && !(i.expiresAt && Date.parse(i.expiresAt) <= now)
    && !seen.has(i.id)).length;
}
