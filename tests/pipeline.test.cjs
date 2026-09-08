const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { InMemoryQueue, QUEUE } = require('@faultline/queue');
const {
  ApplicationLogger,
  APPLICATION_CONFIG,
} = require('@faultline/platform');
const {
  telemetryRequestSchemas,
  RAW_TELEMETRY_TOPIC,
} = require('@faultline/telemetry');
const {
  TelemetryController,
  DevelopmentClusterAuthenticator,
  CLUSTER_AUTHENTICATOR,
} = require('../apps/ingestion/dist/telemetry.controller');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  InMemoryRuleEngine,
  createDefaultRules,
} = require('../apps/processor/dist/rules');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const {
  IncidentCorrelationEngine,
} = require('../apps/processor/dist/correlation');
const timestamp = '2026-09-08T10:00:00Z';
const log = { timestamp, level: 'info', message: 'hello', stream: 'stdout' };
const headers = {
  'content-type': 'application/json',
  'x-faultline-cluster-id': 'development-cluster',
  'x-faultline-agent-token': 'test-secret',
};

test('runtime request validation rejects malformed fields and pipeline metadata', () => {
  for (const patch of [
    { timestamp: 'bad' },
    { clusterId: '' },
    { namespace: '' },
    { pod: 3 },
    { container: '' },
    { node: '' },
    { service: '' },
    { workload: '' },
    { attributes: [] },
    { stream: 'invalid' },
    { level: 'invalid' },
    { kind: 'trace' },
    { ingestedAt: timestamp },
    { processedAt: timestamp },
  ])
    assert.equal(
      telemetryRequestSchemas.log.safeParse({ ...log, ...patch }).success,
      false,
    );
  for (const value of [NaN, Infinity, '3'])
    assert.equal(
      telemetryRequestSchemas.metric.safeParse({
        timestamp,
        name: 'cpu',
        value,
      }).success,
      false,
    );
  assert.equal(telemetryRequestSchemas.log.safeParse(log).success, true);
});

test('queue accepts independently of handlers, isolates payloads, drains and reports failures', async () => {
  const failures = [];
  const queue = new InMemoryQueue((topic) => failures.push(topic), 1);
  await assert.rejects(queue.publish('raw', { id: '1', payload: {} }));
  let release;
  let received;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const subscription = await queue.subscribe('raw', async (message) => {
    received = message;
    await gate;
    throw new Error('private failure');
  });
  const message = { id: '1', payload: { value: 1 } };
  await queue.publish('raw', message);
  message.payload.value = 2;
  assert.equal(received, undefined);
  await assert.rejects(queue.publish('raw', message));
  await new Promise(setImmediate);
  assert.equal(received.payload.value, 1);
  let drained = false;
  const closing = subscription.close().then(() => {
    drained = true;
  });
  await new Promise(setImmediate);
  assert.equal(drained, false);
  release();
  await closing;
  assert.deepEqual(failures, ['raw']);
  await queue.close();
  await assert.rejects(queue.subscribe('raw', async () => {}));
  await assert.rejects(queue.publish('raw', message));
});

test('HTTP ingestion reaches processor for all variants and handles authentication, validation and queue failure', async () => {
  const results = [];
  const logger = {
    log: (value) => results.push(value),
    warn: (value) => results.push(value),
    error: (value) => results.push(value),
  };
  const queue = new InMemoryQueue();
  const consumer = new TelemetryConsumer(
    queue,
    logger,
    new InMemoryResourceState(),
  );
  await consumer.onModuleInit();
  class TestModule {}
  Module({
    controllers: [TelemetryController],
    providers: [
      { provide: QUEUE, useValue: queue },
      { provide: ApplicationLogger, useValue: logger },
      {
        provide: APPLICATION_CONFIG,
        useValue: { environment: 'test', developmentAgentToken: 'test-secret' },
      },
      {
        provide: CLUSTER_AUTHENTICATOR,
        useClass: DevelopmentClusterAuthenticator,
      },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (route, body, customHeaders = headers) =>
      fetch(`${base}/v1/telemetry/${route}`, {
        method: 'POST',
        headers: customHeaders,
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post('logs', log, { ...headers, 'x-faultline-cluster-id': '' }))
        .status,
      400,
    );
    assert.equal(
      (
        await post('logs', log, {
          ...headers,
          'x-faultline-agent-token': 'wrong',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post('logs', log, {
          'content-type': 'application/json',
          'x-faultline-cluster-id': 'cluster',
        })
      ).status,
      401,
    );
    for (const patch of [
      { timestamp: 'bad' },
      { kind: 'unknown' },
      { clusterId: 'different' },
    ])
      assert.equal((await post('logs', { ...log, ...patch })).status, 400);
    assert.equal(
      (
        await fetch(`${base}/v1/telemetry/logs`, {
          method: 'POST',
          headers,
          body: '{',
        })
      ).status,
      400,
    );
    for (const [route, payload] of [
      ['logs', log],
      ['metrics', { timestamp, id: 'metric-1', name: 'cpu', value: 0.5 }],
      [
        'kubernetes-events',
        {
          timestamp,
          type: 'Warning',
          reason: 'BackOff',
          message: 'Restarting',
          involvedObject: { apiVersion: 'v1', kind: 'Pod', name: 'app' },
        },
      ],
    ]) {
      const response = await post(route, payload);
      assert.equal(response.status, 202, await response.clone().text());
      const acknowledgement = await response.json();
      assert.ok(acknowledgement.eventId);
      if (payload.id) assert.equal(acknowledgement.eventId, payload.id);
      await new Promise(setImmediate);
      const result = results.find(
        (value) =>
          value.event === 'telemetry_processed' &&
          value.event_id === acknowledgement.eventId,
      );
      assert.ok(result);
      assert.equal(result.timestamp, timestamp);
      assert.equal(result.ingestedAt, acknowledgement.ingestedAt);
      assert.ok(
        Date.parse(result.processedAt) >= Date.parse(result.ingestedAt),
      );
      assert.equal(result.cluster_id, 'development-cluster');
      assert.equal(result.processor, 'faultline-processor');
    }
    await queue.publish(RAW_TELEMETRY_TOPIC, {
      id: 'bad',
      payload: { kind: 'unsupported' },
    });
    await new Promise(setImmediate);
    assert.ok(
      results.some((value) => value.event === 'processor_event_rejected'),
    );
    await assert.rejects(consumer.process({ id: 'bad', payload: {} }));
    await consumer.onModuleDestroy();
    assert.equal((await post('logs', log)).status, 503);
    assert.ok(!JSON.stringify(results).includes('test-secret'));
  } finally {
    await app.close();
    await consumer.onModuleDestroy();
    await queue.close();
  }
});

test('Kubernetes memory failure flows through ingestion and correlation into one incident', async () => {
  const entries = [];
  const logger = {
    log: (value) => entries.push(value),
    warn: (value) => entries.push(value),
    error: (value) => entries.push(value),
  };
  const queue = new InMemoryQueue();
  const thresholds = {
    memoryWarningPercent: 85,
    memoryCriticalPercent: 95,
    cpuWarningPercent: 80,
    cpuCriticalPercent: 95,
    restartThreshold: 3,
    notReadyDurationMs: 0,
    deploymentDegradationDurationMs: 120_000,
  };
  const incidents = new InMemoryIncidentRepository();
  const correlator = new IncidentCorrelationEngine(incidents, {
    correlationWindowMs: 10 * 60_000,
    stabilizationPeriodMs: 60_000,
  });
  const consumer = new TelemetryConsumer(
    queue,
    logger,
    new InMemoryResourceState(),
    new InMemoryRuleEngine(createDefaultRules(), thresholds),
    correlator,
  );
  await consumer.onModuleInit();
  class AnomalyPipelineModule {}
  Module({
    controllers: [TelemetryController],
    providers: [
      { provide: QUEUE, useValue: queue },
      { provide: ApplicationLogger, useValue: logger },
      {
        provide: APPLICATION_CONFIG,
        useValue: { environment: 'test', developmentAgentToken: 'test-secret' },
      },
      {
        provide: CLUSTER_AUTHENTICATOR,
        useClass: DevelopmentClusterAuthenticator,
      },
    ],
  })(AnomalyPipelineModule);
  const app = await NestFactory.create(AnomalyPipelineModule, {
    logger: false,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const now = Date.now();
    const at = (offset) => new Date(now + offset).toISOString();
    const common = {
      namespace: 'payments',
      workload: 'payment-api',
      pod: 'payment-api-abc123',
      container: 'api',
      node: 'worker-1',
      metricType: 'gauge',
      attributes: { 'k8s.pod.uid': 'pod-uid-oom' },
    };
    const metrics = [
      {
        ...common,
        id: 'oom-limit',
        timestamp: at(0),
        name: 'k8s.container.memory.limit',
        value: 512,
        unit: 'MiB',
      },
      {
        ...common,
        id: 'oom-usage',
        timestamp: at(1),
        name: 'k8s.container.memory.usage',
        value: 500,
        unit: 'MiB',
      },
      {
        ...common,
        id: 'oom-usage-confirmed',
        timestamp: at(2),
        name: 'k8s.container.memory.usage',
        value: 500,
        unit: 'MiB',
      },
      {
        ...common,
        id: 'oom-restarts-before',
        timestamp: at(3),
        name: 'k8s.container.restart_count',
        value: 2,
        unit: '1',
      },
      {
        ...common,
        id: 'oom-restarts-after',
        timestamp: at(4),
        name: 'k8s.container.restart_count',
        value: 3,
        unit: '1',
      },
    ];
    const metricResponse = await fetch(`${base}/v1/telemetry/metrics`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: metrics }),
    });
    assert.equal(
      metricResponse.status,
      202,
      await metricResponse.clone().text(),
    );

    const eventResponse = await fetch(
      `${base}/v1/telemetry/kubernetes-events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'oom-kubernetes-event',
          timestamp: at(5),
          namespace: common.namespace,
          workload: common.workload,
          pod: common.pod,
          container: common.container,
          node: common.node,
          type: 'Warning',
          reason: 'OOMKilled',
          message: 'Container exceeded its memory limit',
          involvedObject: {
            apiVersion: 'v1',
            kind: 'Pod',
            name: common.pod,
            namespace: common.namespace,
            uid: 'pod-uid-oom',
          },
          attributes: common.attributes,
        }),
      },
    );
    assert.equal(eventResponse.status, 202, await eventResponse.clone().text());

    const readinessResponse = await fetch(`${base}/v1/telemetry/metrics`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...common,
        container: undefined,
        id: 'oom-pod-not-ready',
        timestamp: at(6),
        name: 'k8s.pod.ready',
        value: 0,
        unit: '1',
      }),
    });
    assert.equal(
      readinessResponse.status,
      202,
      await readinessResponse.clone().text(),
    );

    let detected;
    const deadline = Date.now() + 2_000;
    while (!detected && Date.now() < deadline) {
      await new Promise(setImmediate);
      detected = entries.find(
        (entry) =>
          entry.event === 'anomaly_detected' &&
          entry.classification === 'OOM_KILLED',
      );
    }
    assert.ok(detected, JSON.stringify(entries));
    assert.equal(detected.lifecycle, 'OPEN');
    assert.equal(detected.severity, 'CRITICAL');
    assert.equal(detected.cluster, 'development-cluster');
    assert.equal(detected.namespace, 'payments');
    assert.equal(detected.workload, 'payment-api');
    assert.equal(detected.pod, 'payment-api-abc123');
    assert.equal(detected.container, 'api');
    assert.ok(
      detected.evidence.some((item) =>
        item.summary.includes('Memory utilization'),
      ),
    );
    assert.ok(
      detected.evidence.some((item) =>
        item.summary.includes('restart count increased'),
      ),
    );
    let incident;
    while (!incident && Date.now() < deadline) {
      await new Promise(setImmediate);
      incident = (await incidents.listActiveIncidents()).find(
        (candidate) =>
          candidate.classification === 'MEMORY_EXHAUSTION' &&
          ['HIGH_MEMORY_UTILIZATION', 'OOM_KILLED', 'POD_NOT_READY'].every(
            (classification) =>
              candidate.anomalies.some(
                (item) => item.classification === classification,
              ),
          ),
      );
    }
    assert.ok(incident);
    assert.equal(incident.classification, 'MEMORY_EXHAUSTION');
    assert.equal(incident.primaryResource.scope, 'deployment');
    assert.equal(incident.primaryResource.workload, 'payment-api');
    assert.equal(incident.severity, 'CRITICAL');
    assert.equal(incident.confidence, 0.98);
    assert.ok(
      incident.anomalies.some(
        (item) => item.classification === 'HIGH_MEMORY_UTILIZATION',
      ),
    );
    assert.ok(
      incident.anomalies.some((item) => item.classification === 'OOM_KILLED'),
    );
    assert.ok(
      incident.anomalies.some(
        (item) => item.classification === 'POD_NOT_READY',
      ),
    );
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === 'incident_updated' &&
          entry.incident_id === incident.id &&
          entry.confidence === 0.98,
      ),
    );
  } finally {
    await app.close();
    await consumer.onModuleDestroy();
    await queue.close();
  }
});

test('development auth fails closed without configuration and processor failure rejects', async () => {
  await assert.rejects(
    new DevelopmentClusterAuthenticator({ environment: 'test' }).authenticate(
      'cluster',
      'token',
    ),
    { status: 503 },
  );
  const errors = [];
  const consumer = new TelemetryConsumer(
    {},
    {
      log() {
        throw new Error('sensitive');
      },
      error(value) {
        errors.push(value);
      },
    },
  );
  await assert.rejects(
    consumer.process({
      id: '1',
      payload: {
        ...log,
        id: '1',
        kind: 'log',
        clusterId: 'cluster',
        ingestedAt: timestamp,
        raw: null,
      },
    }),
    /Telemetry processing failed/,
  );
  assert.equal(errors[0].event, 'processor_failed');
});
