require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  PostgresConnection,
  PostgresIncidentRepository,
  applyMigrations,
} = require('@faultline/database');
const { NatsJetStreamQueue } = require('@faultline/queue');
const {
  RedisConnection,
  RedisProcessingLedger,
} = require('../apps/processor/dist/infrastructure/redis');
const {
  RedisResourceState,
} = require('../apps/processor/dist/resource-state/redis-resource-state');
const {
  InMemoryRuleEngine,
  createDefaultRules,
  RedisRuleEngine,
} = require('../apps/processor/dist/rules');

const enabled = process.env.RUN_INFRASTRUCTURE_TESTS === 'true';
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const brokerUrl = process.env.BROKER_URL;

const waitFor = async (predicate, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for infrastructure result');
};

const incident = () => {
  const id = randomUUID();
  const anomalyId = `anomaly-${id}`;
  const timestamp = new Date().toISOString();
  const resource = {
    scope: 'pod',
    clusterId: `cluster-${id}`,
    namespace: 'default',
    pod: 'api-1',
  };
  const anomaly = {
    anomalyId,
    dedupeKey: `key-${id}`,
    ruleId: 'integration',
    classification: 'POD_NOT_READY',
    severity: 'HIGH',
    confidence: 0.8,
    clusterId: resource.clusterId,
    affectedResource: resource,
    timestamp,
    summary: 'Pod is not ready',
    evidence: [
      {
        type: 'telemetry',
        summary: 'Not ready',
        timestamp,
        eventId: `event-${id}`,
      },
    ],
    status: 'OPEN',
    firstSeen: timestamp,
    lastSeen: timestamp,
  };
  return {
    id,
    correlationKey: `correlation-${id}`,
    clusterId: resource.clusterId,
    namespace: 'default',
    primaryResource: resource,
    affectedResources: [resource],
    classification: 'WORKLOAD_CRASHING',
    title: 'Workload Crashing',
    summary: 'Integration incident',
    severity: 'HIGH',
    status: 'OPEN',
    confidence: 0.8,
    firstSeen: timestamp,
    lastSeen: timestamp,
    anomalies: [anomaly],
    evidence: anomaly.evidence.map((item) => ({
      ...item,
      anomalyId,
      classification: anomaly.classification,
    })),
    timeline: [
      {
        id: `${anomalyId}:OPEN:${timestamp}`,
        timestamp,
        type: 'ANOMALY_OPENED',
        anomalyId,
        classification: anomaly.classification,
        severity: anomaly.severity,
        summary: anomaly.summary,
      },
    ],
  };
};

test(
  'durable infrastructure integration',
  {
    skip:
      !enabled || !databaseUrl || !redisUrl || !brokerUrl
        ? 'Set RUN_INFRASTRUCTURE_TESTS=true plus DATABASE_URL, REDIS_URL, and BROKER_URL'
        : false,
    timeout: 60_000,
  },
  async (t) => {
    await t.test(
      'PostgreSQL persists and reloads an idempotent incident after reconnect',
      async () => {
        let connection = new PostgresConnection(databaseUrl);
        await applyMigrations(connection.pool);
        let repository = new PostgresIncidentRepository(connection);
        const created = incident();
        assert.equal((await repository.createIncident(created)).id, created.id);
        assert.equal((await repository.createIncident(created)).id, created.id);
        await connection.disconnect();

        connection = new PostgresConnection(databaseUrl);
        repository = new PostgresIncidentRepository(connection);
        assert.deepEqual(await repository.getIncident(created.id), created);
        const updated = {
          ...created,
          status: 'ACTIVE',
          severity: 'CRITICAL',
          confidence: 0.95,
          lastSeen: new Date(Date.now() + 1).toISOString(),
        };
        await repository.updateIncident(updated);
        assert.deepEqual(await repository.getIncident(created.id), updated);
        await connection.disconnect();
        await assert.rejects(repository.getIncident(created.id));
      },
    );

    await t.test(
      'Redis reloads resource state and deduplicates message claims',
      async () => {
        let connection = new RedisConnection(redisUrl);
        await connection.connect();
        let store = new RedisResourceState(connection, 60_000);
        const timestamp = new Date().toISOString();
        const base = {
          id: randomUUID(),
          kind: 'metric',
          timestamp,
          ingestedAt: timestamp,
          clusterId: randomUUID(),
          namespace: 'default',
          pod: 'api-1',
          container: 'api',
          attributes: {},
          raw: null,
          metricType: 'gauge',
          unit: 'MiB',
        };
        await store.update({
          ...base,
          name: 'k8s.container.memory.limit',
          value: 100,
        });
        const expected = await store.update({
          ...base,
          id: randomUUID(),
          timestamp: new Date(Date.now() + 1).toISOString(),
          name: 'k8s.container.memory.usage',
          value: 90,
        });
        await connection.disconnect();
        connection = new RedisConnection(redisUrl);
        await connection.connect();
        store = new RedisResourceState(connection, 60_000);
        assert.deepEqual(
          await store.get({
            clusterId: base.clusterId,
            scope: 'container',
            namespace: 'default',
            pod: 'api-1',
            container: 'api',
          }),
          expected,
        );
        const ledger = new RedisProcessingLedger(connection, 60);
        const messageId = randomUUID();
        assert.equal(await ledger.begin(messageId), true);
        await ledger.complete(messageId);
        assert.equal(await ledger.begin(messageId), false);

        const thresholds = {
          memoryWarningPercent: 85,
          memoryCriticalPercent: 95,
          cpuWarningPercent: 80,
          cpuCriticalPercent: 95,
          restartThreshold: 3,
          notReadyDurationMs: 0,
          deploymentDegradationDurationMs: 0,
        };
        const eventId = randomUUID();
        const event = {
          id: eventId,
          kind: 'kubernetes',
          timestamp: new Date().toISOString(),
          ingestedAt: new Date().toISOString(),
          clusterId: randomUUID(),
          namespace: 'default',
          pod: 'api-1',
          container: 'api',
          attributes: {},
          raw: null,
          type: 'Warning',
          reason: 'OOMKilled',
          message: 'Killed by memory limit',
          involvedObject: {
            clusterId: '',
            apiVersion: 'v1',
            kind: 'Pod',
            name: 'api-1',
            namespace: 'default',
          },
        };
        event.involvedObject.clusterId = event.clusterId;
        const stateKey = `faultline:rules:integration:${eventId}`;
        let rules = new RedisRuleEngine(
          connection,
          new InMemoryRuleEngine(createDefaultRules(), thresholds),
          stateKey,
        );
        assert.equal((await rules.evaluate(event)).length, 1);
        await rules.commit();
        rules = new RedisRuleEngine(
          connection,
          new InMemoryRuleEngine(createDefaultRules(), thresholds),
          stateKey,
        );
        assert.deepEqual(await rules.evaluate(event), []);
        await connection.client.del(stateKey);
        await connection.disconnect();
      },
    );

    await t.test(
      'JetStream publishes, consumes, retries, dead-letters, deduplicates, and reconnects',
      async () => {
        const group = `integration-${Date.now()}`;
        const queue = await NatsJetStreamQueue.connect({
          servers: brokerUrl,
          clientId: group,
          consumerGroup: group,
          maxDeliver: 3,
          retryDelayMs: 50,
        });
        const consumed = new Map();
        const deadLetters = [];
        let dead;
        let subscription;
        try {
          dead = await queue.subscribe(
            'deadletter.telemetry.normalized',
            async (message) => {
              deadLetters.push(message);
            },
          );
          subscription = await queue.subscribe(
            'telemetry.normalized',
            async (message) => {
              const attempts = (consumed.get(message.id) ?? 0) + 1;
              consumed.set(message.id, attempts);
              if (message.payload.mode === 'retry' && attempts < 3)
                throw new Error('temporary integration failure');
              if (message.payload.mode === 'dead')
                throw new Error('permanent integration failure');
            },
          );
          const normal = randomUUID();
          await queue.publish('telemetry.normalized', {
            id: normal,
            payload: { mode: 'ok' },
          });
          await queue.publish('telemetry.normalized', {
            id: normal,
            payload: { mode: 'ok' },
          });
          await waitFor(() => consumed.get(normal) === 1);
          const retry = randomUUID();
          await queue.publish('telemetry.normalized', {
            id: retry,
            payload: { mode: 'retry' },
          });
          await waitFor(() => consumed.get(retry) === 3);
          const failed = randomUUID();
          await queue.publish('telemetry.normalized', {
            id: failed,
            payload: { mode: 'dead' },
          });
          const deadLetter = await waitFor(() =>
            deadLetters.find((item) => item.id === failed),
          );
          assert.equal(
            deadLetter.headers.originalTopic,
            'telemetry.normalized',
          );
          assert.match(deadLetter.headers.failureReason, /permanent/);
          await queue.reconnect();
          const afterReconnect = randomUUID();
          await queue.publish('telemetry.normalized', {
            id: afterReconnect,
            payload: { mode: 'ok' },
          });
          await waitFor(() => consumed.get(afterReconnect) === 1);
        } finally {
          await subscription?.close();
          await dead?.close();
          await queue.close();
        }
      },
    );
  },
);
