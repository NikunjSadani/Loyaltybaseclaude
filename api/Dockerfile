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
# Emits prisma/seed.js; run via a Cloud Run Job: `node prisma/seed.js`.
RUN ./node_modules/.bin/tsc prisma/seed.ts --module commonjs --target es2021 \
      --esModuleInterop --skipLibCheck --moduleResolution node
RUN ls prisma/seed.js

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
# From the builder so the compiled prisma/seed.js is included (for the seed job).
COPY --from=builder /app/prisma ./prisma
COPY prisma.config.ts ./

EXPOSE 4000

CMD ["node", "dist/main.js"]
