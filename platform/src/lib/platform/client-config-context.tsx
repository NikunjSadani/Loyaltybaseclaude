'use client';

/**
 * ClientConfigContext — provides the resolved ClientConfig to all client
 * components via a React context.
 *
 * Usage:
 *   // In a server layout — read headers, resolve config, pass to provider
 *   <ClientConfigProvider config={resolvedConfig}>
 *     {children}
 *   </ClientConfigProvider>
 *
 *   // In any client component
 *   const config = useClientConfig();
 *   const color  = config.branding.primaryColor;
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { ClientConfig } from './client-config';
import { DEOLEO_CONFIG } from './client-registry';

const ClientConfigContext = createContext<ClientConfig>(DEOLEO_CONFIG);

export function ClientConfigProvider({
  config,
  children,
}: {
  config: ClientConfig;
  children: ReactNode;
}) {
  return (
    <ClientConfigContext.Provider value={config}>
      {children}
    </ClientConfigContext.Provider>
  );
}

/** Returns the ClientConfig for the current tenant. */
export function useClientConfig(): ClientConfig {
  return useContext(ClientConfigContext);
}

/** Returns true if a feature flag is enabled for the current tenant. */
export function useFeatureFlag(key: keyof Omit<ClientConfig['features'], 'partnerApp'>): boolean {
  const config = useClientConfig();
  return !!(config.features as unknown as Record<string, boolean>)[key];
}
