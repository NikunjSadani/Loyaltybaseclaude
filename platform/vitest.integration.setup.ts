/// <reference types="vitest/globals" />
// Load environment variables from .env (DATABASE_URL, etc.) so the prisma singleton
// connects to the real dev DB. Must run before any test imports `@/lib/prisma`.
import 'dotenv/config';
