import { z } from 'zod';
import { metricEventSchema, type MetricEvent } from './index';
import { metricNames } from './metrics';

// Collector strips spec and managedFields before export. This boundary retains
// only the selected state fields; complete Kubernetes objects never enter the queue.
const metadata = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1),
  uid: z.string().min(1),
});
const condition = z.object({
  type: z.string(),
  status: z.enum(['True', 'False', 'Unknown']),
});
const terminated = z.object({
  reason: z.string().optional(),
  exitCode: z.number().int().optional(),
});
const state = z.object({
  running: z.object({}).optional(),
  waiting: z.object({ reason: z.string().optional() }).optional(),
  terminated: terminated.optional(),
});
const pod = z.object({
  kind: z.literal('Pod'),
  metadata,
  status: z
    .object({
      conditions: z.array(condition).default([]),
      containerStatuses: z
        .array(
          z.object({
            name: z.string().min(1),
            state,
            lastState: z
              .object({ terminated: terminated.optional() })
              .optional(),
          }),
        )
        .default([]),
    })
    .default({ conditions: [], containerStatuses: [] }),
});
const deployment = z.object({
  kind: z.literal('Deployment'),
  metadata,
  status: z
    .object({ unavailableReplicas: z.number().int().nonnegative().optional() })
    .default({}),
});
const snapshotSchema = z.discriminatedUnion('kind', [pod, deployment]);

export function normalizeWorkloadSnapshot(
  input: unknown,
  common: { clusterId: string; timestamp: string; ingestedAt: string },
  nextId: () => string,
): MetricEvent[] {
  const snapshot = snapshotSchema.parse(input);
  const base = {
    ...common,
    namespace: snapshot.metadata.namespace,
    kind: 'metric',
    metricType: 'gauge',
    raw: null,
  };
  const emit = (
    name: string,
    value: number,
    extra: Record<string, unknown>,
  ): MetricEvent =>
    metricEventSchema.parse({
      ...base,
      id: nextId(),
      name,
      value,
      unit: '1',
      category: 'state',
      ...extra,
    });
  if (snapshot.kind === 'Deployment') {
    return [
      emit(
        metricNames.deploymentUnavailable,
        snapshot.status.unavailableReplicas ?? 0,
        {
          workload: snapshot.metadata.name,
          attributes: { 'k8s.deployment.uid': snapshot.metadata.uid },
        },
      ),
    ];
  }
  const attrs = { 'k8s.pod.uid': snapshot.metadata.uid };
  const ready = snapshot.status.conditions.find(
    (item) => item.type === 'Ready',
  );
  const events = [
    emit(
      metricNames.podReady,
      ready?.status === 'True' ? 1 : ready?.status === 'False' ? 0 : -1,
      {
        pod: snapshot.metadata.name,
        attributes: attrs,
      },
    ),
  ];
  for (const container of snapshot.status.containerStatuses) {
    const current = container.state;
    const active = Object.keys(current);
    if (active.length > 1) throw new Error('Ambiguous container state');
    const label = current.running
      ? 'running'
      : current.waiting
        ? 'waiting'
        : current.terminated
          ? 'terminated'
          : 'unknown';
    events.push(
      emit(metricNames.containerState, 1, {
        pod: snapshot.metadata.name,
        container: container.name,
        attributes: {
          ...attrs,
          state: label,
          reason: current.waiting?.reason ?? current.terminated?.reason ?? null,
          lastTerminationReason:
            container.lastState?.terminated?.reason ?? null,
          lastExitCode: container.lastState?.terminated?.exitCode ?? null,
        },
      }),
    );
  }
  return events;
}
