require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  INCIDENT_REPOSITORY,
  InMemoryIncidentRepository,
} = require('@faultline/incidents');
const {
  IncidentCorrelationEngine,
  correlationResource,
} = require('../apps/processor/dist/correlation');
const {
  IncidentsController,
} = require('../apps/api/dist/incidents.controller');

const start = Date.parse('2026-09-08T12:00:00Z');
const at = (offset) => new Date(start + offset).toISOString();
let id = 0;
const resource = (pod = 'payment-api-7847d-x72a', overrides = {}) => ({
  scope: 'container',
  clusterId: 'production-01',
  namespace: 'payments',
  workload: 'payment-api-7847d',
  workloadKind: 'ReplicaSet',
  pod,
  podUid: `uid-${pod}`,
  container: 'api',
  node: 'worker-1',
  ...overrides,
});
const anomaly = (classification, offset, overrides = {}) => ({
  anomalyId: `anomaly-${++id}`,
  dedupeKey: `key-${id}`,
  ruleId: `rule.${classification.toLowerCase()}`,
  classification,
  severity: 'WARNING',
  confidence: 0.85,
  clusterId: 'production-01',
  affectedResource: resource(),
  timestamp: at(offset),
  summary: classification,
  evidence: [
    {
      type: 'telemetry',
      summary: classification,
      timestamp: at(offset),
      eventId: `event-${id}`,
    },
  ],
  status: 'OPEN',
  firstSeen: at(offset),
  lastSeen: at(offset),
  ...overrides,
});
const setup = (config = {}) => {
  const repository = new InMemoryIncidentRepository();
  const engine = new IncidentCorrelationEngine(repository, {
    correlationWindowMs: 10 * 60_000,
    stabilizationPeriodMs: 60_000,
    ...config,
  });
  return { repository, engine };
};

test('creates a workload incident and resolves Pod -> ReplicaSet -> Deployment', async () => {
  const { engine } = setup();
  assert.deepEqual(correlationResource(resource()), {
    scope: 'deployment',
    clusterId: 'production-01',
    namespace: 'payments',
    workload: 'payment-api',
    workloadKind: 'Deployment',
    workloadUid: undefined,
  });
  const change = await engine.correlate(anomaly('HIGH_MEMORY_UTILIZATION', 0));
  assert.equal(change.type, 'CREATED');
  assert.equal(change.incident.status, 'OPEN');
  assert.equal(change.incident.classification, 'MEMORY_EXHAUSTION');
  assert.equal(change.incident.confidence, 0.45);
  assert.equal(change.incident.primaryResource.scope, 'deployment');
  assert.equal(change.incident.primaryResource.workload, 'payment-api');
});

test('correlates memory evidence, deduplicates the incident, escalates severity and confidence', async () => {
  const { repository, engine } = setup();
  const high = anomaly('HIGH_MEMORY_UTILIZATION', 0);
  const opened = (await engine.correlate(high)).incident;
  const oom = anomaly('OOM_KILLED', 120_000, {
    severity: 'CRITICAL',
    affectedResource: resource('payment-api-7847d-b91c'),
    evidence: [
      {
        type: 'resource-state',
        summary: 'Container restart count increased',
        timestamp: at(120_000),
        attributes: { previous: 2, current: 3, delta: 1 },
      },
    ],
  });
  const updated = (await engine.correlate(oom)).incident;
  assert.equal(updated.id, opened.id);
  assert.equal(updated.status, 'ACTIVE');
  assert.equal(updated.severity, 'CRITICAL');
  assert.equal(updated.confidence, 0.98);
  assert.equal(updated.affectedResources.length, 2);
  assert.equal(updated.anomalies.length, 2);
  assert.equal(updated.evidence.length, 2);

  const repeated = await engine.correlate(
    anomaly('OOM_KILLED', 180_000, {
      severity: 'CRITICAL',
      affectedResource: resource('payment-api-7847d-p82d'),
    }),
  );
  assert.equal(repeated.incident.id, opened.id);
  assert.equal((await repository.listActiveIncidents()).length, 1);
  assert.equal(repeated.incident.affectedResources.length, 3);
});

test('orders the incident timeline and preserves anomaly evidence', async () => {
  const { engine } = setup();
  const later = anomaly('CRASH_LOOP', 5_000, { severity: 'HIGH' });
  const first = (await engine.correlate(later)).incident;
  const earlier = anomaly('POD_NOT_READY', 1_000, {
    affectedResource: resource('payment-api-7847d-b91c'),
  });
  const incident = (await engine.correlate(earlier)).incident;
  assert.equal(incident.id, first.id);
  assert.deepEqual(
    incident.timeline.map((entry) => entry.timestamp),
    [at(1_000), at(5_000)],
  );
  assert.deepEqual(
    incident.evidence.map((entry) => entry.eventId),
    [`event-${id}`, `event-${id - 1}`],
  );
  assert.equal(incident.classification, 'WORKLOAD_CRASHING');
  assert.equal(incident.confidence, 0.92);
});

test('multiple unavailable replicas plus deployment degradation become one critical incident', async () => {
  const { engine } = setup();
  await engine.correlate(anomaly('POD_NOT_READY', 0));
  await engine.correlate(
    anomaly('POD_NOT_READY', 100, {
      affectedResource: resource('payment-api-7847d-b91c'),
    }),
  );
  const incident = (
    await engine.correlate(
      anomaly('DEPLOYMENT_DEGRADED', 200, {
        severity: 'HIGH',
        affectedResource: resource(undefined, {
          scope: 'deployment',
          workload: 'payment-api',
          workloadKind: 'Deployment',
          pod: undefined,
          podUid: undefined,
          container: undefined,
        }),
      }),
    )
  ).incident;
  assert.equal(incident.classification, 'DEPLOYMENT_DEGRADATION');
  assert.equal(incident.severity, 'CRITICAL');
  assert.equal(incident.confidence, 0.95);
});

test('node failure correlates unavailable pods on that node', async () => {
  const { engine } = setup();
  const node = anomaly('NODE_NOT_READY', 0, {
    severity: 'CRITICAL',
    affectedResource: resource(undefined, {
      scope: 'node',
      namespace: undefined,
      workload: undefined,
      workloadKind: undefined,
      pod: undefined,
      podUid: undefined,
      container: undefined,
      node: 'worker-1',
    }),
  });
  const opened = (await engine.correlate(node)).incident;
  await engine.correlate(anomaly('POD_NOT_READY', 100));
  const updated = (
    await engine.correlate(
      anomaly('POD_NOT_READY', 200, {
        affectedResource: resource('catalog-66bd9-p82d', {
          workload: 'catalog-66bd9',
        }),
      }),
    )
  ).incident;
  assert.equal(updated.id, opened.id);
  assert.equal(updated.classification, 'NODE_FAILURE');
  assert.equal(updated.primaryResource.node, 'worker-1');
  assert.equal(updated.confidence, 0.97);
});

test('image failures correlate across replicas while unrelated resources and late signals stay separate', async () => {
  const { repository, engine } = setup({ correlationWindowMs: 1_000 });
  const first = (await engine.correlate(anomaly('IMAGE_PULL_FAILURE', 0)))
    .incident;
  const second = (
    await engine.correlate(
      anomaly('IMAGE_PULL_FAILURE', 500, {
        affectedResource: resource('payment-api-7847d-b91c'),
      }),
    )
  ).incident;
  assert.equal(second.id, first.id);
  assert.equal(second.classification, 'WORKLOAD_CONFIGURATION_FAILURE');
  assert.equal(second.confidence, 0.95);
  assert.equal(second.severity, 'WARNING');

  const unrelated = await engine.correlate(
    anomaly('IMAGE_PULL_FAILURE', 600, {
      affectedResource: resource('catalog-66bd9-a1234', {
        workload: 'catalog-66bd9',
      }),
    }),
  );
  assert.notEqual(unrelated.incident.id, first.id);
  const late = await engine.correlate(anomaly('IMAGE_PULL_FAILURE', 2_000));
  assert.notEqual(late.incident.id, first.id);
  assert.equal((await repository.listActiveIncidents()).length, 3);
});

test('requires the stabilization period and cancels resolution when an anomaly returns', async () => {
  const { repository, engine } = setup({ stabilizationPeriodMs: 1_000 });
  const active = anomaly('CRASH_LOOP', 0, { severity: 'HIGH' });
  const opened = (await engine.correlate(active)).incident;
  await engine.correlate({
    ...active,
    status: 'RESOLVED',
    timestamp: at(100),
    lastSeen: at(100),
  });
  assert.equal((await repository.getIncident(opened.id)).status, 'ACTIVE');
  assert.deepEqual(await engine.advance(at(1_099)), []);
  const resolved = await engine.advance(at(1_100));
  assert.equal(resolved[0].type, 'RESOLVED');
  assert.equal(resolved[0].incident.status, 'RESOLVED');
  assert.equal(resolved[0].incident.resolvedAt, at(1_100));

  const again = anomaly('CRASH_LOOP', 2_000, { severity: 'HIGH' });
  const next = (await engine.correlate(again)).incident;
  await engine.correlate({
    ...again,
    status: 'RESOLVED',
    timestamp: at(2_100),
    lastSeen: at(2_100),
  });
  await engine.correlate(
    anomaly('CRASH_LOOP', 2_500, { severity: 'HIGH', status: 'ACTIVE' }),
  );
  assert.equal(
    (await repository.getIncident(next.id)).stabilizationStartedAt,
    undefined,
  );
  assert.deepEqual(await engine.advance(at(4_000)), []);
});

test('incident API lists, filters and retrieves repository incidents', async () => {
  const { repository, engine } = setup();
  const incident = (
    await engine.correlate(anomaly('OOM_KILLED', 0, { severity: 'CRITICAL' }))
  ).incident;
  class IncidentApiModule {}
  Module({
    controllers: [IncidentsController],
    providers: [{ provide: INCIDENT_REPOSITORY, useValue: repository }],
  })(IncidentApiModule);
  const app = await NestFactory.create(IncidentApiModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const list = await fetch(
      `${base}/incidents?cluster=production-01&namespace=payments&status=open&severity=critical&classification=memory_exhaustion`,
    );
    assert.equal(list.status, 200);
    assert.deepEqual(
      (await list.json()).map((item) => item.id),
      [incident.id],
    );
    const detail = await fetch(`${base}/incidents/${incident.id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).classification, 'MEMORY_EXHAUSTION');
    assert.equal((await fetch(`${base}/incidents/missing`)).status, 404);
    assert.equal((await fetch(`${base}/incidents?status=invalid`)).status, 400);
  } finally {
    await app.close();
  }
});
