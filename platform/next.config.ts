import type { NextConfig } from "next";
import path from "path";

// Phase S (S6) — thin frontend: the browser keeps calling same-origin `/api/*`,
// and Next proxies those to the NestJS backend's versioned `/v1/*` surface. This
// preserves the existing `Authorization: Bearer` (localStorage) auth with zero page
// changes, keeps login same-origin, and avoids cross-origin CORS for the web client.
// `beforeFiles` runs BEFORE the local `src/app/api/*` handlers, so the backend wins
// over the still-present platform routes (those are deleted at S8).
// EXCLUDED (kept on local handlers until the backend ports them — see RESUME.md
// deferred list): visibility/submit, admin/kyc approvals.
// NOTE: rewards/redeem(+confirm) WAS excluded but the backend ported it in P5; the stale exclusion
// routed the money path to a dead local handler (broken — used retired platform Prisma). Now forwarded.
const BACKEND_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Required for Docker standalone build (Cloud Run)
  output: 'standalone',
  async rewrites() {
    return {
      beforeFiles: [
        {
          source:
            '/api/:path((?!visibility/submit|admin/kyc).*)',
          destination: `${BACKEND_API_URL}/v1/:path`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
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
