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

export interface HealthDependencyOptions {
  /**
   * Critical dependencies fail readiness; non-critical ones only degrade it.
   *
   * Telemetry history is the motivating case: the API keeps serving incidents while
   * ClickHouse is down, and the storage consumer's own health never influences the
   * processor, so detection continues while history is unavailable.
   */
  critical?: boolean;
}

export type DependencyHealth = 'ok' | 'unavailable';
export type ReadinessStatus = 'ok' | 'degraded' | 'unavailable';

export interface ReadinessReport extends Omit<HealthStatus, 'status'> {
  status: ReadinessStatus;
  dependencies?: Record<string, DependencyHealth>;
  /** Non-critical dependencies that failed their probe. */
  degraded?: readonly string[];
}

@Injectable()
export class HealthService {
  private readonly dependencies = new Map<
    string,
    { dependency: HealthDependency; critical: boolean }
  >();
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

  register(
    dependency: HealthDependency,
    options: HealthDependencyOptions = {},
  ): void {
    this.dependencies.set(dependency.name, {
      dependency,
      critical: options.critical ?? true,
    });
  }
  unregister(name: string): void {
    this.dependencies.delete(name);
  }
  async getReadiness(): Promise<ReadinessReport> {
    if (!this.dependencies.size) return this.getStatus();
    const dependencies: Record<string, DependencyHealth> = {};
    const failed: string[] = [];
    const degraded: string[] = [];
    await Promise.all(
      [...this.dependencies.values()].map(async ({ dependency, critical }) => {
        try {
          await dependency.ping();
          dependencies[dependency.name] = 'ok';
        } catch {
          dependencies[dependency.name] = 'unavailable';
          (critical ? failed : degraded).push(dependency.name);
        }
      }),
    );
    const status: ReadinessReport = {
      ...this.getStatus(),
      dependencies,
      ...(degraded.length ? { degraded, status: 'degraded' as const } : {}),
    };
    if (failed.length)
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

  // 503 only when a critical dependency fails; degraded dependencies are reported.
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  ready() {
    return this.health.getReadiness();
  }
}
