import { NestFactory }           from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService }          from '@nestjs/config';
import helmet                     from 'helmet';
import { AppModule }              from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app    = await NestFactory.create(AppModule);

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

  const port = config.get<number>('PORT') ?? 4000;
  await app.listen(port);
  logger.log(`API listening on port ${port}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ')}`);
}

bootstrap();
