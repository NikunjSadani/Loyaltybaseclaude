import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';
import { ToastProvider } from '@/components/ui/toast';
import { getTenantConfig, getBrandStyle } from '@/lib/platform/server';
import { resolveFaviconIcoHref } from '@/lib/platform/favicon';
import { ClientConfigProvider } from '@/lib/platform/client-config-context';
import PwaHead from '@/components/pwa/PwaHead';
import ServiceWorkerRegister from '@/components/pwa/ServiceWorkerRegister';
import InstallPrompt from '@/components/pwa/InstallPrompt';
import PushSubscriptionManager from '@/components/pwa/PushSubscriptionManager';
import InstallBeacon from '@/components/pwa/InstallBeacon';
import SessionExpiryGuard from '@/components/auth/SessionExpiryGuard';
import type { PwaScope } from '@/lib/pwa/manifest';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const config = await getTenantConfig();
  return {
    title: {
      default: `${config.branding.displayName} Trade Loyalty Platform`,
      template: `%s | ${config.branding.displayName} Loyalty`,
    },
    description: `${config.branding.displayName} Trade Loyalty Platform — earn points, track targets, and redeem rewards.`,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Extend under the iOS notch/home-indicator so an installed PWA can use the safe area.
  viewportFit: 'cover',
  // themeColor is now dynamic — set via <meta> in head below
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = await getTenantConfig();
  const brandStyle = getBrandStyle(config);

  // Resolve the active portal from the path (proxy injects x-pathname). PWA install
  // metadata is only emitted for the installable shells — /sales and /partner — never
  // for /admin or /gifsy (desktop-operator tools, explicitly out of PWA scope).
  const pathname = (await headers()).get('x-pathname') ?? '';
  const pwaScope: PwaScope | null = pathname.startsWith('/sales')
    ? 'sales'
    : pathname.startsWith('/partner')
      ? 'partner'
      : null;

  return (
    <html lang="en" className={`${inter.variable} h-full antialiased overflow-x-hidden`}>
      <head>
        {/* Inject per-tenant CSS variables — drives all brand colours.
            brandStyle is sanitised at the source (buildCssVariables, AF-9): the
            only raw-interpolated value is the primaryColor, hard-guarded to a
            6-digit hex, so this sink cannot be broken out of. */}
        <style dangerouslySetInnerHTML={{ __html: brandStyle }} />
        <meta name="theme-color" content={config.branding.primaryColor} />
        {/* Per-tenant browser-tab favicon — the tenant's brand mark (same art as
            the installed-app icons). A console-provisioned tenant (§A-DOMAIN, no
            committed static assets under public/icons/<slug>/) sets an absolute GCS
            faviconUrl in its DB branding → prefer it. A legacy in-code tenant's
            faviconUrl is a local /favicons/<slug>.ico path that was never committed
            (real art lives at /icons/<slug>/favicon.ico) → fall back to the static
            slug path. See resolveFaviconIcoHref. The 192 png stays slug-based (no
            branding png field); a DB-only tenant simply has no 192 icon — the .ico
            is the browser-tab favicon. */}
        <link rel="icon" href={resolveFaviconIcoHref(config.branding.faviconUrl, config.slug)} sizes="any" />
        <link rel="icon" type="image/png" sizes="192x192" href={`/icons/${config.slug}/icon-192.png`} />
        {/* PWA install meta (manifest + iOS) — only for the /sales + /partner shells */}
        {pwaScope && <PwaHead scope={pwaScope} />}
      </head>
      <body
        suppressHydrationWarning
        className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans overflow-x-hidden"
      >
        <ClientConfigProvider config={config}>
          <ToastProvider>{children}</ToastProvider>
        </ClientConfigProvider>
        {/* Bounce to /auth/login on any /api 401 (expired/invalid token) instead of
            surfacing a cryptic "Invalid token" / blank data. App-wide. */}
        <SessionExpiryGuard />
        {/* PWA service-worker registrar — self-gates on NEXT_PUBLIC_PWA_SW_ENABLED
            (default OFF) + /sales|/partner path; renders null otherwise. */}
        <ServiceWorkerRegister />
        {/* PWA install prompt — self-gates on NEXT_PUBLIC_PWA_INSTALL_ENABLED
            (default OFF) + /sales|/partner + not-already-installed; null otherwise. */}
        <InstallPrompt />
        {/* PWA push opt-in — self-gates on NEXT_PUBLIC_PWA_PUSH_ENABLED (default OFF)
            + /sales|/partner + push support; only requests permission on a user gesture. */}
        <PushSubscriptionManager />
        {/* PWA install telemetry — self-gates on NEXT_PUBLIC_PWA_INSTALL_ENABLED
            (default OFF); reports a home-screen install once per session, no UI. */}
        <InstallBeacon />
      </body>
    </html>
  );
}
