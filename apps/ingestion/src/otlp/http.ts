import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Explicit decompressed request bound for Collector batches, applied before Nest's default parser. */
export function configureIngestionHttp(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
}
