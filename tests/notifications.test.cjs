const test = require('node:test');
const assert = require('node:assert/strict');
const { sign } = require('retell-sdk');
const A = require('@faultline/auth');
const N = require('@faultline/notifications');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const { ApplicationLogger } = require('@faultline/platform');
const { ClusterRecipientResolver } = require('../apps/notification/dist/cluster-recipient.resolver.js');
const { IncidentMessageBuilder } = require('../apps/notification/dist/message-builder.js');
const { NotificationService } = require('../apps/notification/dist/notification.service.js');
const { RetellCommunicationProvider } = require('../apps/notification/dist/retell.provider.js');
const { RetellWebhookController } = require('../apps/notification/dist/webhook.controller.js');
const { VoiceActionController } = require('../apps/notification/dist/voice-action.controller.js');
const { VoiceActionService } = require('../apps/notification/dist/voice-action.service.js');

function incident(overrides = {}) {
  return {
    id: 'inc-1',
    correlationKey: 'c',
    clusterId: 'production',
    namespace: 'production',
    primaryResource: { scope: 'deployment', clusterId: 'production', workload: 'payment-api' },
    affectedResources: [],
    classification: 'WORKLOAD_CRASHING',
    title: 'Repeated crashes',
    summary: 'crashes',
    severity: 'CRITICAL',
    status: 'ACTIVE',
    confidence: 0.9,
    firstSeen: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-01T00:01:00Z',
    anomalies: [],
    evidence: [],
    timeline: [],
    ...overrides,
  };
}

function contact(id, userId, overrides = {}) {
  return {
    id,
    organizationId: 'org',
    userId,
    name: id,
    role: 'ENGINEER',
    phoneNumber: '+15550000001',
    smsEnabled: true,
    voiceEnabled: true,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function harness(options = {}) {
  const users = new A.InMemoryUserRepository();
  const assignments = new N.InMemoryClusterSreAssignmentRepository();
  const contacts = new N.InMemoryContactRepository();
  const admin = await users.create({ organizationId: 'org', email: 'admin@example.com', name: 'Head Engineer', role: A.ROLES.ADMIN, status: 'active' });
  await contacts.create(contact('admin-contact', admin.id, { role: 'TEAM_LEAD', phoneNumber: '+15550000009' }));
  const engineers = [];
  for (let index = 0; index < (options.engineerCount ?? 1); index++) {
    const engineer = await users.create({ organizationId: 'org', email: `sre${index}@example.com`, name: `SRE ${index}`, role: A.ROLES.ONSITE_ENGINEER, status: 'active' });
    engineers.push(engineer);
    if (options.assignEngineers !== false)
      await assignments.assign('production', engineer.id, admin.id);
    if (options.linkEngineerContacts !== false)
      await contacts.create(contact(`sre-contact-${index}`, engineer.id, { phoneNumber: `+1555000000${index + 1}`, ...(options.contactOverrides ?? {}) }));
  }
  const attempts = new N.InMemoryNotificationAttemptRepository();
  const states = new N.InMemoryIncidentNotificationStateRepository();
  const audit = new N.InMemoryNotificationAuditRepository();
  const calls = [];
  const provider = {
    name: 'mock',
    async startVoiceCall(input) {
      calls.push({ channel: 'VOICE', input });
      return { requestId: `call-${calls.length}`, status: 'SENT' };
    },
    async sendSms(input) {
      calls.push({ channel: 'SMS', input });
      return { requestId: `sms-${calls.length}`, status: 'SENT' };
    },
    async getCallStatus(requestId) { return { requestId, status: 'IN_PROGRESS' }; },
    ...(options.provider ?? {}),
  };
  const resolver = new ClusterRecipientResolver(users, assignments, contacts);
  const service = new NotificationService(
    new N.SeverityNotificationPolicy(false),
    resolver,
    provider,
    attempts,
    states,
    audit,
    new N.InMemoryIdempotencyStore(),
    new IncidentMessageBuilder(),
    new ApplicationLogger('notification', 'fatal'),
  );
  return { service, users, assignments, contacts, admin, engineers, attempts, states, audit, calls };
}

test('contact creation normalizes E.164 and user lookup is organization scoped', async () => {
  const repo = new N.InMemoryContactRepository();
  await repo.create(contact('sre', 'user-1', { phoneNumber: N.normalizePhoneNumber('+1 (555) 000-0001') }));
  assert.equal((await repo.get('sre')).phoneNumber, '+15550000001');
  assert.deepEqual((await repo.findByUserIds(['user-1'], 'org')).map((value) => value.id), ['sre']);
  assert.equal((await repo.findByUserIds(['user-1'], 'other')).length, 0);
  assert.throws(() => N.normalizePhoneNumber('03001234567'), /E.164/);
});

test('assigned SRE is contacted immediately on every enabled channel', async () => {
  const h = await harness();
  await h.service.handleIncident(incident(), 'org');
  assert.deepEqual(h.calls.map((value) => value.channel).sort(), ['SMS', 'VOICE']);
  assert.ok(h.calls.every((value) => value.input.recipient.id === 'sre-contact-0'));
  const state = await h.states.get('inc-1');
  assert.deepEqual(state.recipientIds, ['sre-contact-0']);
  assert.equal(state.fallbackUsed, false);
});

test('all assigned SREs are contacted in one dispatch pass', async () => {
  const h = await harness({ engineerCount: 2, contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  assert.deepEqual(h.calls.map((value) => value.input.recipient.id).sort(), ['sre-contact-0', 'sre-contact-1']);
  assert.equal((await h.attempts.listForIncident('inc-1')).length, 2);
});

test('primary admin is used when no SRE is assigned', async () => {
  const h = await harness({ assignEngineers: false, contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  assert.ok(h.calls.every((value) => value.input.recipient.id === 'admin-contact'));
  assert.equal((await h.states.get('inc-1')).fallbackUsed, true);
  assert.ok((await h.audit.list('inc-1')).some((value) => value.type === 'ADMIN_FALLBACK_USED'));
});

test('uncontactable assigned SRE is audited and falls back to admin', async () => {
  const h = await harness({ linkEngineerContacts: false });
  await h.service.handleIncident(incident(), 'org');
  assert.ok(h.calls.every((value) => value.input.recipient.id === 'admin-contact'));
  assert.ok((await h.audit.list('inc-1')).some((value) => value.details?.reason === 'CONTACT_NOT_LINKED'));
});

test('duplicate incident events do not redeliver direct notifications', async () => {
  const h = await harness();
  await h.service.handleIncident(incident(), 'org');
  await h.service.handleIncident(incident(), 'org');
  assert.equal(h.calls.length, 2);
});

test('high incidents remain disabled unless the high-severity switch is enabled', async () => {
  const h = await harness();
  await h.service.handleIncident(incident({ severity: 'HIGH' }), 'org');
  assert.equal(h.calls.length, 0);
});

test('provider failure is recorded without delayed escalation or retry', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false }, provider: { async startVoiceCall() { throw new Error('offline'); } } });
  await h.service.handleIncident(incident(), 'org');
  const attempts = await h.attempts.listForIncident('inc-1');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'FAILED');
  assert.equal(attempts[0].failureReason, 'offline');
  assert.ok((await h.audit.list('inc-1')).some((value) => value.type === 'CALL_FAILED'));
});

test('provider callbacks remain idempotent and preserve attempt history', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'ANSWERED' });
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'ANSWERED' });
  assert.equal((await h.attempts.listForIncident('inc-1'))[0].status, 'ANSWERED');
  assert.equal((await h.audit.list('inc-1')).filter((value) => value.type === 'VOICE_CALL_ANSWERED').length, 1);
});

test('resolved incidents close direct notification state without new delivery', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  await h.service.handleIncident(incident({ status: 'RESOLVED', resolvedAt: new Date().toISOString() }), 'org');
  assert.equal((await h.states.get('inc-1')).status, 'RESOLVED');
  assert.equal(h.calls.length, 1);
});

test('Retell request and signed webhook use provider boundary', async () => {
  const config = { apiKey: 'secret', fromNumber: '+15550000000', voiceAgentId: 'agent' };
  const provider = new RetellCommunicationProvider(config);
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ call_id: 'retell-call' }), { status: 200 });
  try {
    assert.equal((await provider.startVoiceCall({ recipient: { id: 'p', name: 'P', phoneNumber: '+15550000001', audience: 'ENGINEERING' }, message: 'Alert', context: {}, metadata: {} })).requestId, 'retell-call');
    let received;
    const controller = new RetellWebhookController(provider, { async processProviderEvent(event) { received = event; } });
    const body = { event: 'call_ended', call: { call_id: 'retell-call', call_status: 'ended', disconnection_reason: 'dial_no_answer' } };
    const rawBody = Buffer.from(JSON.stringify(body));
    await controller.receive({ rawBody, body }, await sign(rawBody.toString(), 'secret'));
    assert.equal(received.status, 'NO_ANSWER');
  } finally {
    global.fetch = original;
  }
});

async function voiceHarness() {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  const incidents = new InMemoryIncidentRepository();
  const acknowledgements = new N.InMemoryIncidentAcknowledgementRepository();
  await incidents.createIncident(incident());
  await h.service.handleIncident(incident(), 'org');
  const attempt = (await h.attempts.listForIncident('inc-1'))[0];
  const actions = new VoiceActionService(
    incidents,
    h.attempts,
    h.states,
    acknowledgements,
    h.audit,
    new N.InMemoryIdempotencyStore(),
    { async publish() {}, async subscribe() { return { async close() {} }; }, async close() {} },
  );
  const request = {
    incidentId: 'inc-1',
    notificationAttemptId: attempt.id,
    recipientId: attempt.recipientId,
    action: 'ACKNOWLEDGE_INCIDENT',
    providerCallId: attempt.providerRequestId,
    timestamp: new Date().toISOString(),
  };
  return { ...h, incidents, acknowledgements, actions, request };
}

test('voice acknowledgement preserves webhook validation and stops notification state', async () => {
  const h = await voiceHarness();
  const result = await h.actions.process(h.request);
  assert.equal(result.outcome, 'ACKNOWLEDGED');
  assert.equal((await h.states.get('inc-1')).status, 'ACKNOWLEDGED');
  assert.equal((await h.attempts.get(h.request.notificationAttemptId)).status, 'ACKNOWLEDGED');
  assert.equal((await h.acknowledgements.get('inc-1')).acknowledgedBy, 'sre-contact-0');
});

test('decline records the response without starting another delivery', async () => {
  const h = await voiceHarness();
  const result = await h.actions.process({ ...h.request, action: 'DECLINE_INCIDENT' });
  assert.equal(result.outcome, 'DECLINED');
  assert.equal(h.calls.length, 1);
  assert.equal((await h.states.get('inc-1')).status, 'ACTIVE');
});

test('duplicate voice acknowledgement is side-effect free', async () => {
  const h = await voiceHarness();
  await h.actions.process(h.request);
  const before = (await h.audit.list('inc-1')).length;
  const duplicate = await h.actions.process(h.request);
  assert.equal(duplicate.processed, false);
  assert.equal((await h.audit.list('inc-1')).length, before);
});

test('voice action endpoint rejects invalid provider authentication', async () => {
  const h = await voiceHarness();
  const provider = new RetellCommunicationProvider({ apiKey: 'secret', fromNumber: '+15550000000', voiceAgentId: 'agent' });
  const controller = new VoiceActionController(provider, h.actions);
  const rawBody = Buffer.from(JSON.stringify(h.request));
  await assert.rejects(() => controller.receive({ rawBody, body: h.request }, h.request, 'invalid'), /Invalid provider signature/);
});

test('message builder keeps engineering and end-user detail separated', () => {
  const builder = new IncidentMessageBuilder();
  assert.match(builder.build(incident(), 'ENGINEERING'), /Critical incident/);
  assert.doesNotMatch(builder.build(incident(), 'END_USER'), /container|namespace|Kubernetes/i);
});
