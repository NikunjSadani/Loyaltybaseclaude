/**
 * Write-persistence helpers (S4). The harness's read tests prove pages SHOW real data; these prove a
 * write ACTUALLY persisted (not just optimistic UI). The pattern: perform the write with a unique
 * marker, then re-read from the backend (a full page reload, or a second session) and assert the
 * marker is still there.
 */
import { expect, type Page } from '@playwright/test';

/** A unique, run-distinct marker so a freshly-written row can't be confused with a pre-existing one. */
export function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Reload the page (forces a fresh backend fetch — not optimistic state) and assert `text` is visible.
 * This is the core persistence proof: a value that survives a reload came back from the server.
 */
export async function expectPersistsAfterReload(page: Page, text: string): Promise<void> {
  await page.reload();
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
}
