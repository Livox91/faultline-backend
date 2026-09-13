const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  ApplicationLogger,
  APPLICATION_CONFIG,
} = require('@faultline/platform');
const {
  QUEUE,
  InMemoryQueue,
  getDevelopmentQueue,
} = require('@faultline/queue');
const { normalizeLog } = require('@faultline/telemetry');
const booknestAnsiError = require('./fixtures/booknest-ansi-error.json');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  OtlpController,
} = require('../apps/ingestion/dist/otlp/otlp.controller');
const { configureIngestionHttp } = require('../apps/ingestion/dist/otlp/http');
const { translateOtlpLogs } = require('../apps/ingestion/dist/otlp/translate');
const {
  CLUSTER_AUTHENTICATOR,
  DevelopmentClusterAuthenticator,
} = require('../apps/ingestion/dist/telemetry.controller');

function value(v) {
  if (v === null) return {};
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { kvlistValue: { values: attributes(v) } };
}
function attributes(v) {
  return Object.entries(v).map(([key, v]) => ({ key, value: value(v) }));
}
const resource = {
  'faultline.cluster.id': 'cluster-1',
  'k8s.cluster.name': 'friendly-name',
  'k8s.namespace.name': 'faultline-demo',
  'k8s.pod.name': 'demo-123',
  'k8s.pod.uid': 'pod-uid',
  'k8s.container.name': 'demo',
  'container.id': 'container-id',
  'k8s.node.name': 'worker-1',
  'k8s.deployment.name': 'demo',
  'k8s.pod.label.app.kubernetes.io/name': 'demo',
};
const record = {
  timeUnixNano: '1788861600123456789',
  observedTimeUnixNano: '1788861601123456789',
  body: value('original message  '),
  attributes: attributes({ 'log.iostream': 'stderr' }),
  severityNumber: 17,
  severityText: 'ERROR',
};
function batch(records = [record], attrs = resource, scope = 'filelog') {
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes(attrs) },
        scopeLogs: [
          { scope: { name: scope, version: '0.147.0' }, logRecords: records },
        ],
      },
    ],
  };
}
const kubeEvent = {
  apiVersion: 'v1',
  kind: 'Event',
  metadata: {
    name: 'demo.1',
    namespace: 'faultline-demo',
    uid: 'event-uid',
    creationTimestamp: '2026-09-08T10:00:00Z',
  },
  involvedObject: {
    apiVersion: 'v1',
    kind: 'Pod',
    name: 'demo-123',
    namespace: 'faultline-demo',
    uid: 'pod-uid',
  },
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container',
  count: 2,
  lastTimestamp: '2026-09-08T10:01:00Z',
  source: { host: 'worker-1' },
};
function eventBatch(event = kubeEvent) {
  return batch(
    [
      {
        observedTimeUnixNano: record.observedTimeUnixNano,
        body: value({ type: 'ADDED', object: event }),
      },
    ],
    {
      'faultline.cluster.id': 'cluster-1',
      'faultline.source': 'kubernetes-events',
    },
    'github.com/open-telemetry/opentelemetry-collector-contrib/receiver/k8sobjectsreceiver',
  );
}

test('OTLP log normalization preserves nanoseconds, raw message and enriched context', () => {
  const {
    events: [event],
    rejected,
  } = translateOtlpLogs(batch(), 'cluster-1');
  assert.equal(rejected, 0);
  assert.equal(event.timestamp, '2026-09-08T10:00:00.123456789Z');
  assert.equal(event.message, 'original message  ');
  assert.equal(event.raw, event.message);
  assert.equal(event.clusterId, 'cluster-1');
  for (const [field, expected] of Object.entries({
    namespace: 'faultline-demo',
    pod: 'demo-123',
    container: 'demo',
    node: 'worker-1',
    workload: 'demo',
    service: 'demo',
    level: 'error',
    stream: 'stderr',
  }))
    assert.equal(event[field], expected);
  assert.equal(event.attributes['k8s.pod.uid'], 'pod-uid');
  assert.equal(event.attributes['container.id'], 'container-id');
  const minimal = translateOtlpLogs(
    batch(
      [{ ...record, severityNumber: 0, severityText: '', attributes: [] }],
      {},
    ),
    'cluster-1',
  ).events[0];
  assert.equal(minimal.pod, undefined);
  assert.equal(minimal.level, 'unknown');
});

test('severity precedence uses OTLP text before number, structure and message', () => {
  const normalized = normalizeLog({
    severityText: 'ERROR',
    severityNumber: 9,
    body: { level: 'warn', msg: 'INFO application started' },
    stream: 'stderr',
  });
  assert.deepEqual(normalized, {
    level: 'error',
    severitySource: 'OTLP_TEXT',
    message: 'INFO application started',
  });
});

test('unspecified OTLP severity falls back to the ANSI-cleaned NestJS message', () => {
  const normalized = normalizeLog({
    severityText: booknestAnsiError.attributes['otel.severity_text'],
    severityNumber: Number(
      booknestAnsiError.attributes['otel.severity_number'],
    ),
    body: booknestAnsiError.rawPayload,
    stream: booknestAnsiError.stream,
  });
  const result = {
    ...booknestAnsiError,
    severity: normalized.level,
    severitySource: normalized.severitySource,
    message: normalized.message,
  };
  assert.equal(result.eventId, '25377cb0-5d49-40a4-94c3-b96d0694a6ac');
  assert.equal(result.clusterId, 'booknest-app');
  assert.equal(result.namespace, 'default');
  assert.equal(result.workload, 'booknest-backend');
  assert.equal(result.pod, 'booknest-backend-bd687684d-rzjvf');
  assert.equal(result.container, 'backend');
  assert.equal(result.node, 'booknest-app-control-plane');
  assert.equal(result.stream, 'stderr');
  assert.equal(result.severity, 'error');
  assert.notEqual(result.severity, 'unknown');
  assert.equal(result.severitySource, 'MESSAGE_PARSE');
  assert.equal(
    result.message,
    '[Nest] 1 - 09/11/2026, 9:04:28 PM ERROR [TypeOrmModule] Unable to connect to the database. Retrying (1)...',
  );
  assert.doesNotMatch(result.message, /\u001b|\x1b/);
  assert.match(result.rawPayload, /\u001b\[31m/);
});

test('the supplied BookNest log reaches the processor classifier with clean text and corrected severity', async () => {
  const attrs = booknestAnsiError.attributes;
  const resourceAttributes = Object.fromEntries(
    [
      'faultline.cluster.id',
      'k8s.namespace.name',
      'k8s.pod.name',
      'k8s.pod.uid',
      'k8s.container.name',
      'container.id',
      'k8s.node.name',
      'k8s.deployment.name',
      'k8s.replicaset.name',
    ].map((key) => [key, attrs[key]]),
  );
  const event = translateOtlpLogs(
    batch(
      [
        {
          timeUnixNano: attrs['otel.time_unix_nano'],
          observedTimeUnixNano: attrs['otel.observed_time_unix_nano'],
          severityNumber: 0,
          severityText: '',
          attributes: attributes({ 'log.iostream': 'stderr' }),
          body: value(booknestAnsiError.rawPayload),
        },
      ],
      resourceAttributes,
    ),
    booknestAnsiError.clusterId,
  ).events[0];
  assert.equal(event.clusterId, booknestAnsiError.clusterId);
  assert.equal(event.namespace, booknestAnsiError.namespace);
  assert.equal(event.workload, booknestAnsiError.workload);
  assert.equal(event.pod, booknestAnsiError.pod);
  assert.equal(event.container, booknestAnsiError.container);
  assert.equal(event.node, booknestAnsiError.node);
  assert.equal(event.stream, booknestAnsiError.stream);
  assert.equal(event.level, 'error');
  assert.equal(event.attributes['faultline.severity.source'], 'MESSAGE_PARSE');
  assert.doesNotMatch(event.message, /\u001b|\x1b/);
  assert.equal(event.raw, booknestAnsiError.rawPayload);

  let classifiedEvent;
  const queue = new InMemoryQueue();
  const logger = { log() {}, warn() {}, error() {}, debug() {}, verbose() {} };
  const consumer = new TelemetryConsumer(
    queue,
    logger,
    new InMemoryResourceState(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      classify: async (received) => {
        classifiedEvent = received;
        return {
          result: {
            eventId: received.id,
            classification: 'UNKNOWN',
            confidence: 0,
            classifierType: 'UNKNOWN',
            modelVersion: 'normalization-regression',
            timestamp: received.timestamp,
            patternId: 'normalization-regression',
            evidence: [],
          },
          aggregate: { count: 1, affectedPods: [received.pod] },
        };
      },
    },
  );
  await consumer.process({ id: event.id, payload: event });
  assert.equal(classifiedEvent.level, 'error');
  assert.equal(classifiedEvent.message, event.message);
  await queue.close();
});

test('structured etcd JSON extracts its message and warn severity without changing raw', () => {
  const body = {
    level: 'warn',
    ts: '2026-09-11T21:03:20.786926Z',
    caller: 'txn/util.go:93',
    msg: 'apply request took too long',
    took: '128.883708ms',
  };
  const event = translateOtlpLogs(
    batch([
      { ...record, severityNumber: 0, severityText: '', body: value(body) },
    ]),
    'cluster-1',
  ).events[0];
  assert.equal(event.level, 'warn');
  assert.equal(event.message, 'apply request took too long');
  assert.equal(
    event.attributes['faultline.severity.source'],
    'STRUCTURED_BODY',
  );
  assert.deepEqual(event.raw, body);
});

test('severity number, message tokens, fatal aliases and stream fallback are consistent', () => {
  for (const [severityNumber, expected] of [
    [1, 'trace'],
    [4, 'trace'],
    [5, 'debug'],
    [8, 'debug'],
    [9, 'info'],
    [12, 'info'],
    [13, 'warn'],
    [16, 'warn'],
    [17, 'error'],
    [20, 'error'],
    [21, 'fatal'],
    [24, 'fatal'],
  ])
    assert.equal(
      normalizeLog({ severityNumber, body: 'message' }).level,
      expected,
    );
  for (const field of ['level', 'severity', 'severityText', 'logLevel', 'lvl'])
    assert.equal(
      normalizeLog({ body: { [field]: 'warning', msg: 'slow' } }).level,
      'warn',
    );
  assert.equal(normalizeLog({ body: 'CRITICAL failure' }).level, 'fatal');
  assert.equal(
    normalizeLog({ severityText: 'fatal', body: 'ok' }).level,
    'fatal',
  );
  assert.equal(
    normalizeLog({ severityText: 'err', body: 'ok' }).level,
    'error',
  );
  assert.equal(normalizeLog({ body: 'terror is a noun' }).level, 'unknown');
  assert.deepEqual(normalizeLog({ body: 'plain output', stream: 'stdout' }), {
    level: 'unknown',
    severitySource: 'UNKNOWN',
    message: 'plain output',
  });
  assert.deepEqual(normalizeLog({ body: 'plain output', stream: 'stderr' }), {
    level: 'unknown',
    severitySource: 'STREAM_HINT',
    message: 'plain output',
  });
  assert.equal(
    normalizeLog({ body: '[Nest] Application successfully started' }).level,
    'unknown',
  );
});

test('Kubernetes watch records normalize core/v1 and events.k8s.io bodies without losing occurrence time', () => {
  for (const reason of [
    'BackOff',
    'FailedScheduling',
    'FailedMount',
    'Unhealthy',
    'Evicted',
    'Pulling',
    'Started',
    'Failed',
  ]) {
    const event = translateOtlpLogs(
      eventBatch({ ...kubeEvent, reason }),
      'cluster-1',
    ).events[0];
    assert.equal(event.kind, 'kubernetes');
    assert.equal(event.reason, reason);
    assert.equal(event.timestamp, kubeEvent.lastTimestamp);
    assert.equal(event.involvedObject.clusterId, 'cluster-1');
    assert.equal(event.pod, 'demo-123');
    assert.equal(event.node, 'worker-1');
    assert.equal(event.count, 2);
    assert.deepEqual(event.raw.object, { ...kubeEvent, reason });
  }
  const modern = {
    kind: 'Event',
    apiVersion: 'events.k8s.io/v1',
    metadata: kubeEvent.metadata,
    regarding: kubeEvent.involvedObject,
    type: 'Normal',
    reason: 'Started',
    note: 'Started container demo',
    eventTime: '2026-09-08T10:00:30.123456Z',
    series: { count: 3, lastObservedTime: '2026-09-08T10:00:40Z' },
  };
  const event = translateOtlpLogs(eventBatch(modern), 'cluster-1').events[0];
  assert.equal(event.message, modern.note);
  assert.equal(event.count, 3);
  assert.equal(event.timestamp, modern.series.lastObservedTime);
});

test('OTLP rejects invalid records independently, mismatched cluster identity and oversized batches', () => {
  const invalid = [
    { ...record, timeUnixNano: 'bad' },
    { ...record, severityNumber: 25 },
    { ...record, body: { stringValue: 'a', intValue: '1' } },
    { ...record, attributes: attributes({ 'log.iostream': 'invalid' }) },
    { ...record, timeUnixNano: '18446744073709551616' },
    { ...record, timeUnixNano: '0', observedTimeUnixNano: '0' },
  ];
  const result = translateOtlpLogs(batch([record, ...invalid]), 'cluster-1');
  assert.equal(result.events.length, 1);
  assert.equal(result.rejected, invalid.length);
  assert.equal(translateOtlpLogs(batch(), 'wrong-cluster').rejected, 1);
  assert.equal(
    translateOtlpLogs(
      batch([record], { ...resource, 'k8s.namespace.name': 42 }),
      'cluster-1',
    ).rejected,
    1,
  );
  assert.equal(
    translateOtlpLogs(
      batch([{ ...record, observedTimeUnixNano: 'bad' }]),
      'cluster-1',
    ).rejected,
    1,
  );
  assert.equal(
    translateOtlpLogs(eventBatch({ ...kubeEvent, count: -1 }), 'cluster-1')
      .rejected,
    1,
  );
  assert.throws(
    () => translateOtlpLogs(batch(Array(257).fill(record)), 'cluster-1'),
    /256/,
  );
  assert.throws(() => translateOtlpLogs({ resourceLogs: {} }, 'cluster-1'));
  assert.deepEqual(translateOtlpLogs({}, 'cluster-1'), {
    events: [],
    rejected: 0,
  });
});

test('OTLP structured bodies and attributes preserve JSON values and large integers', () => {
  const body = {
    message: 'structured log',
    nested: { ok: true, values: [1, 2.5, null] },
  };
  const structured = {
    ...record,
    body: value(body),
    attributes: [
      { key: 'large', value: { intValue: '9223372036854775807' } },
      { key: 'bytes', value: { bytesValue: 'YWJj' } },
    ],
  };
  const event = translateOtlpLogs(batch([structured]), 'cluster-1').events[0];
  assert.deepEqual(event.raw, body);
  assert.deepEqual(JSON.parse(event.message), body);
  assert.equal(event.attributes.large, '9223372036854775807');
  assert.equal(event.attributes.bytes, 'YWJj');
});

test('gzip OTLP HTTP batch reaches the real processor and responds using OTLP semantics', async () => {
  const logs = [],
    processed = [];
  const logger = {
    log: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  const queue = new InMemoryQueue();
  const consumer = new TelemetryConsumer(
    queue,
    logger,
    new InMemoryResourceState(),
  );
  const original = consumer.process.bind(consumer);
  consumer.process = async (message) => {
    const event = await original(message);
    processed.push(event);
    return event;
  };
  await consumer.onModuleInit();
  class TestModule {}
  Module({
    controllers: [OtlpController],
    providers: [
      { provide: QUEUE, useValue: queue },
      { provide: ApplicationLogger, useValue: logger },
      {
        provide: APPLICATION_CONFIG,
        useValue: {
          environment: 'test',
          developmentAgentToken: 'private-token',
        },
      },
      {
        provide: CLUSTER_AUTHENTICATOR,
        useClass: DevelopmentClusterAuthenticator,
      },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  configureIngestionHttp(app);
  try {
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/v1/otlp/logs`;
    const headers = {
      'content-type': 'application/json',
      'x-faultline-cluster-id': 'cluster-1',
      'x-faultline-agent-token': 'private-token',
    };
    const post = (payload, custom = {}, gzip = false) =>
      fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          ...custom,
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
        body: gzip
          ? gzipSync(JSON.stringify(payload))
          : JSON.stringify(payload),
      });
    assert.equal(
      (await post(batch(), { 'x-faultline-cluster-id': '' })).status,
      400,
    );
    assert.equal(
      (await post(batch(), { 'x-faultline-agent-token': 'bad' })).status,
      401,
    );
    assert.equal(
      (await post(batch(), { 'content-type': 'application/x-protobuf' }))
        .status,
      415,
    );
    assert.equal((await post({ resourceLogs: 'bad' })).status, 400);
    assert.equal((await post(batch(Array(257).fill(record)))).status, 400);
    assert.equal(
      (
        await post(
          batch([{ ...record, body: value('a'.repeat(2100000)) }]),
          {},
          true,
        )
      ).status,
      413,
    );
    const response = await post(
      { resourceLogs: [...batch().resourceLogs, ...eventBatch().resourceLogs] },
      {},
      true,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    await new Promise(setImmediate);
    assert.equal(processed.length, 2);
    assert.equal(processed[0].message, record.body.stringValue);
    assert.equal(processed[1].reason, 'BackOff');
    const partial = await post(
      batch([record, { ...record, timeUnixNano: 'invalid' }]),
    );
    assert.equal(partial.status, 200);
    assert.equal((await partial.json()).partialSuccess.rejectedLogRecords, '1');
    await consumer.onModuleDestroy();
    assert.equal((await post(batch())).status, 503);
    assert.ok(!JSON.stringify(logs).includes('private-token'));
    assert.ok(!JSON.stringify(logs).includes('original message'));
    assert.ok(
      logs.some(
        (entry) =>
          entry.event === 'telemetry_processed' &&
          entry.pod === 'demo-123' &&
          entry.stream === 'stderr',
      ),
    );
  } finally {
    await app.close();
    await consumer.onModuleDestroy();
    await queue.close();
  }
});
