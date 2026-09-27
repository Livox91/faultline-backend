require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  INCIDENT_REPOSITORY,
  InMemoryIncidentRepository,
} = require('@faultline/incidents');
const {
  EXTERNAL_TICKET_REPOSITORY,
  InMemoryExternalTicketRepository,
} = require('@faultline/notifications');
const {
  IncidentExternalTicketController,
} = require('../apps/api/dist/incident-external-ticket.controller');

const incidentId = '11111111-1111-4111-8111-111111111111';

function incident() {
  return {
    id: incidentId,
    correlationKey: 'production:payment',
    clusterId: 'production',
    namespace: 'default',
    logicalService: 'payment',
    title: 'Payment service unavailable',
    summary: 'Payment requests are failing.',
    classification: 'APPLICATION_DEPENDENCY_FAILURE',
    severity: 'HIGH',
    confidence: 0.9,
    status: 'OPEN',
    firstSeen: '2026-09-21T10:00:00.000Z',
    lastSeen: '2026-09-21T10:01:00.000Z',
    primaryResource: {
      scope: 'deployment',
      clusterId: 'production',
      namespace: 'default',
      workload: 'payment',
      workloadKind: 'Deployment',
    },
    affectedResources: [],
    anomalies: [],
    evidence: [],
    timeline: [],
  };
}

async function serve({ withTicket = false, unsafeUrl = false } = {}) {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident(incident());
  const tickets = new InMemoryExternalTicketRepository();
  if (withTicket)
    await tickets.saveIfAbsent({
      id: '22222222-2222-4222-8222-222222222222',
      provider: 'slack',
      externalMessageId: '1234567890.123456',
      incidentId,
      channelId: 'C123',
      createdAt: '2026-09-21T10:02:00.000Z',
      updatedAt: '2026-09-21T10:03:00.000Z',
      url: unsafeUrl
        ? 'javascript:alert(1)'
        : 'https://slack.com/archives/C123/p1234567890123456',
    });

  class TicketApiModule {}
  Module({
    controllers: [IncidentExternalTicketController],
    providers: [
      { provide: INCIDENT_REPOSITORY, useValue: incidents },
      { provide: EXTERNAL_TICKET_REPOSITORY, useValue: tickets },
    ],
  })(TicketApiModule);
  const app = await NestFactory.create(TicketApiModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

test('Slack ticket endpoint exposes safe read-only metadata', async () => {
  const app = await serve({ withTicket: true });
  try {
    const response = await fetch(
      `${await app.getUrl()}/incidents/${incidentId}/external-tickets/slack`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.ticket, {
      provider: 'slack',
      status: 'LINKED',
      channelId: 'C123',
      createdAt: '2026-09-21T10:02:00.000Z',
      updatedAt: '2026-09-21T10:03:00.000Z',
      url: 'https://slack.com/archives/C123/p1234567890123456',
    });
    assert.equal('externalMessageId' in body.ticket, false);
  } finally {
    await app.close();
  }
});

test('Slack ticket endpoint returns an explicit empty state', async () => {
  const app = await serve();
  try {
    const response = await fetch(
      `${await app.getUrl()}/incidents/${incidentId}/external-tickets/slack`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ticket: null });
  } finally {
    await app.close();
  }
});

test('Slack ticket endpoint suppresses unsafe stored links', async () => {
  const app = await serve({ withTicket: true, unsafeUrl: true });
  try {
    const response = await fetch(
      `${await app.getUrl()}/incidents/${incidentId}/external-tickets/slack`,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal('url' in body.ticket, false);
  } finally {
    await app.close();
  }
});
