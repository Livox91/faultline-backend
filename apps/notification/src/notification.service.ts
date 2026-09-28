import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Incident } from '@faultline/incidents';
import {
  COMMUNICATION_PROVIDER,
  IDEMPOTENCY_STORE,
  INCIDENT_NOTIFICATION_STATE_REPOSITORY,
  NOTIFICATION_ATTEMPTS,
  NOTIFICATION_AUDIT_REPOSITORY,
  NOTIFICATION_POLICY,
  type CommunicationProvider,
  type IdempotencyStore,
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

const terminal = new Set<NotificationStatus>(['FAILED', 'NO_ANSWER', 'CANCELLED']);

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
    await Promise.all(resolution.recipients.map((recipient) => this.dispatch(incident, recipient)));
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
    if (!result.changed) return;
    const attempt = result.attempt;
    if (event.status === 'ANSWERED') {
      await this.record(attempt.incidentId, 'VOICE_CALL_ANSWERED', { attemptId: attempt.id, contactId: attempt.recipientId });
      await this.record(attempt.incidentId, 'ACKNOWLEDGEMENT_REQUESTED', { attemptId: attempt.id, contactId: attempt.recipientId });
    }
    if (terminal.has(event.status))
      await this.record(attempt.incidentId, 'CALL_FAILED', {
        attemptId: attempt.id,
        contactId: attempt.recipientId,
        details: { status: event.status },
      });
  }

  private async dispatch(incident: Incident, target: DirectRecipient): Promise<void> {
    await this.record(incident.id, 'RECIPIENT_RESOLVED', {
      contactId: target.recipient.id,
      details: { source: target.source },
    });
    await Promise.all(target.channels.map((channel) => this.send(incident, target, channel)));
  }

  private async send(incident: Incident, target: DirectRecipient, channel: 'VOICE' | 'SMS'): Promise<void> {
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
              environment: incident.namespace ?? '',
              status: incident.status,
            },
          })
        : await this.provider.sendSms({ recipient: target.recipient, message, metadata });
      attempt = { ...attempt, providerRequestId: result.requestId, status: result.status, startedAt: now };
      await this.attempts.save(attempt);
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
      this.logger.error({ event: 'notification_failed', incident_id: incident.id, attempt_id: attempt.id });
      await this.record(incident.id, 'CALL_FAILED', {
        attemptId: attempt.id,
        contactId: attempt.recipientId,
        details: { channel },
      });
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
