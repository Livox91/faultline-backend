require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { InMemoryAuditLogRepository } = require('@faultline/auth');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const {
  InMemoryIncidentAcknowledgementRepository,
  InMemoryIncidentNotificationStateRepository,
  InMemoryNotificationAuditRepository,
} = require('@faultline/notifications');
const { AuditTrail } = require('../apps/api/dist/auth/audit-trail');
const {
  IncidentAcknowledgementController,
} = require('../apps/api/dist/incident-acknowledgement.controller');

const incidentId = '11111111-1111-4111-8111-111111111111';
const actor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'operator@faultline.test',
  name: 'Operator',
  role: 'onsiteengineer',
  status: 'active',
  mfaEnabled: false,
  assignments: [{ projectId: 'production' }],
};

test('incident acknowledgement is recorded in operational and actor audit trails', async () => {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident({
    id: incidentId,
    correlationKey: 'production:payment',
    clusterId: 'production',
    primaryResource: { scope: 'deployment', clusterId: 'production' },
    affectedResources: [],
    classification: 'APPLICATION_DEPENDENCY_FAILURE',
    title: 'Payment service unavailable',
    summary: 'Payment requests are failing.',
    severity: 'HIGH',
    status: 'OPEN',
    confidence: 0.9,
    firstSeen: '2026-09-21T10:00:00.000Z',
    lastSeen: '2026-09-21T10:01:00.000Z',
    anomalies: [],
    evidence: [],
    timeline: [],
  });
  const states = new InMemoryIncidentNotificationStateRepository();
  const acknowledgements = new InMemoryIncidentAcknowledgementRepository();
  const notificationAudit = new InMemoryNotificationAuditRepository();
  const audit = new InMemoryAuditLogRepository();
  const controller = new IncidentAcknowledgementController(
    incidents,
    states,
    acknowledgements,
    notificationAudit,
    new AuditTrail(audit, { error() {} }),
  );

  await controller.acknowledge(
    incidentId,
    { acknowledgedBy: 'Ahmed', note: 'Investigating' },
    actor,
    { headers: { 'user-agent': 'audit-test' }, ip: '127.0.0.1' },
  );

  const operational = await notificationAudit.list(incidentId);
  assert.equal(operational.length, 1);
  assert.equal(operational[0].type, 'INCIDENT_ACKNOWLEDGED');
  const entries = await audit.list({ action: 'incident.acknowledged' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, actor.email);
  assert.equal(entries[0].resourceId, incidentId);
  assert.equal(entries[0].metadata.clusterId, 'production');
  assert.equal(entries[0].metadata.hasNote, true);
  assert.equal(entries[0].ip, '127.0.0.1');
});

test('incident acknowledgement is hidden from an operator outside the project', async () => {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident({
    id: incidentId,
    correlationKey: 'production:payment',
    clusterId: 'production',
    primaryResource: { scope: 'deployment', clusterId: 'production' },
    affectedResources: [],
    classification: 'APPLICATION_DEPENDENCY_FAILURE',
    title: 'Payment service unavailable',
    summary: 'Payment requests are failing.',
    severity: 'HIGH',
    status: 'OPEN',
    confidence: 0.9,
    firstSeen: '2026-09-21T10:00:00.000Z',
    lastSeen: '2026-09-21T10:01:00.000Z',
    anomalies: [],
    evidence: [],
    timeline: [],
  });
  const notificationAudit = new InMemoryNotificationAuditRepository();
  const audit = new InMemoryAuditLogRepository();
  const controller = new IncidentAcknowledgementController(
    incidents,
    new InMemoryIncidentNotificationStateRepository(),
    new InMemoryIncidentAcknowledgementRepository(),
    notificationAudit,
    new AuditTrail(audit, { error() {} }),
  );

  await assert.rejects(
    controller.acknowledge(
      incidentId,
      { acknowledgedBy: 'Intruder' },
      { ...actor, assignments: [{ projectId: 'elsewhere' }] },
      { headers: {} },
    ),
    /Incident not found/,
  );
  assert.equal((await notificationAudit.list(incidentId)).length, 0);
  assert.equal((await audit.list()).length, 0);
});
