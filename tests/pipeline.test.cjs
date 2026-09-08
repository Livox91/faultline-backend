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
  const consumer = new TelemetryConsumer(queue, logger);
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
