import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import { clusterScope, type TelemetryScope } from '@faultline/telemetry';

export const TELEMETRY_SCOPE_RESOLVER = Symbol(
  'faultline.telemetry-scope-resolver',
);

/**
 * Resolves the clusters a request may read telemetry for.
 *
 * The resolver takes no request input on purpose. A cluster ID in a query string is a
 * filter, never an authorization claim: it is checked against the scope resolved here,
 * and the store applies the resolved list inside the SQL it builds. When per-user RBAC
 * arrives it replaces this implementation and nothing else, because every read path
 * already asks for a scope before touching storage.
 */
export interface TelemetryScopeResolver {
  resolve(): Promise<TelemetryScope>;
}

@Injectable()
export class ConfiguredTelemetryScopeResolver implements TelemetryScopeResolver {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  async resolve(): Promise<TelemetryScope> {
    const clusters = this.config.telemetryStorage.queryClusterScope;
    if (clusters?.length) return clusterScope(...clusters);
    if (this.config.environment === 'production')
      // Configuration validation also requires this; failing closed here is deliberate.
      throw new ServiceUnavailableException(
        'Telemetry query cluster scope is not configured',
      );
    return { mode: 'all-development-clusters' };
  }
}

/**
 * Picks the cluster a query runs against.
 *
 * A single-cluster scope does not need the caller to name it; anything else must, so
 * that a request is never silently answered from a cluster the caller did not mean.
 */
export function resolveQueryCluster(
  scope: TelemetryScope,
  requested: unknown,
): unknown {
  if (requested !== undefined && requested !== '') return requested;
  if (scope.mode === 'clusters' && scope.clusterIds.length === 1)
    return scope.clusterIds[0];
  return requested;
}
