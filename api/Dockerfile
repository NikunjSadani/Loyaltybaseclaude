# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN ./node_modules/.bin/tsc -p tsconfig.build.json
RUN ls dist/main.js
# Compile the DB seed to JS so it runs in the prod image (which omits ts-node).
# seed.ts → prisma/seed-gifsy-roles.ts imports `../src/common/rbac/gifsy-seed-roles`
# (the canonical RBAC role defs — kept in src/ so the app owns them, DRY). The prod
# runner copies dist/ only, never src/, so an in-place `prisma/seed.js` would throw
# MODULE_NOT_FOUND on that `../src/...` require at runtime. Fix: compile the whole
# reachable graph into a SELF-CONTAINED dist-seed/ (rootDir . so prisma/ AND src/
# both land under it), then run it via a Cloud Run Job:
#   command=node  args=dist-seed/prisma/seed.js
RUN ./node_modules/.bin/tsc prisma/seed.ts --rootDir . --outDir dist-seed \
      --module commonjs --target es2021 --esModuleInterop --skipLibCheck --moduleResolution node
RUN ls dist-seed/prisma/seed.js dist-seed/src/common/rbac/gifsy-seed-roles.js
# Compile the one-time prod bootstrap (first GIFSY_ADMIN + OutletType master rows)
# the same way, so it ships in the prod image; run via a Cloud Run Job:
# `node prisma/bootstrap.js` with BOOTSTRAP_CONFIRM=<db> (see CUTOVER-RUNBOOK).
RUN ./node_modules/.bin/tsc prisma/bootstrap.ts --module commonjs --target es2021 \
      --esModuleInterop --skipLibCheck --moduleResolution node
RUN ls prisma/bootstrap.js

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Only production deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built output and Prisma client
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# prisma/ ships the schema + the in-place compiled bootstrap.js (no ../src dep) for
# the prod bootstrap job (`node prisma/bootstrap.js`, see CUTOVER-RUNBOOK).
COPY --from=builder /app/prisma ./prisma
# Self-contained compiled seed bundle (seed.js + its ../src RBAC dep); the seed job
# runs `node dist-seed/prisma/seed.js`.
COPY --from=builder /app/dist-seed ./dist-seed
COPY prisma.config.ts ./

EXPOSE 4000

CMD ["node", "dist/main.js"]
