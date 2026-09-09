/**
 * Telemetry retention.
 *
 * Retention is configuration, never a compiled-in constant: a laptop keeps a day of
 * telemetry while a production cluster may need weeks of Kubernetes events. Adapters
 * translate this into a native mechanism (ClickHouse TTL) rather than running delete
 * jobs of their own.
 *
 * Tradeoff, per signal:
 *
 * - Longer retention buys post-hoc diagnosis of older incidents.
 * - It costs storage roughly linearly: logs dominate volume, metrics are mid-sized and
 *   highly compressible, Kubernetes events are tiny.
 * - It costs query performance only indirectly. Queries are partitioned by day and
 *   ordered by cluster/namespace/workload, so a bounded window reads a bounded number
 *   of partitions no matter how much history exists. What does grow is background merge
 *   work, part count and the cost of an accidentally wide scan, which is why the query
 *   layer enforces a maximum time range.
 *
 * The defaults keep the shortest retention on the highest-volume signal and the longest
 * on the cheapest one: logs are the bulk of the bytes, while Kubernetes events are the
 * most useful long-lived record of what the control plane did.
 */
export interface TelemetryRetentionConfig {
  logsDays: number;
  metricsDays: number;
  kubernetesEventsDays: number;
}

export const defaultRetentionConfig: TelemetryRetentionConfig = {
  logsDays: 7,
  metricsDays: 14,
  kubernetesEventsDays: 30,
};

export function validateRetentionConfig(
  config: TelemetryRetentionConfig,
): TelemetryRetentionConfig {
  for (const [key, value] of Object.entries(config))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid telemetry retention setting: ${key}`);
  return config;
}
