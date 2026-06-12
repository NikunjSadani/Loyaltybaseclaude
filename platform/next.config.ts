import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Required for Docker standalone build (Cloud Run)
  output: 'standalone',
  // Pin the Turbopack root to this package so Next.js ignores
  // any stray lockfiles higher up in the directory tree.
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    remotePatterns: [
      // GCS — KYC docs, invoices, visibility images, logos
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        pathname: "/**",
      },
      // Cloud CDN delivery hostname (*.gifsy.in CDN origin)
      {
        protocol: "https",
        hostname: "*.gifsy.in",
        pathname: "/**",
      },
    ],
  },
  // Expose selected env vars to the client bundle
  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  },
  // Compress responses
  compress: true,
  // Strict mode for catching issues early
  reactStrictMode: true,
  // Log level
  logging: {
    fetches: { fullUrl: false },
  },
};

export default nextConfig;
