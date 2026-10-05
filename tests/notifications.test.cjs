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
const { RetellCommunicationProvider, mapRetellStatus } = require('../apps/notification/dist/retell.provider.js');
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
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident(incident());
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
  const communications = new N.InMemoryIncidentCommunicationRepository();
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
    communications,
    incidents,
    { async get(id) { return id === 'production' ? { id, name: 'Production EU' } : undefined; } },
  );
  return { service, incidents, users, assignments, contacts, admin, engineers, attempts, states, audit, communications, calls };
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
  const communications = await h.communications.listForIncident('inc-1');
  assert.equal(communications.length, 2);
  const voice = communications.find((value) => value.channel === 'VOICE');
  assert.equal(voice.status, 'PENDING');
  assert.equal(voice.providerRequestId, 'call-1');
  assert.equal(h.calls.find((value) => value.channel === 'VOICE').input.context.cluster_name, 'Production EU');
  assert.equal(h.calls.find((value) => value.channel === 'VOICE').input.context.incident_status, 'ACTIVE');
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

test('provider request failure is recorded and immediately falls back to admin', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false }, provider: { async startVoiceCall() { throw new Error('offline'); } } });
  await h.service.handleIncident(incident(), 'org');
  const attempts = await h.attempts.listForIncident('inc-1');
  const sreAttempt = attempts.find((value) => value.recipientSource === 'ASSIGNED_SRE');
  assert.equal(sreAttempt.status, 'FAILED');
  assert.equal(sreAttempt.failureReason, 'offline');
  assert.ok(attempts.some((value) => value.recipientSource === 'ADMIN_FALLBACK'));
  assert.equal((await h.communications.findByDedupeKey(`direct:inc-1:sre-contact-0:VOICE`)).status, 'FAILED');
  assert.ok((await h.audit.list('inc-1')).some((value) => value.type === 'CALL_FAILED'));
});

test('provider callbacks remain idempotent and preserve attempt history', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'ANSWERED' });
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'ANSWERED' });
  assert.equal((await h.attempts.listForIncident('inc-1'))[0].status, 'ANSWERED');
  assert.equal((await h.communications.listForIncident('inc-1'))[0].status, 'ANSWERED');
  assert.equal((await h.audit.list('inc-1')).filter((value) => value.type === 'VOICE_CALL_ANSWERED').length, 1);
});

test('failed provider callback falls back to admin once and preserves the final outcome', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  await h.service.handleIncident(incident(), 'org');
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'NO_ANSWER' });
  await h.service.processProviderEvent({ requestId: 'call-1', status: 'NO_ANSWER' });
  assert.equal((await h.communications.findByProviderRequestId('call-1')).status, 'NO_ANSWER');
  assert.equal(h.calls.filter((call) => call.input.recipient.id === 'admin-contact').length, 2);
  assert.equal((await h.audit.list('inc-1')).filter((value) => value.type === 'ADMIN_FALLBACK_USED').length, 1);
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
  const requests = [];
  const provider = new RetellCommunicationProvider(config, {
    call: {
      async createPhoneCall(body) {
        requests.push(body);
        return { call_id: 'retell-call', call_status: 'registered' };
      },
      async retrieve() {
        return { call_id: 'retell-call', call_status: 'ongoing' };
      },
    },
  });
  const input = {
    recipient: { id: 'p', name: 'P', phoneNumber: '+15550000001', audience: 'ENGINEERING' },
    message: 'Critical alert',
    context: { cluster_name: 'Production EU', incident_status: 'ACTIVE' },
    metadata: { incidentId: 'inc-1' },
  };
  assert.equal((await provider.startVoiceCall(input)).requestId, 'retell-call');
  assert.deepEqual(requests[0], {
    from_number: '+15550000000',
    to_number: '+15550000001',
    override_agent_id: 'agent',
    metadata: { incidentId: 'inc-1' },
    retell_llm_dynamic_variables: {
      cluster_name: 'Production EU',
      incident_status: 'ACTIVE',
      notification_message: 'Critical alert',
      voice_script: 'This is the Faultline incident notification system. Critical alert Would you like to acknowledge this incident?',
      caller_identity: 'Faultline incident notification system',
      acknowledgement_prompt: 'Would you like to acknowledge this incident?',
      acknowledgement_confirmation: 'The incident has been acknowledged. Further notification will stop.',
      allowed_actions: 'ACKNOWLEDGE_INCIDENT,DECLINE_INCIDENT,UNKNOWN',
    },
  });
  assert.equal((await provider.getCallStatus('retell-call')).status, 'IN_PROGRESS');
  let received;
  const controller = new RetellWebhookController(provider, { async processProviderEvent(event) { received = event; } }, { async processProviderResponse() {} });
  const body = { event: 'call_ended', call: { call_id: 'retell-call', call_status: 'ended', disconnection_reason: 'dial_no_answer' } };
  const rawBody = Buffer.from(JSON.stringify(body));
  await controller.receive({ rawBody, body }, await sign(rawBody.toString(), 'secret'));
  assert.equal(received.status, 'NO_ANSWER');
  assert.equal(mapRetellStatus('ended', 'registered_call_timeout'), 'FAILED');
  assert.equal(mapRetellStatus('ended', 'user_declined'), 'DECLINED');
});

async function voiceHarness() {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  const acknowledgements = new N.InMemoryIncidentAcknowledgementRepository();
  await h.service.handleIncident(incident(), 'org');
  const attempt = (await h.attempts.listForIncident('inc-1'))[0];
  const actions = new VoiceActionService(
    h.incidents,
    h.attempts,
    h.states,
    acknowledgements,
    h.audit,
    new N.InMemoryIdempotencyStore(),
    { async publish() {}, async subscribe() { return { async close() {} }; }, async close() {} },
    h.communications,
    h.service,
  );
  const request = {
    incidentId: 'inc-1',
    notificationAttemptId: attempt.id,
    recipientId: attempt.recipientId,
    action: 'ACKNOWLEDGE_INCIDENT',
    providerCallId: attempt.providerRequestId,
    timestamp: new Date().toISOString(),
  };
  return { ...h, acknowledgements, actions, request };
}

test('voice acknowledgement preserves webhook validation and stops notification state', async () => {
  const h = await voiceHarness();
  const result = await h.actions.process(h.request);
  assert.equal(result.outcome, 'ACKNOWLEDGED');
  assert.equal((await h.states.get('inc-1')).status, 'ACKNOWLEDGED');
  assert.equal((await h.attempts.get(h.request.notificationAttemptId)).status, 'ACKNOWLEDGED');
  assert.equal((await h.communications.findByProviderRequestId(h.request.providerCallId)).status, 'ACKNOWLEDGED');
  assert.equal((await h.acknowledgements.get('inc-1')).acknowledgedBy, 'sre-contact-0');
});

test('decline records the response and immediately contacts the primary admin', async () => {
  const h = await voiceHarness();
  const result = await h.actions.process({ ...h.request, action: 'DECLINE_INCIDENT' });
  assert.equal(result.outcome, 'DECLINED');
  assert.ok(h.calls.some((call) => call.input.recipient.id === 'admin-contact'));
  assert.equal((await h.communications.findByProviderRequestId(h.request.providerCallId)).status, 'DECLINED');
  assert.equal((await h.states.get('inc-1')).status, 'ACTIVE');
});

test('signed Retell end-of-call transcript acknowledges the incident', async () => {
  const h = await voiceHarness();
  const provider = new RetellCommunicationProvider({ apiKey: 'secret', fromNumber: '+15550000000', voiceAgentId: 'agent' });
  const controller = new RetellWebhookController(provider, h.service, h.actions);
  const body = { event: 'call_ended', call: { call_id: h.request.providerCallId, call_status: 'ended', transcript_object: [
    { role: 'agent', content: 'Will you acknowledge this incident?' },
    { role: 'user', content: 'Yes, I acknowledge the incident.' },
  ] } };
  const rawBody = Buffer.from(JSON.stringify(body));
  await controller.receive({ rawBody, body }, await sign(rawBody.toString(), 'secret'));
  assert.equal((await h.states.get('inc-1')).status, 'ACKNOWLEDGED');
  assert.equal((await h.communications.findByProviderRequestId(h.request.providerCallId)).status, 'ACKNOWLEDGED');
});

test('signed Retell tool decision declines and starts the admin fallback', async () => {
  const h = await voiceHarness();
  const provider = new RetellCommunicationProvider({ apiKey: 'secret', fromNumber: '+15550000000', voiceAgentId: 'agent' });
  const controller = new RetellWebhookController(provider, h.service, h.actions);
  const body = { event: 'call_analyzed', call: { call_id: h.request.providerCallId, call_status: 'ended', transcript_with_tool_calls: [
    { role: 'tool', name: 'record_incident_response', arguments: JSON.stringify({ action: 'DECLINE_INCIDENT' }) },
  ] } };
  const rawBody = Buffer.from(JSON.stringify(body));
  await controller.receive({ rawBody, body }, await sign(rawBody.toString(), 'secret'));
  assert.equal((await h.communications.findByProviderRequestId(h.request.providerCallId)).status, 'DECLINED');
  assert.ok(h.calls.some((call) => call.input.recipient.id === 'admin-contact'));
});

test('Retell webhook rejects an invalid signature before processing an event', async () => {
  const h = await voiceHarness();
  const provider = new RetellCommunicationProvider({ apiKey: 'secret', fromNumber: '+15550000000', voiceAgentId: 'agent' });
  const controller = new RetellWebhookController(provider, h.service, h.actions);
  const body = { event: 'call_ended', call: { call_id: h.request.providerCallId, call_status: 'ended' } };
  await assert.rejects(
    () => controller.receive({ rawBody: Buffer.from(JSON.stringify(body)), body }, 'invalid'),
    /Invalid webhook signature/,
  );
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

test('late failure events cannot overwrite an acknowledged call or start fallback', async () => {
  const h = await voiceHarness();
  await h.actions.process(h.request);
  await h.service.processProviderEvent({ requestId: h.request.providerCallId, status: 'FAILED' });
  assert.equal((await h.attempts.get(h.request.notificationAttemptId)).status, 'ACKNOWLEDGED');
  assert.equal((await h.communications.findByProviderRequestId(h.request.providerCallId)).status, 'ACKNOWLEDGED');
  assert.equal(h.calls.filter((call) => call.input.recipient.id === 'admin-contact').length, 0);
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

test('Admin test call uses the normal Retell tracking path and is idempotent', async () => {
  const h = await harness({ contactOverrides: { smsEnabled: false } });
  await h.service.handleTestCall({ requestId: 'test-request-1', organizationId: 'org', phoneNumber: '+15559876543' });
  await h.service.handleTestCall({ requestId: 'test-request-1', organizationId: 'org', phoneNumber: '+15559876543' });
  const testCalls = h.calls.filter((call) => call.input.metadata.testCall === 'true');
  assert.equal(testCalls.length, 1);
  assert.equal(testCalls[0].input.recipient.id, 'test-recipient:test-request-1');
  assert.equal(testCalls[0].input.recipient.phoneNumber, '+15559876543');
  const recent = await h.communications.listRecent('org', 10);
  const communication = recent.find((item) => item.communicationType === 'TEST');
  assert.equal(communication.incidentId, 'test-call:test-request-1');
  assert.equal(communication.status, 'PENDING');
  assert.equal(communication.maskedPhoneNumber.endsWith('6543'), true);
  assert.doesNotMatch(JSON.stringify(communication),/15559876543/);
});

test('Retell connection check masks the outbound number and never returns credentials', async () => {
  const provider = new RetellCommunicationProvider(
    { apiKey: 'super-secret', fromNumber: '+15551234567', voiceAgentId: 'agent', smsAgentId: 'sms' },
    {
      call: { async createPhoneCall() {}, async retrieve() {} },
      agent: { async retrieve() { return { agent_id: 'agent' }; } },
      phoneNumber: { async retrieve() { return { phone_number: '+15551234567' }; } },
    },
  );
  const result = await provider.checkConnection();
  assert.equal(result.connected, true);
  assert.equal(result.maskedFromNumber.endsWith('4567'), true);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|15551234567/);
});
