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
import {
  assignedProjectIds,
  isAdmin,
  type AuthenticatedUser,
} from '@faultline/auth';

export const TELEMETRY_SCOPE_RESOLVER = Symbol(
  'faultline.telemetry-scope-resolver',
);

/**
 * Resolves the clusters a request may read telemetry for.
 *
 * The resolver takes the authenticated user and nothing else from the request. A
 * cluster ID in a query string is a filter, never an authorization claim: it is checked
 * against the scope resolved here, and the store applies the resolved list inside the
 * SQL it builds. That is what makes editing a cluster ID in a URL pointless rather than
 * dangerous - the edited value is intersected with this scope before any storage is
 * touched, and `assertScopedCluster` refuses anything outside it.
 *
 * Two limits compose, and both must allow a cluster:
 *   - the deployment's configured scope (TELEMETRY_QUERY_CLUSTER_SCOPE), which bounds
 *     what this installation may ever read;
 *   - the caller's own reach: every project for an Admin, the assigned projects for an
 *     Onsite Engineer.
 */
export interface TelemetryScopeResolver {
  resolve(user: AuthenticatedUser): Promise<TelemetryScope>;
}

@Injectable()
export class UserTelemetryScopeResolver implements TelemetryScopeResolver {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  async resolve(user: AuthenticatedUser): Promise<TelemetryScope> {
    const deployment = this.deploymentScope();
    if (isAdmin(user)) return deployment;

    const assigned = assignedProjectIds(user);
    // An engineer with no assignments gets the empty scope, not the wide one. The
    // difference between "no restriction recorded" and "restricted to nothing" is the
    // entire check, so it is spelled out rather than left to a falsy test.
    if (deployment.mode === 'all-development-clusters')
      return clusterScope(...assigned);
    return clusterScope(
      ...assigned.filter((id) => deployment.clusterIds.includes(id)),
    );
  }

  private deploymentScope(): TelemetryScope {
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

/**
 * The cluster ids a scope permits, for the read paths that filter in SQL rather than
 * naming one cluster - incident listing, most obviously.
 *
 * `undefined` means unrestricted and is only ever returned for the development-wide
 * scope, which the configuration refuses in production.
 */
export function scopedClusterIds(
  scope: TelemetryScope,
): readonly string[] | undefined {
  return scope.mode === 'clusters' ? scope.clusterIds : undefined;
}
