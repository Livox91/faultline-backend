import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
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

export interface HealthDependency {
  readonly name: string;
  ping(): Promise<void>;
}

@Injectable()
export class HealthService {
  private readonly dependencies = new Map<string, HealthDependency>();
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

  register(dependency: HealthDependency): void {
    this.dependencies.set(dependency.name, dependency);
  }
  unregister(name: string): void {
    this.dependencies.delete(name);
  }
  async getReadiness(): Promise<
    HealthStatus & { dependencies?: Record<string, 'ok' | 'unavailable'> }
  > {
    if (!this.dependencies.size) return this.getStatus();
    const dependencies: Record<string, 'ok' | 'unavailable'> = {};
    await Promise.all(
      [...this.dependencies.values()].map(async (dependency) => {
        try {
          await dependency.ping();
          dependencies[dependency.name] = 'ok';
        } catch {
          dependencies[dependency.name] = 'unavailable';
        }
      }),
    );
    const status = { ...this.getStatus(), dependencies };
    if (Object.values(dependencies).includes('unavailable'))
      throw new ServiceUnavailableException({
        ...status,
        status: 'unavailable',
      });
    return status;
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
  ready() {
    return this.health.getReadiness();
  }
}
