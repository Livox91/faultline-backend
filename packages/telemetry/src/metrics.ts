/** Canonical metric vocabulary shared by ingestion and processing. */
export const metricNames = {
  cpuUsage: 'k8s.container.cpu.usage',
  memoryUsage: 'k8s.container.memory.usage',
  cpuLimit: 'k8s.container.cpu.limit',
  cpuRequest: 'k8s.container.cpu.request',
  memoryLimit: 'k8s.container.memory.limit',
  memoryRequest: 'k8s.container.memory.request',
  restartCount: 'k8s.container.restart_count',
  containerReady: 'k8s.container.ready',
  containerState: 'k8s.container.state',
  podReady: 'k8s.pod.ready',
  podPhase: 'k8s.pod.phase',
  deploymentDesired: 'k8s.deployment.replicas.desired',
  deploymentAvailable: 'k8s.deployment.replicas.available',
  deploymentUnavailable: 'k8s.deployment.replicas.unavailable',
} as const;

export type MetricCategory = 'usage' | 'configuration' | 'state';
const aliases: Record<string, string> = {
  'k8s.container.cpu_limit': metricNames.cpuLimit,
  'k8s.container.cpu_request': metricNames.cpuRequest,
  'k8s.container.memory_limit': metricNames.memoryLimit,
  'k8s.container.memory_request': metricNames.memoryRequest,
  'k8s.container.restarts': metricNames.restartCount,
  'k8s.deployment.desired': metricNames.deploymentDesired,
  'k8s.deployment.available': metricNames.deploymentAvailable,
};

export function canonicalMetricName(name: string): string {
  return Object.hasOwn(aliases, name)
    ? aliases[name]!
    : name.startsWith('container.')
      ? 'k8s.' + name
      : name;
}

export function metricCategory(name: string): MetricCategory {
  if (/\.(limit|request)$/.test(name)) return 'configuration';
  if (
    /\.(ready|phase|state|restart_count|condition[^.]*|desired|available|unavailable)$/.test(
      name,
    )
  )
    return 'state';
  return 'usage';
}

/** Unit aliases only. Numeric conversions and utilization belong to the processor. */
export function canonicalMetricUnit(unit: string): string {
  if (unit === 'By' || unit === 'bytes') return 'By';
  if (unit === '{cpu}' || unit === 'core' || unit === 'cores') return 'cores';
  return unit || '1';
}
