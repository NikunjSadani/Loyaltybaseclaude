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
      // Tenant subdomains — images hosted on gifsy.in tenant domains
      { protocol: "https", hostname: "platform.gifsy.in", pathname: "/**" },
      { protocol: "https", hostname: "deoleo.gifsy.in",   pathname: "/**" },
      { protocol: "https", hostname: "clientb.gifsy.in",  pathname: "/**" },
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
