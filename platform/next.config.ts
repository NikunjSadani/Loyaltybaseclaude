import type { NextConfig } from "next";
import path from "path";
import withSerwistInit from "@serwist/next";

// Phase S (S6) — thin frontend: the browser keeps calling same-origin `/api/*`,
// and Next proxies those to the NestJS backend's versioned `/v1/*` surface. This
// preserves the existing `Authorization: Bearer` (localStorage) auth with zero page
// changes, keeps login same-origin, and avoids cross-origin CORS for the web client.
// `beforeFiles` runs BEFORE the local `src/app/api/*` handlers, so the backend wins
// over the still-present platform routes (those are deleted at S8).
// NO EXCLUSIONS REMAIN — every `/api/*` now forwards to the backend:
//   - rewards/redeem(+confirm): ported in P5 (the stale exclusion routed the money
//     path to a dead local handler — fixed).
//   - visibility/submit: ported to POST /v1/visibility/submit (P0.6) — local route deleted.
//   - admin/kyc: was a no-op exclusion (KYC writes already live at /v1/kyc/*; the FE
//     calls /api/kyc/* which never matched this lookahead) — dropped.
const BACKEND_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Required for Docker standalone build (Cloud Run)
  output: 'standalone',
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${BACKEND_API_URL}/v1/:path*`,
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
  // Server Actions run behind the Cloudflare Worker, which rewrites `x-forwarded-host`
  // (e.g. uat.deoleoloyalty.gifsy.in → deoleoloyalty.gifsy.in for tenant resolution).
  // Next's Server-Action CSRF guard aborts when `origin` ≠ `x-forwarded-host`, which
  // hung the login form. Allow our tenant origins to bypass that check. NOTE: Next's
  // `*` does not cross dots, so multi-level hosts (uat.deoleoloyalty…) are listed
  // explicitly in addition to the single-level wildcard.
  experimental: {
    serverActions: {
      allowedOrigins: [
        '*.gifsy.in',                 // all single-label tenant subdomains (deoleo, clientb, platform, deoleoloyalty)
        'deoleoloyalty.gifsy.in',     // Deoleo prod (explicit for the launch domain; also covered above)
        'uat.deoleoloyalty.gifsy.in', // Deoleo UAT — 4-part host; `*` does not cross dots
        'clientb.app.gifsy.in',       // 4-part prod hostname (tenant-resolution tests) — not covered by `*.gifsy.in`
      ],
    },
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

// PWA phase F3 — Serwist service worker, BUILT but SHIPPED DISABLED.
// `withSerwist` only injects the SW-bundling webpack config; it does NOT register
// the worker. Registration lives entirely in <ServiceWorkerRegister>, gated behind
// NEXT_PUBLIC_PWA_SW_ENABLED==='true' (default OFF). So even when the SW IS emitted,
// no client installs it until that runtime flag is flipped post-cutover.
//
// 🔴 Next 16 / Turbopack: Turbopack is the DEFAULT bundler for BOTH `next dev` AND
// `next build` (verified: docs/.../08-turbopack.md "Turbopack is now the default
// bundler"). `@serwist/next` injects a *webpack* config to bundle `swSrc` — which
// Turbopack ignores. So a plain `next build` does NOT emit /sw.js, and wrapping the
// config unconditionally would only add a noisy "webpack is configured…" warning to
// every staging/prod build for no benefit while the SW is disabled.
//
// Therefore the wrap is GATED on a dedicated BUILD flag `PWA_SW_BUILD`. Default
// builds (no flag) are byte-identical to pre-PWA — zero risk to the current deploys.
// To actually ship the SW post-cutover, build that one image with BOTH
// `PWA_SW_BUILD=true` and webpack (`next build --webpack`) so /sw.js is emitted, AND
// set the runtime `NEXT_PUBLIC_PWA_SW_ENABLED=true`. The two flags are coupled:
// registering /sw.js requires a build that produced it. See PWA-PLAN.md §F3.
const withSerwist = withSerwistInit({
  // Source of the SW (compiled by Serwist) and its public output path.
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Never run the SW build in dev; aligns with the OFF default.
  disable: process.env.NODE_ENV === "development",
  // We register manually (flag-gated) — do not auto-inject a register snippet.
  register: false,
  reloadOnOnline: false,
});

// Gate the webpack-based SW build behind PWA_SW_BUILD so default (Turbopack) builds
// stay pristine. Flip on (with `next build --webpack`) only when shipping the SW.
export default process.env.PWA_SW_BUILD === "true"
  ? withSerwist(nextConfig)
  : nextConfig;
