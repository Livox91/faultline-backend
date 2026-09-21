require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  InMemoryIncidentRepository,
} = require('@faultline/incidents');
const {
  InMemoryExternalTicketRepository,
  InMemoryIdempotencyStore,
} = require('@faultline/notifications');
const {
  loadNotificationConfig,
} = require('../apps/notification/dist/config');
const {
  HttpSlackClient,
  SlackApiError,
} = require('../apps/notification/dist/slack.client');
const {
  SlackMessageBuilder,
} = require('../apps/notification/dist/slack-message-builder');
const {
  SlackIncidentTicketPublisher,
} = require('../apps/notification/dist/slack-incident-ticket.publisher');
const {
  SlackIncidentChannelResolver,
} = require('../apps/notification/dist/slack-incident-channel.resolver');
const {
  SlackIncidentTimelineMapper,
} = require('../apps/notification/dist/slack-incident-timeline.mapper');
const {
  NotificationConsumer,
} = require('../apps/notification/dist/notification.consumer');

const baseEnvironment = {
  RETELL_API_KEY: 'retell-test',
  RETELL_FROM_NUMBER: '+15550000000',
  RETELL_VOICE_AGENT_ID: 'voice-agent',
};

const config = (slack = {}) => ({
  apiKey: 'retell-test',
  fromNumber: '+15550000000',
  voiceAgentId: 'voice-agent',
  highEscalationEnabled: false,
  consumerGroup: 'faultline-notifications',
  organizationId: 'default',
  schedulerPollMs: 5000,
  schedulerLeaseMs: 30000,
  staleAttemptMs: 300000,
  attemptRetentionDays: 90,
  auditRetentionDays: 365,
  slack: {
    enabled: true,
    botToken: 'xoxb-test',
    incidentChannelId: 'C123',
    dashboardUrl: 'https://faultline.example/',
    serviceChannels: {},
    serviceOwners: {},
    teamChannels: {},
    ...slack,
  },
});

const incident = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  correlationKey: 'production:payments:api',
  clusterId: 'production',
  namespace: 'payments',
  primaryResource: {
    scope: 'deployment',
    clusterId: 'production',
    namespace: 'payments',
    workload: 'payment-api',
  },
  affectedResources: [
    {
      scope: 'deployment',
      clusterId: 'production',
      namespace: 'payments',
      workload: 'payment-api',
    },
    {
      scope: 'deployment',
      clusterId: 'production',
      namespace: 'payments',
      workload: 'payment-worker',
    },
  ],
  classification: 'APPLICATION_DEPENDENCY_FAILURE',
  title: 'Payment dependency unavailable',
  summary: 'Payment requests are failing while the database is unavailable.',
  severity: 'CRITICAL',
  status: 'OPEN',
  logicalService: 'payments',
  confidence: 0.95,
  firstSeen: '2026-09-21T10:00:00.000Z',
  lastSeen: '2026-09-21T10:01:00.000Z',
  anomalies: [],
  evidence: [],
  timeline: [],
  ...overrides,
});

test('Slack configuration is opt-in and missing credentials fail closed', () => {
  assert.equal(loadNotificationConfig(baseEnvironment).slack.enabled, false);
  assert.equal(loadNotificationConfig({
    ...baseEnvironment,
    SLACK_ENABLED: 'true',
  }).slack.enabled, false);
  const enabled = loadNotificationConfig({
    ...baseEnvironment,
    SLACK_ENABLED: 'true',
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_INCIDENT_CHANNEL_ID: 'C123',
    SLACK_DASHBOARD_URL: 'https://faultline.example/',
    SLACK_SERVICE_CHANNELS: '{" Payments ":"C-PAYMENTS"}',
    SLACK_SERVICE_OWNERS: '{"payments":"Commerce"}',
    SLACK_TEAM_CHANNELS: '{"commerce":"C-COMMERCE"}',
  });
  assert.deepEqual(enabled.slack, {
    enabled: true,
    botToken: 'xoxb-test',
    incidentChannelId: 'C123',
    dashboardUrl: 'https://faultline.example/',
    serviceChannels: { payments: 'C-PAYMENTS' },
    serviceOwners: { payments: 'Commerce' },
    teamChannels: { commerce: 'C-COMMERCE' },
  });
});

test('Slack channel resolver prefers a service-specific mapping', () => {
  const resolver = new SlackIncidentChannelResolver(config({
    serviceChannels: { payments: 'C-PAYMENTS' },
    serviceOwners: { payments: 'commerce' },
    teamChannels: { commerce: 'C-COMMERCE' },
  }));
  assert.equal(resolver.resolve(incident()), 'C-PAYMENTS');
});

test('Slack channel resolver falls back to the owning team mapping', () => {
  const resolver = new SlackIncidentChannelResolver(config({
    serviceOwners: { payments: 'commerce' },
    teamChannels: { commerce: 'C-COMMERCE' },
  }));
  assert.equal(resolver.resolve(incident()), 'C-COMMERCE');
});

test('Slack channel resolver falls back to the default channel', () => {
  const resolver = new SlackIncidentChannelResolver(config());
  assert.equal(resolver.resolve(incident()), 'C123');
});

test('Slack channel resolver sends an unknown service to the default channel', () => {
  const resolver = new SlackIncidentChannelResolver(config({
    serviceChannels: { search: 'C-SEARCH' },
    serviceOwners: { search: 'discovery' },
    teamChannels: { discovery: 'C-DISCOVERY' },
  }));
  assert.equal(
    resolver.resolve(incident({ logicalService: 'unknown-service' })),
    'C123',
  );
});

test('Slack channel resolver deterministically selects the first normalized affected service', () => {
  const resolver = new SlackIncidentChannelResolver(config({
    serviceChannels: { alpha: 'C-ALPHA', zeta: 'C-ZETA' },
  }));
  const value = incident({
    logicalService: undefined,
    primaryResource: {
      scope: 'node',
      clusterId: 'production',
      node: 'worker-1',
    },
    affectedResources: [
      { scope: 'deployment', clusterId: 'production', workload: 'Zeta' },
      { scope: 'deployment', clusterId: 'production', workload: ' alpha ' },
    ],
  });
  assert.equal(resolver.resolve(value), 'C-ALPHA');
  assert.equal(resolver.resolve({ ...value, affectedResources: [...value.affectedResources].reverse() }), 'C-ALPHA');
});

test('Slack API client supports postMessage and updateMessage operations', async () => {
  const requests = [];
  const client = new HttpSlackClient(config(), async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '123.456' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  assert.deepEqual(await client.postMessage({
    channel: 'C123',
    text: 'Incident',
  }), { channel: 'C123', timestamp: '123.456' });
  assert.equal(requests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    channel: 'C123',
    text: 'Incident',
  });
  assert.deepEqual(await client.updateMessage({
    channel: 'C123',
    timestamp: '123.456',
    text: 'Updated incident',
  }), { channel: 'C123', timestamp: '123.456' });
  assert.equal(requests[1].url, 'https://slack.com/api/chat.update');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    channel: 'C123',
    ts: '123.456',
    text: 'Updated incident',
  });
  assert.deepEqual(await client.postThreadReply({
    channel: 'C123',
    threadTimestamp: '123.456',
    text: 'Investigation started',
  }), { channel: 'C123', timestamp: '123.456' });
  assert.equal(requests[2].url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    channel: 'C123',
    thread_ts: '123.456',
    text: 'Investigation started',
  });
});

test('Slack API client retries bounded transient failures but not permanent failures', async () => {
  let transientAttempts = 0;
  const transient = new HttpSlackClient(config(), async () => {
    transientAttempts++;
    if (transientAttempts < 3)
      return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    return new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '3.3' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  assert.equal((await transient.postMessage({ channel: 'C123', text: 'Incident' })).timestamp, '3.3');
  assert.equal(transientAttempts, 3);

  let permanentAttempts = 0;
  const permanent = new HttpSlackClient(config(), async () => {
    permanentAttempts++;
    return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await assert.rejects(
    permanent.postMessage({ channel: 'C123', text: 'Incident' }),
    (error) => error instanceof SlackApiError && error.code === 'invalid_auth' && !error.transient,
  );
  assert.equal(permanentAttempts, 1);
});

test('Slack message builder includes normalized incident details and redacts unsafe text', () => {
  const message = new SlackMessageBuilder().buildIncidentCreatedMessage(
    incident({
      summary: 'Failed Authorization: Bearer abc token=secret NODE_ENV=production\n    at handler (/app/index.js:1:1)',
    }),
    'https://faultline.example/',
  );
  const serialized = JSON.stringify(message);
  for (const value of [
    'Payment dependency unavailable',
    'CRITICAL',
    'OPEN',
    'payments',
    'payment-api',
    'payment-worker',
    '2026-09-21T10:00:00.000Z',
    '11111111-1111-4111-8111-111111111111',
    'https://faultline.example/incidents/11111111-1111-4111-8111-111111111111',
  ]) assert.match(serialized, new RegExp(value.replaceAll('.', '\\.')));
  assert.doesNotMatch(serialized, /abc|token=secret|NODE_ENV|\/app\/index\.js/);
  assert.match(serialized, /REDACTED/);
});

test('Slack messages restrict secrets, customer contact data, and stack traces', () => {
  const builder = new SlackMessageBuilder();
  const value = incident({
    summary: 'Authorization: Bearer slack-bearer-secret database_url=postgresql://admin:slack-db-secret@db/faultline customer@example.com +15551234567\n    at handler (/srv/app.js:4:2)',
    confirmedRootCause: 'access_token=slack-access-secret Cookie: session=slack-cookie-secret',
    status: 'RESOLVED',
    resolvedAt: '2026-09-21T10:05:00.000Z',
  });
  const output = JSON.stringify([
    builder.buildIncidentCreatedMessage(value),
    builder.buildIncidentUpdatedMessage(value, 'RESOLVED'),
    builder.buildTimelineUpdate({
      id: 'timeline-secret',
      timestamp: '2026-09-21T10:01:00.000Z',
      title: 'Investigation update',
      summary: 'refresh_token=slack-refresh-secret X-Secret: slack-header-secret',
    }),
  ]);
  for (const secret of [
    'slack-bearer-secret', 'slack-db-secret', 'customer@example.com', '+15551234567',
    '/srv/app.js', 'slack-access-secret', 'slack-cookie-secret', 'slack-refresh-secret',
    'slack-header-secret',
  ]) assert.doesNotMatch(output, new RegExp(secret.replaceAll(/[.+]/g, '\\$&')));
  assert.match(output, /REDACTED/);
});

test('Slack ticket publisher creates exactly one ticket from a persisted incident', async () => {
  const incidents = new InMemoryIncidentRepository();
  const persisted = incident();
  await incidents.createIncident(persisted);
  const calls = [];
  const tickets = new InMemoryExternalTicketRepository();
  const publisher = new SlackIncidentTicketPublisher(
    config(),
    { async postMessage(input) { calls.push(input); return { channel: 'C123', timestamp: '123.456' }; } },
    new SlackMessageBuilder(),
    incidents,
    tickets,
    new InMemoryIdempotencyStore(),
    new SlackIncidentChannelResolver(config()),
  );
  const first = await publisher.createIncidentTicket({ incidentId: persisted.id });
  const duplicate = await publisher.createIncidentTicket({ incidentId: persisted.id });
  assert.equal(calls.length, 1);
  assert.equal(first.provider, 'slack');
  assert.equal(first.incidentId, persisted.id);
  assert.equal(first.externalMessageId, '123.456');
  assert.deepEqual(duplicate, first);
  assert.deepEqual(
    await tickets.findByIncidentAndProvider(persisted.id, 'slack'),
    first,
  );
});

test('Slack ticket publisher ignores disabled, missing, and unclassified incidents', async () => {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident(incident({ id: '22222222-2222-4222-8222-222222222222', classification: '' }));
  let calls = 0;
  const client = { async postMessage() { calls++; return { channel: 'C123', timestamp: '1.1' }; } };
  const disabled = new SlackIncidentTicketPublisher(
    config({ enabled: false }), client, new SlackMessageBuilder(), incidents, new InMemoryExternalTicketRepository(), new InMemoryIdempotencyStore(), new SlackIncidentChannelResolver(config({ enabled: false })),
  );
  assert.equal(await disabled.createIncidentTicket({ incidentId: 'missing' }), undefined);
  const enabled = new SlackIncidentTicketPublisher(
    config(), client, new SlackMessageBuilder(), incidents, new InMemoryExternalTicketRepository(), new InMemoryIdempotencyStore(), new SlackIncidentChannelResolver(config()),
  );
  assert.equal(await enabled.createIncidentTicket({ incidentId: 'missing' }), undefined);
  assert.equal(await enabled.createIncidentTicket({ incidentId: '22222222-2222-4222-8222-222222222222' }), undefined);
  assert.equal(calls, 0);
});

test('Slack ticket creation failure is isolated and releases its durable claim', async () => {
  const incidents = new InMemoryIncidentRepository();
  const persisted = incident();
  await incidents.createIncident(persisted);
  let calls = 0;
  const publisher = new SlackIncidentTicketPublisher(
    config(),
    { async postMessage() { if (++calls === 1) throw new Error('offline'); return { channel: 'C123', timestamp: '2.2' }; } },
    new SlackMessageBuilder(),
    incidents,
    new InMemoryExternalTicketRepository(),
    new InMemoryIdempotencyStore(),
    new SlackIncidentChannelResolver(config()),
  );
  assert.equal(
    await publisher.createIncidentTicket({ incidentId: persisted.id }),
    undefined,
  );
  assert.ok(await publisher.createIncidentTicket({ incidentId: persisted.id }));
  assert.equal(calls, 2);
});

test('Slack failures produce structured secret-safe logs and controlled results', async () => {
  const incidents = new InMemoryIncidentRepository();
  const persisted = incident();
  await incidents.createIncident(persisted);
  const settings = config({ botToken: 'xoxb-super-secret' });
  const warnings = [];
  const logger = { warn(value) { warnings.push(value); }, log() {} };
  const publisher = new SlackIncidentTicketPublisher(
    settings,
    { async postMessage() { throw new SlackApiError('chat.postMessage', 'service_unavailable', 503, true); } },
    new SlackMessageBuilder(),
    incidents,
    new InMemoryExternalTicketRepository(),
    new InMemoryIdempotencyStore(),
    new SlackIncidentChannelResolver(settings),
    new SlackIncidentTimelineMapper(),
    logger,
  );
  assert.equal(await publisher.createIncidentTicket({ incidentId: persisted.id }), undefined);
  assert.deepEqual(warnings, [{
    event: 'slack.ticket.create_failed',
    incidentId: persisted.id,
    channelId: 'C123',
    errorCode: 'service_unavailable',
    retryable: true,
  }]);
  assert.doesNotMatch(JSON.stringify(warnings), /xoxb|Authorization|super-secret/);
});

test('redelivery reuses persisted Slack metadata without posting again', async () => {
  const incidents = new InMemoryIncidentRepository();
  const persisted = incident();
  await incidents.createIncident(persisted);
  const tickets = new InMemoryExternalTicketRepository();
  const createdAt = '2026-09-21T10:02:00.000Z';
  const stored = await tickets.saveIfAbsent({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    incidentId: persisted.id,
    provider: 'slack',
    channelId: 'C123',
    externalMessageId: '123.456',
    createdAt,
    updatedAt: createdAt,
    url: 'https://slack.com/archives/C123/p123456',
  });
  let calls = 0;
  const publisher = new SlackIncidentTicketPublisher(
    config(),
    { async postMessage() { calls++; throw new Error('must not post'); } },
    new SlackMessageBuilder(),
    incidents,
    tickets,
    new InMemoryIdempotencyStore(),
    new SlackIncidentChannelResolver(config()),
  );
  assert.deepEqual(
    await publisher.createIncidentTicket({ incidentId: persisted.id }),
    stored,
  );
  assert.equal(calls, 0);
});

async function updatePublisher(overrides = {}, clientOverrides = {}) {
  const incidents = new InMemoryIncidentRepository();
  const persisted = incident(overrides);
  await incidents.createIncident(persisted);
  const tickets = new InMemoryExternalTicketRepository();
  const createdAt = '2026-09-21T10:02:00.000Z';
  const ticket = await tickets.saveIfAbsent({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    incidentId: persisted.id,
    provider: 'slack',
    channelId: 'C-ORIGINAL',
    externalMessageId: '777.888',
    createdAt,
    updatedAt: createdAt,
  });
  const calls = { posts: [], updates: [], threads: [] };
  const client = {
    async postMessage(input) {
      calls.posts.push(input);
      return clientOverrides.postMessage
        ? clientOverrides.postMessage(input)
        : { channel: input.channel, timestamp: 'new.message' };
    },
    async updateMessage(input) {
      calls.updates.push(input);
      return clientOverrides.updateMessage
        ? clientOverrides.updateMessage(input)
        : { channel: input.channel, timestamp: input.timestamp };
    },
    async postThreadReply(input) {
      calls.threads.push(input);
      return clientOverrides.postThreadReply
        ? clientOverrides.postThreadReply(input)
        : { channel: input.channel, timestamp: 'reply.1' };
    },
  };
  const settings = config({ serviceChannels: { payments: 'C-NEW-ROUTE' } });
  const publisher = new SlackIncidentTicketPublisher(
    settings,
    client,
    new SlackMessageBuilder(),
    incidents,
    tickets,
    new InMemoryIdempotencyStore(),
    new SlackIncidentChannelResolver(settings),
  );
  return { publisher, calls, ticket };
}

test('status change updates the stored Slack message without creating a top-level message', async () => {
  const { publisher, calls, ticket } = await updatePublisher();
  const result = await publisher.updateIncidentTicket({
    incidentId: ticket.incidentId,
    state: 'INVESTIGATING',
  });
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].channel, 'C-ORIGINAL');
  assert.equal(calls.updates[0].timestamp, '777.888');
  assert.match(JSON.stringify(calls.updates[0]), /Investigating/);
  assert.equal(result.id, ticket.id);
  assert.notEqual(result.updatedAt, ticket.updatedAt);
});

test('resolution updates the existing ticket with resolved details', async () => {
  const { publisher, calls, ticket } = await updatePublisher({
    status: 'RESOLVED',
    resolvedAt: '2026-09-21T10:18:32.000Z',
    confirmedRootCause: 'Expired database credentials interrupted payments.',
  });
  await publisher.updateIncidentTicket({
    incidentId: ticket.incidentId,
    state: 'RESOLVED',
  });
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.updates.length, 1);
  const message = JSON.stringify(calls.updates[0]);
  assert.match(message, /Resolved Incident/);
  assert.match(message, /2026-09-21T10:18:32\.000Z/);
  assert.match(message, /18m 32s/);
  assert.match(message, /Expired database credentials interrupted payments/);
  assert.equal(calls.updates[0].timestamp, '777.888');
});

test('Slack update API failure is contained and does not fail incident processing', async () => {
  const { publisher, calls, ticket } = await updatePublisher({}, {
    async updateMessage() { throw new Error('Slack unavailable'); },
  });
  await assert.doesNotReject(async () => {
    assert.equal(await publisher.updateIncidentTicket({
      incidentId: ticket.incidentId,
      state: 'INVESTIGATING',
    }), undefined);
  });
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.updates.length, 1);
});

test('important lifecycle event posts one idempotent reply under the primary ticket', async () => {
  const { publisher, calls, ticket } = await updatePublisher();
  const event = {
    id: 'event-acknowledged-1',
    type: 'INCIDENT_ACKNOWLEDGED',
    incident: incident(),
    state: 'ACKNOWLEDGED',
    previousState: 'OPEN',
    occurredAt: '2026-09-21T10:03:00.000Z',
    changedFields: ['acknowledgement'],
  };
  await publisher.publishTimelineUpdates(event);
  await publisher.publishTimelineUpdates(event);
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.threads.length, 1);
  assert.equal(calls.threads[0].channel, ticket.channelId);
  assert.equal(calls.threads[0].threadTimestamp, ticket.externalMessageId);
  assert.match(JSON.stringify(calls.threads[0]), /Incident acknowledged/);
});

test('insignificant and repeated normalized timeline events are ignored', async () => {
  const { publisher, calls } = await updatePublisher();
  await publisher.publishTimelineUpdates({
    id: 'event-eta-1',
    type: 'INCIDENT_ETA_UPDATED',
    incident: incident({
      timeline: [{
        id: 'timeline-active-1',
        timestamp: '2026-09-21T10:04:00.000Z',
        type: 'ANOMALY_ACTIVE',
        anomalyId: 'anomaly-1',
        classification: 'HIGH_MEMORY_UTILIZATION',
        source: 'DETERMINISTIC',
        severity: 'CRITICAL',
        summary: 'Repeated sample',
      }],
    }),
    state: 'INVESTIGATING',
    previousState: 'INVESTIGATING',
    occurredAt: '2026-09-21T10:04:00.000Z',
    changedFields: ['estimatedRestorationAt'],
  });
  assert.equal(calls.threads.length, 0);
});

test('significant normalized incident timeline entry posts a thread reply', async () => {
  const { publisher, calls } = await updatePublisher();
  await publisher.publishTimelineUpdates({
    id: 'event-created-with-timeline',
    type: 'INCIDENT_CREATED',
    incident: incident({
      timeline: [{
        id: 'timeline-opened-1',
        timestamp: '2026-09-21T10:00:00.000Z',
        type: 'ANOMALY_OPENED',
        anomalyId: 'anomaly-1',
        classification: 'OOM_KILLED',
        source: 'DETERMINISTIC',
        severity: 'CRITICAL',
        summary: 'Container exceeded its memory limit.',
      }],
    }),
    state: 'OPEN',
    occurredAt: '2026-09-21T10:00:00.000Z',
    changedFields: ['created'],
  });
  assert.equal(calls.threads.length, 1);
  assert.match(JSON.stringify(calls.threads[0]), /Significant anomaly detected/);
  assert.match(JSON.stringify(calls.threads[0]), /Container exceeded its memory limit/);
});

test('Slack thread API failure is contained and remains retryable', async () => {
  const { publisher, calls } = await updatePublisher({}, {
    async postThreadReply() { throw new Error('Slack unavailable'); },
  });
  const event = {
    id: 'event-investigating-1',
    type: 'INCIDENT_STATUS_CHANGED',
    incident: incident(),
    state: 'INVESTIGATING',
    previousState: 'OPEN',
    occurredAt: '2026-09-21T10:05:00.000Z',
    changedFields: ['status'],
  };
  await assert.doesNotReject(() => publisher.publishTimelineUpdates(event));
  await assert.doesNotReject(() => publisher.publishTimelineUpdates(event));
  assert.equal(calls.threads.length, 2);
  assert.equal(calls.posts.length, 0);
});

test('notification lifecycle creates Slack tickets only for incident creation events', async () => {
  let handler;
  const queue = {
    async subscribe(_topic, value) { handler = value; return { async close() {} }; },
  };
  const ticketCalls = [];
  const ticketUpdates = [];
  const timelineUpdates = [];
  const consumer = new NotificationConsumer(
    queue,
    config(),
    { async handleIncident() {} },
    { async handle() {} },
    { async createIncidentTicket(value) { ticketCalls.push(value); }, async updateIncidentTicket(value) { ticketUpdates.push(value); }, async publishTimelineUpdates(value) { timelineUpdates.push(value); } },
  );
  await consumer.onModuleInit();
  const value = incident();
  await handler({ payload: { type: 'INCIDENT_CREATED', incident: value, state: 'OPEN', changedFields: ['created'] } });
  await handler({ payload: { type: 'INCIDENT_STATUS_CHANGED', incident: value, state: 'INVESTIGATING', changedFields: ['status'] } });
  assert.deepEqual(ticketCalls, [{ incidentId: value.id }]);
  assert.deepEqual(ticketUpdates, [{ incidentId: value.id, state: 'INVESTIGATING' }]);
  assert.equal(timelineUpdates.length, 2);
  await consumer.onModuleDestroy();
});
