/**
 * Server-side tenant helpers.
 * Import these only in Server Components and API routes — not in client components.
 */

import { headers } from 'next/headers';
import { resolveClientConfig } from './tenant-resolution';
import { buildCssVariables } from './client-config';
import { DEOLEO_CONFIG } from './client-registry';
import type { ClientConfig } from './client-config';

/**
 * Reads the resolved tenant slug from the x-tenant-slug header set by
 * middleware and returns the full ClientConfig.
 *
 * Falls back to DEOLEO_CONFIG in dev (localhost) so all pages render
 * correctly without subdomain setup.
 */
export async function getTenantConfig(): Promise<ClientConfig> {
  const hdrs = await headers();
  const slug = hdrs.get('x-tenant-slug');
  if (!slug) return DEOLEO_CONFIG;
  return resolveClientConfig(slug) ?? DEOLEO_CONFIG;
}

/**
 * Returns a <style> JSX element injecting brand CSS variables into :root.
 * Place this inside <head> in the root layout.
 *
 * <BrandStyleTag config={config} />
 */
export function getBrandStyle(config: ClientConfig): string {
  return buildCssVariables(config);
}
