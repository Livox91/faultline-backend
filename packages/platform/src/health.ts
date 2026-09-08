import { Controller, Get, Header, Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  type ApplicationName,
} from './config';

export interface HealthStatus {
  application: ApplicationName;
  status: 'ok';
  /** Process uptime in seconds (fractional). */
  uptime: number;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  getStatus(): HealthStatus {
    return {
      application: this.config.application,
      status: 'ok',
      uptime: process.uptime(),
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  live(): HealthStatus {
    return this.health.getStatus();
  }

  // Bootstrap readiness only; add dependency probes when adapters exist.
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  ready(): HealthStatus {
    return this.health.getStatus();
  }
}
