import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ToastProvider } from '@/components/ui/toast';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Deoleo Trade Loyalty Platform',
    template: '%s | Deoleo Loyalty',
  },
  description:
    'Deoleo Trade Loyalty Platform — earn points, track targets, and redeem rewards.',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
  themeColor: '#C8102E',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50 text-gray-900 font-sans">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
