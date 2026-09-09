/**
 * URL-safe identity for a Kubernetes resource in telemetry queries.
 *
 * Deliberately separate from the processor's internal `resourceStateKey`/`correlationKey`
 * JSON encodings: those are opaque cache keys, while this one appears in HTTP paths and
 * must survive round-tripping through a URL segment.
 *
 * Format: `<scope>:<clusterId>:<namespace>:<name>[:<container>]`, each segment
 * percent-encoded so separators inside a name cannot change the parse.
 */
export const telemetryResourceScopes = [
  'container',
  'pod',
  'workload',
  'node',
  'namespace',
] as const;

export type TelemetryResourceScope = (typeof telemetryResourceScopes)[number];

export interface TelemetryResourceRef {
  scope: TelemetryResourceScope;
  clusterId: string;
  namespace?: string;
  /** Pod name, workload name, node name, or namespace name depending on `scope`. */
  name: string;
  container?: string;
}

const scopes: ReadonlySet<string> = new Set(telemetryResourceScopes);

export function encodeTelemetryResourceId(ref: TelemetryResourceRef): string {
  const segments = [
    ref.scope,
    ref.clusterId,
    ref.namespace ?? '',
    ref.name,
    ...(ref.scope === 'container' && ref.container ? [ref.container] : []),
  ];
  return segments.map(encodeURIComponent).join(':');
}

export function parseTelemetryResourceId(
  value: unknown,
): TelemetryResourceRef | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const segments = value.split(':').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return undefined;
    }
  });
  if (segments.some((segment) => segment === undefined)) return undefined;
  if (segments.length < 4 || segments.length > 5) return undefined;
  const [scope, clusterId, namespace, name, container] = segments as string[];
  if (!scopes.has(scope!) || !clusterId || !name) return undefined;
  if (scope === 'container' && !container) return undefined;
  if (scope !== 'container' && container !== undefined) return undefined;
  if ((scope === 'pod' || scope === 'container') && !namespace)
    return undefined;
  return {
    scope: scope as TelemetryResourceScope,
    clusterId,
    ...(namespace ? { namespace } : {}),
    name: name!,
    ...(container ? { container } : {}),
  };
}
