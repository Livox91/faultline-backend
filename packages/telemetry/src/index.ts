import { z } from 'zod';

const identifier = z.string().trim().min(1);
export const timestampSchema = z.iso.datetime({ offset: true });

/** JSON values keep contracts portable across future HTTP, queue and storage adapters. */
export const telemetryMetadataSchema = z.object({
  id: identifier,
  timestamp: timestampSchema,
  ingestedAt: timestampSchema.optional(),
  processedAt: timestampSchema.optional(),
  clusterId: identifier,
  // Optional because cluster/node events do not necessarily belong to a pod.
  namespace: identifier.optional(),
  pod: identifier.optional(),
  container: identifier.optional(),
  node: identifier.optional(),
  service: identifier.optional(),
  workload: identifier.optional(),
  attributes: z.record(z.string(), z.json()).default({}),
  // Required; use null when no original payload is available.
  raw: z.json(),
});

export type TelemetryMetadata = z.infer<typeof telemetryMetadataSchema>;

export const logEventSchema = telemetryMetadataSchema.extend({
  kind: z.literal('log'),
  level: z.enum([
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
    'unknown',
  ]),
  message: z.string(),
  stream: z.enum(['stdout', 'stderr']).optional(),
});

export const metricEventSchema = telemetryMetadataSchema.extend({
  kind: z.literal('metric'),
  name: identifier,
  value: z.number().finite(),
  unit: identifier.optional(),
  metricType: z.enum(['gauge', 'counter']),
});

export const kubernetesEventSchema = telemetryMetadataSchema
  .extend({
    kind: z.literal('kubernetes'),
    type: z.enum(['Normal', 'Warning']),
    reason: identifier,
    message: z.string(),
    involvedObject: z.object({
      clusterId: identifier,
      apiVersion: identifier,
      kind: identifier,
      name: identifier,
      namespace: identifier.optional(),
      uid: identifier.optional(),
    }),
    count: z.number().int().positive().optional(),
  })
  .refine((event) => event.clusterId === event.involvedObject.clusterId, {
    message: 'involvedObject must belong to the event cluster',
    path: ['involvedObject', 'clusterId'],
  });

export const telemetryEventSchema = z.discriminatedUnion('kind', [
  logEventSchema,
  metricEventSchema,
  kubernetesEventSchema,
]);

// Types are inferred from their validators to avoid runtime/type drift.
export type LogEvent = z.infer<typeof logEventSchema>;
export type MetricEvent = z.infer<typeof metricEventSchema>;
export type KubernetesEvent = z.infer<typeof kubernetesEventSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/** @deprecated Compatibility envelope from the initial scaffold. Use TelemetryEvent for new code. */
export const telemetryEnvelopeSchema = z
  .object({
    id: identifier,
    clusterId: identifier,
    observedAt: timestampSchema,
    kind: identifier,
    payload: z.unknown(),
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value, 'payload'), {
    message: 'payload is required',
    path: ['payload'],
  });

/** @deprecated Use TelemetryEvent. */
export type TelemetryEnvelope = z.infer<typeof telemetryEnvelopeSchema>;

/** Ingestion owns pipeline timestamps; clients cannot supply them. */
export const telemetryRequestSchemas = {
  log: logEventSchema
    .omit({ id: true, clusterId: true, ingestedAt: true, processedAt: true })
    .extend({
      id: identifier.optional(),
      clusterId: identifier.optional(),
      kind: z.literal('log').optional(),
      raw: z.json().default(null),
    })
    .strict(),
  metric: metricEventSchema
    .omit({ id: true, clusterId: true, ingestedAt: true, processedAt: true })
    .extend({
      id: identifier.optional(),
      clusterId: identifier.optional(),
      kind: z.literal('metric').optional(),
      raw: z.json().default(null),
      metricType: z.enum(['gauge', 'counter']).default('gauge'),
    })
    .strict(),
  kubernetes: z
    .object(kubernetesEventSchema.shape)
    .omit({ id: true, clusterId: true, ingestedAt: true, processedAt: true })
    .extend({
      id: identifier.optional(),
      clusterId: identifier.optional(),
      kind: z.literal('kubernetes').optional(),
      raw: z.json().default(null),
      involvedObject: kubernetesEventSchema.shape.involvedObject.extend({
        clusterId: identifier.optional(),
      }),
    })
    .strict(),
};
export const ingestedTelemetryEventSchema = telemetryEventSchema.refine(
  (event) => event.ingestedAt !== undefined,
  { message: 'ingestedAt is required', path: ['ingestedAt'] },
);
export const RAW_TELEMETRY_TOPIC = 'telemetry.raw';
