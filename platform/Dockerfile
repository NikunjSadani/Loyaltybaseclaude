# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .

# Build args injected at build time (not secrets — public env only)
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# PWA enable flags (default empty = OFF; only staging sets them =true for now).
# /sw.js is ALWAYS emitted by `build:sw` but is INERT unless SW_ENABLED registers it.
ARG NEXT_PUBLIC_PWA_SW_ENABLED
ENV NEXT_PUBLIC_PWA_SW_ENABLED=$NEXT_PUBLIC_PWA_SW_ENABLED
ARG NEXT_PUBLIC_PWA_INSTALL_ENABLED
ENV NEXT_PUBLIC_PWA_INSTALL_ENABLED=$NEXT_PUBLIC_PWA_INSTALL_ENABLED
ARG NEXT_PUBLIC_PWA_PUSH_ENABLED
ENV NEXT_PUBLIC_PWA_PUSH_ENABLED=$NEXT_PUBLIC_PWA_PUSH_ENABLED

# D2 (#31): platform Prisma retired — the FE is a pure proxy to the backend. No `prisma generate`.
# `npm run build` first emits /sw.js (esbuild, ~100ms) then runs `next build`.
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
