import { NestFactory }           from '@nestjs/core';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { ConfigService }          from '@nestjs/config';
import helmet                     from 'helmet';
import { AppModule }              from './app.module';

// Money is stored as BigInt paise. JSON.stringify throws on BigInt by default;
// serialise to Number (paise « Number.MAX_SAFE_INTEGER, so lossless) for all
// API responses. This must be set before the app boots so that NestJS's
// built-in JSON serialiser picks it up.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app    = await NestFactory.create(AppModule);

  // URI versioning — all feature controllers serve under /v1 (default version).
  // AppController (/, /health) is VERSION_NEUTRAL so liveness probes stay unversioned.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const config = app.get(ConfigService);

  // ── Security headers (Helmet) ────────────────────────────────────────────
  // Sets X-Frame-Options, X-Content-Type-Options, HSTS, etc.
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────
  // Allow the configured frontend origin(s). Set CORS_ORIGINS in .env.
  // Multiple origins can be comma-separated, e.g.:
  //   CORS_ORIGINS=https://platform.gifsy.com,https://admin.gifsy.com
  // Falls back to localhost:3000 for local development.
  const rawOrigins = config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());
  app.enableCors({
    origin:      allowedOrigins,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // ── Global validation pipe ───────────────────────────────────────────────
  // Enforces all class-validator decorators on DTOs.
  // whitelist:true strips unknown fields before they reach the handler.
  // forbidNonWhitelisted:true returns 400 instead of silently stripping.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:              true,
      forbidNonWhitelisted:   true,
      transform:              true,
      transformOptions:       { enableImplicitConversion: true },
    }),
  );

  // GLB-2 boot check — POINTS_CONVERSION_RATE must be a finite positive number.
  // RewardsService uses this rate to convert points → paise for cash redemptions;
  // a zero or non-numeric rate silently produces zero-value PayoutTransactions
  // (GLB-2). Fail fast before the app accepts any traffic.
  // Default matches RewardsService: '1' when the env var is absent.
  const conversionRateRaw = process.env.POINTS_CONVERSION_RATE ?? '1';
  const conversionRate = parseFloat(conversionRateRaw);
  if (!isFinite(conversionRate) || conversionRate <= 0) {
    logger.error(
      `FATAL: POINTS_CONVERSION_RATE="${conversionRateRaw}" is not a finite positive number. ` +
        `Set a valid value (e.g. "1" for 1 point = ₹1) and restart the service.`,
    );
    process.exit(1);
  }

  const port = config.get<number>('PORT') ?? 4000;
  await app.listen(port);
  logger.log(`API listening on port ${port}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ')}`);
}

bootstrap();
