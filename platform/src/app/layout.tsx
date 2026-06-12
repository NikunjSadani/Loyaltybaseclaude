import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ToastProvider } from '@/components/ui/toast';
import { getTenantConfig, getBrandStyle } from '@/lib/platform/server';
import { ClientConfigProvider } from '@/lib/platform/client-config-context';

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
  // themeColor is now dynamic — set via <meta> in head below
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = await getTenantConfig();
  const brandStyle = getBrandStyle(config);

  return (
    <html lang="en" className={`${inter.variable} h-full antialiased overflow-x-hidden`}>
      <head>
        {/* Inject per-tenant CSS variables — drives all brand colours */}
        <style dangerouslySetInnerHTML={{ __html: brandStyle }} />
        <meta name="theme-color" content={config.branding.primaryColor} />
      </head>
      <body
        suppressHydrationWarning
        className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans overflow-x-hidden"
      >
        <ClientConfigProvider config={config}>
          <ToastProvider>{children}</ToastProvider>
        </ClientConfigProvider>
      </body>
    </html>
  );
}
