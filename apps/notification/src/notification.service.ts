import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { INCIDENT_REPOSITORY, type Incident, type IncidentRepository } from '@faultline/incidents';
import type { ClusterDirectory } from '@faultline/database';
import {
  COMMUNICATION_PROVIDER,
  IDEMPOTENCY_STORE,
  INCIDENT_COMMUNICATION_REPOSITORY,
  INCIDENT_NOTIFICATION_STATE_REPOSITORY,
  NOTIFICATION_ATTEMPTS,
  NOTIFICATION_AUDIT_REPOSITORY,
  NOTIFICATION_POLICY,
  type CommunicationProvider,
  type IdempotencyStore,
  type IncidentCommunication,
  type IncidentCommunicationRepository,
  type IncidentNotificationState,
  type IncidentNotificationStateRepository,
  type NotificationAttempt,
  type NotificationAttemptRepository,
  type NotificationAuditEventType,
  type NotificationAuditRepository,
  type NotificationPolicy,
  type NotificationStatus,
} from '@faultline/notifications';
import { ApplicationLogger } from '@faultline/platform';
import { ClusterRecipientResolver, type DirectRecipient } from './cluster-recipient.resolver';
import { IncidentMessageBuilder } from './message-builder';
import { NOTIFICATION_CLUSTER_DIRECTORY } from './slack-incident-ticket.publisher';

const terminal = new Set<NotificationStatus>(['FAILED', 'NO_ANSWER', 'CANCELLED', 'DECLINED']);

@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_POLICY) private readonly notificationPolicy: NotificationPolicy,
    private readonly resolver: ClusterRecipientResolver,
    @Inject(COMMUNICATION_PROVIDER) private readonly provider: CommunicationProvider,
    @Inject(NOTIFICATION_ATTEMPTS) private readonly attempts: NotificationAttemptRepository,
    @Inject(INCIDENT_NOTIFICATION_STATE_REPOSITORY) private readonly states: IncidentNotificationStateRepository,
    @Inject(NOTIFICATION_AUDIT_REPOSITORY) private readonly audit: NotificationAuditRepository,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
    private readonly messages: IncidentMessageBuilder,
    private readonly logger: ApplicationLogger,
    @Inject(INCIDENT_COMMUNICATION_REPOSITORY)
    private readonly communications: IncidentCommunicationRepository,
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Optional() @Inject(NOTIFICATION_CLUSTER_DIRECTORY)
    private readonly clusters?: ClusterDirectory,
  ) {}

  async handleIncident(incident: Incident, organizationId: string): Promise<void> {
    if (incident.status === 'RESOLVED') {
      await this.resolve(incident.id);
      return;
    }
    if (!this.notificationPolicy.shouldNotify(incident)) return;
    const existing = await this.states.get(incident.id);
    if (existing && (existing.status !== 'ACTIVE' || existing.recipientIds.length)) return;

    const resolution = await this.resolver.resolve(incident.clusterId, organizationId);
    const clusterName =
      (await this.clusters?.get(incident.clusterId, organizationId))?.name ??
      incident.clusterId;
    const now = new Date().toISOString();
    const state: IncidentNotificationState = {
      incidentId: incident.id,
      clusterId: incident.clusterId,
      organizationId,
      recipientIds: resolution.recipients.map((item) => item.recipient.id),
      fallbackUsed: resolution.fallbackUsed,
      status: 'ACTIVE',
      startedAt: now,
      updatedAt: now,
    };
    await this.states.save(state);
    await this.record(incident.id, 'DIRECT_NOTIFICATION_STARTED', {
      details: { clusterId: incident.clusterId, recipientCount: resolution.recipients.length },
    });
    if (resolution.fallbackUsed)
      await this.record(incident.id, 'ADMIN_FALLBACK_USED', {
        details: { clusterId: incident.clusterId },
      });
    for (const skipped of resolution.skipped)
      await this.record(incident.id, 'CONTACT_SKIPPED', {
        contactId: skipped.referenceId,
        details: { reason: skipped.reason },
      });
    await Promise.all(
      resolution.recipients.map((recipient) =>
        this.dispatch(incident, recipient, clusterName, organizationId),
      ),
    );
  }

  async processProviderEvent(event: { requestId: string; status: NotificationStatus; metadata?: Readonly<Record<string, unknown>> }): Promise<void> {
    const current = await this.attempts.findByProviderRequestId(event.requestId);
    if (!current) return;
    const result = await this.attempts.updateStatus(
      current.id,
      event.status,
      terminal.has(event.status) || event.status === 'DELIVERED' ? new Date().toISOString() : undefined,
      event.metadata,
    );
    const attempt = result.attempt;
    const communication = await this.communications.findByProviderRequestId(
      event.requestId,
    );
    if (communication && communication.status !== attempt.status)
        await this.communications.save({
          ...communication,
          status: attempt.status,
          ...(['ANSWERED', 'ACKNOWLEDGED', 'COMPLETED', 'DELIVERED'].includes(attempt.status)
            ? { sentAt: new Date().toISOString() }
            : {}),
        });
    if (!result.changed) return;
    if (event.status === 'ANSWERED') {
      await this.record(attempt.incidentId, 'VOICE_CALL_ANSWERED', { attemptId: attempt.id, contactId: attempt.recipientId });
      await this.record(attempt.incidentId, 'ACKNOWLEDGEMENT_REQUESTED', { attemptId: attempt.id, contactId: attempt.recipientId });
    }
    if (terminal.has(event.status)) {
      await this.record(attempt.incidentId, 'CALL_FAILED', {
        attemptId: attempt.id,
        contactId: attempt.recipientId,
        details: { status: event.status },
      });
      if (attempt.channel === 'VOICE' && attempt.recipientSource === 'ASSIGNED_SRE')
        await this.fallbackToAdmin(attempt.incidentId, event.status);
    }
  }

  async fallbackToAdmin(incidentId: string, reason: string): Promise<void> {
    const state = await this.states.get(incidentId);
    if (!state || state.status !== 'ACTIVE') return;
    if (!(await this.idempotency.claim(`direct:${incidentId}:admin-fallback`))) return;
    const incident = await this.incidents.getIncident(incidentId);
    if (!incident || incident.status === 'RESOLVED') return;
    const resolution = await this.resolver.resolveAdmin(state.organizationId);
    const clusterName =
      (await this.clusters?.get(incident.clusterId, state.organizationId))?.name ??
      incident.clusterId;
    await this.states.save({
      ...state,
      recipientIds: [...new Set([...state.recipientIds, ...resolution.recipients.map((item) => item.recipient.id)])],
      fallbackUsed: true,
      updatedAt: new Date().toISOString(),
    });
    await this.record(incidentId, 'ADMIN_FALLBACK_USED', {
      details: { clusterId: incident.clusterId, reason },
    });
    for (const skipped of resolution.skipped)
      await this.record(incidentId, 'CONTACT_SKIPPED', {
        contactId: skipped.referenceId,
        details: { reason: skipped.reason, source: 'ADMIN_FALLBACK' },
      });
    await Promise.all(
      resolution.recipients.map((recipient) =>
        this.dispatch(incident, recipient, clusterName, state.organizationId),
      ),
    );
  }

  private async dispatch(
    incident: Incident,
    target: DirectRecipient,
    clusterName: string,
    organizationId: string,
  ): Promise<void> {
    await this.record(incident.id, 'RECIPIENT_RESOLVED', {
      contactId: target.recipient.id,
      details: { source: target.source },
    });
    await Promise.all(
      target.channels.map((channel) =>
        this.send(incident, target, channel, clusterName, organizationId),
      ),
    );
  }

  private async send(
    incident: Incident,
    target: DirectRecipient,
    channel: 'VOICE' | 'SMS',
    clusterName: string,
    organizationId: string,
  ): Promise<void> {
    const key = `direct:${incident.id}:${target.recipient.id}:${channel}`;
    if (!(await this.idempotency.claim(key))) return;
    const now = new Date().toISOString();
    let attempt: NotificationAttempt = {
      id: randomUUID(),
      incidentId: incident.id,
      clusterId: incident.clusterId,
      recipientId: target.recipient.id,
      recipientSource: target.source,
      channel,
      provider: this.provider.name,
      status: 'PENDING',
      createdAt: now,
    };
    await this.attempts.save(attempt);
    let communication: IncidentCommunication = {
      id: randomUUID(),
      incidentId: incident.id,
      organizationId,
      audience: target.recipient.audience,
      channel,
      recipientId: target.recipient.id,
      communicationType: 'INITIAL',
      messageVersion: 'direct-retell-v1',
      status: 'PENDING',
      createdAt: now,
      dedupeKey: key,
    };
    await this.communications.save(communication);
    try {
      const message = this.messages.build(incident, target.recipient.audience);
      const metadata = { incidentId: incident.id, notificationAttemptId: attempt.id, recipientId: target.recipient.id };
      const result = channel === 'VOICE'
        ? await this.provider.startVoiceCall({
            recipient: target.recipient,
            message,
            metadata,
            context: {
              incident_id: incident.id,
              notification_attempt_id: attempt.id,
              recipient_id: target.recipient.id,
              severity: incident.severity,
              affected_service: incident.primaryResource.workload ?? '',
              cluster: incident.clusterId,
              cluster_name: clusterName,
              environment: incident.namespace ?? '',
              status: incident.status,
              incident_status: incident.status,
            },
          })
        : await this.provider.sendSms({ recipient: target.recipient, message, metadata });
      attempt = { ...attempt, providerRequestId: result.requestId, status: result.status, startedAt: now };
      await this.attempts.save(attempt);
      communication = {
        ...communication,
        providerRequestId: result.requestId,
        // A Retell call id means the outbound call was registered, not answered.
        status: channel === 'VOICE' ? 'PENDING' : 'SENT',
        ...(channel === 'SMS' ? { sentAt: now } : {}),
      };
      await this.communications.save(communication);
      await this.record(incident.id, channel === 'VOICE' ? 'CALL_REQUESTED' : 'SMS_REQUESTED', {
        contactId: target.recipient.id,
        attemptId: attempt.id,
      });
    } catch (error) {
      attempt = {
        ...attempt,
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message : 'Provider failure',
      };
      await this.attempts.save(attempt);
      await this.communications.save({ ...communication, status: 'FAILED' });
      this.logger.error({ event: 'notification_failed', incident_id: incident.id, attempt_id: attempt.id });
      await this.record(incident.id, 'CALL_FAILED', {
        attemptId: attempt.id,
        contactId: attempt.recipientId,
        details: { channel },
      });
      if (channel === 'VOICE' && target.source === 'ASSIGNED_SRE')
        await this.fallbackToAdmin(incident.id, 'PROVIDER_REQUEST_FAILED');
    }
  }

  async handleTestCall(request: { requestId:string; organizationId:string; userId:string }): Promise<void> {
    const resolution=await this.resolver.resolveAdminUser(request.userId,request.organizationId);
    const target=resolution.recipients[0];
    if(!target||!target.channels.includes('VOICE'))throw new Error('Admin does not have a callable voice contact');
    const key=`test-call:${request.requestId}`;
    if(!(await this.idempotency.claim(key)))return;
    const now=new Date().toISOString();
    const incidentId=`test-call:${request.requestId}`;
    let attempt:NotificationAttempt={id:randomUUID(),incidentId,clusterId:'TEST',recipientId:target.recipient.id,recipientSource:'ADMIN_FALLBACK',channel:'VOICE',provider:this.provider.name,status:'PENDING',createdAt:now};
    await this.attempts.save(attempt);
    let communication:IncidentCommunication={id:randomUUID(),incidentId,organizationId:request.organizationId,audience:'ENGINEERING',channel:'VOICE',recipientId:target.recipient.id,communicationType:'TEST',messageVersion:'retell-test-v1',status:'PENDING',createdAt:now,dedupeKey:key};
    await this.communications.save(communication);
    try{
      const result=await this.provider.startVoiceCall({recipient:target.recipient,message:'This is a Faultline test alert. No production incident has occurred.',metadata:{testCall:'true',requestId:request.requestId,notificationAttemptId:attempt.id,recipientId:target.recipient.id},context:{incident_id:incidentId,notification_attempt_id:attempt.id,recipient_id:target.recipient.id,severity:'TEST',affected_service:'Connectivity test',cluster:'TEST',cluster_name:'Voice Agent Test',environment:'test',status:'TEST',incident_status:'TEST'}});
      attempt={...attempt,providerRequestId:result.requestId,status:result.status,startedAt:now};
      communication={...communication,providerRequestId:result.requestId,status:'PENDING'};
      await this.attempts.save(attempt);await this.communications.save(communication);
    }catch(error){
      const completedAt=new Date().toISOString();
      await this.attempts.save({...attempt,status:'FAILED',completedAt,failureReason:error instanceof Error?error.message:'Provider failure'});
      await this.communications.save({...communication,status:'FAILED'});
      throw error;
    }
  }

  private async resolve(incidentId: string): Promise<void> {
    const state = await this.states.get(incidentId);
    if (!state || state.status === 'RESOLVED') return;
    const now = new Date().toISOString();
    await this.states.save({ ...state, status: 'RESOLVED', completedAt: now, updatedAt: now });
    await this.record(incidentId, 'INCIDENT_RESOLVED', {});
  }

  private record(incidentId: string, type: NotificationAuditEventType, extra: Record<string, unknown>) {
    return this.audit.append({ id: randomUUID(), incidentId, type, timestamp: new Date().toISOString(), ...extra });
  }
}
