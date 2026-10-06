require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const N = require('@faultline/notifications');
const {
  SlackAcknowledgementService,
} = require('../apps/notification/dist/slack-acknowledgement.service');
const {
  SlackEventsController,
  verifySlackSignature,
} = require('../apps/notification/dist/slack-events.controller');
const { SlackEventProcessor } = require('../apps/notification/dist/slack-event.processor');
const { SlackSocketModeService } = require('../apps/notification/dist/slack-socket-mode.service');

const incident = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  correlationKey: 'production:payments',
  clusterId: 'production',
  namespace: 'payments',
  primaryResource: { clusterId: 'production', namespace: 'payments', workload: 'api' },
  affectedResources: [],
  classification: 'APPLICATION_DEGRADATION',
  title: 'Payments unavailable',
  summary: 'Requests fail',
  severity: 'CRITICAL',
  status: 'OPEN',
  confidence: 1,
  firstSeen: '2026-10-06T10:00:00.000Z',
  lastSeen: '2026-10-06T10:00:01.000Z',
  anomalies: [],
  evidence: [],
  timeline: [],
});

async function fixture() {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident(incident());
  const tickets = new N.InMemoryExternalTicketRepository();
  await tickets.saveIfAbsent({
    id: 'ticket-1', provider: 'slack', incidentId: incident().id,
    channelId: 'C123', externalMessageId: '1791277200.000100',
    createdAt: '2026-10-06T10:00:02.000Z', updatedAt: '2026-10-06T10:00:02.000Z',
  });
  const acknowledgements = new N.InMemoryIncidentAcknowledgementRepository();
  const states = new N.InMemoryIncidentNotificationStateRepository();
  await states.save({
    incidentId: incident().id, clusterId: 'production', organizationId: 'org',
    recipientIds: [], fallbackUsed: false, status: 'ACTIVE',
    startedAt: '2026-10-06T10:00:02.000Z', updatedAt: '2026-10-06T10:00:02.000Z',
  });
  const audit = new N.InMemoryNotificationAuditRepository();
  const published = [];
  const service = new SlackAcknowledgementService(
    tickets, incidents, acknowledgements, states, audit,
    new N.InMemoryIdempotencyStore(),
    { async publish(topic, message) { published.push({ topic, message }); } },
  );
  return { service, acknowledgements, states, audit, published };
}

test('a Slack ticket reaction records the first acknowledgement used by MTTA', async () => {
  const value = await fixture();
  const result = await value.service.acknowledge({
    eventId: 'Ev-reaction-1', channelId: 'C123',
    messageTimestamp: '1791277200.000100', userId: 'U123',
    occurredAt: '2026-10-06T10:00:30.000Z', source: 'REACTION',
  });
  assert.equal(result, 'ACKNOWLEDGED');
  assert.deepEqual(await value.acknowledgements.get(incident().id), {
    incidentId: incident().id,
    acknowledgedBy: 'slack:U123',
    acknowledgedAt: '2026-10-06T10:00:30.000Z',
    slackEventId: 'Ev-reaction-1',
    channel: 'SLACK',
    note: 'Acknowledged from Slack reaction',
  });
  assert.equal((await value.states.get(incident().id)).status, 'ACKNOWLEDGED');
  assert.equal((await value.audit.list(incident().id))[0].type, 'INCIDENT_ACKNOWLEDGED');
  assert.equal(value.published.length, 1);
  assert.equal(await value.service.acknowledge({
    eventId: 'Ev-reaction-1', channelId: 'C123',
    messageTimestamp: '1791277200.000100', userId: 'U123',
    occurredAt: '2026-10-06T10:00:31.000Z', source: 'REACTION',
  }), 'DUPLICATE');
});

test('Slack Events API verifies signatures and accepts acknowledge thread replies', async () => {
  const secret = 'slack-signing-secret';
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const body = {
    type: 'event_callback', event_id: 'Ev-reply-1', event_time: Math.floor(now / 1000),
    event: { type: 'message', channel: 'C123', user: 'U456', text: 'Acknowledge', thread_ts: '1791277200.000100' },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`;
  assert.equal(verifySlackSignature(rawBody, timestamp, signature, secret, now), true);
  assert.equal(verifySlackSignature(rawBody, String(Number(timestamp) - 301), signature, secret, now), false);
  let received;
  const processor = new SlackEventProcessor(
    { async acknowledge(value) { received = value; return 'ACKNOWLEDGED'; } },
  );
  const controller = new SlackEventsController(
    { slack: { signingSecret: secret } }, processor,
  );
  assert.deepEqual(
    await controller.receive({ rawBody }, body, timestamp, signature),
    { accepted: true, result: 'ACKNOWLEDGED' },
  );
  assert.equal(received.source, 'REPLY');
  assert.equal(received.messageTimestamp, '1791277200.000100');
});

test('Socket Mode opens with the app token, processes an event, and acknowledges its envelope', async () => {
  const listeners = new Map();
  const sent = [];
  const socket = {
    readyState: 1,
    addEventListener(type, listener) { listeners.set(type, listener); },
    send(value) { sent.push(JSON.parse(value)); },
    close() { this.readyState = 3; listeners.get('close')?.(); },
  };
  let authorization;
  const processed = [];
  const service = new SlackSocketModeService(
    { slack: { socketModeEnabled: true, appToken: 'xapp-test' } },
    { async process(value) { processed.push(value); return { accepted: false }; } },
    { log() {}, warn() {} },
    async (_url, options) => {
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({ ok: true, url: 'wss://wss.slack.test/link' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
    () => socket,
  );
  service.onModuleInit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorization, 'Bearer xapp-test');
  await listeners.get('message')({ data: JSON.stringify({
    type: 'events_api', envelope_id: 'envelope-1',
    payload: { type: 'event_callback', event_id: 'Ev-1', event: { type: 'app_mention' } },
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processed.length, 1);
  assert.deepEqual(sent, [{ envelope_id: 'envelope-1' }]);
  service.onModuleDestroy();
});
