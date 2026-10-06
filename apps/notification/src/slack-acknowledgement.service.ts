import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { INCIDENT_REPOSITORY, type IncidentRepository } from '@faultline/incidents';
import {
  EXTERNAL_TICKET_REPOSITORY,
  IDEMPOTENCY_STORE,
  INCIDENT_ACKNOWLEDGEMENTS,
  INCIDENT_NOTIFICATION_STATE_REPOSITORY,
  NOTIFICATION_AUDIT_REPOSITORY,
  type ExternalTicketRepository,
  type IdempotencyStore,
  type IncidentAcknowledgementRepository,
  type IncidentNotificationStateRepository,
  type NotificationAuditRepository,
} from '@faultline/notifications';
import { EVENT_TOPICS, QUEUE, type Queue } from '@faultline/queue';

export interface SlackAcknowledgementSignal {
  eventId: string;
  channelId: string;
  messageTimestamp: string;
  userId: string;
  occurredAt: string;
  source: 'REPLY' | 'REACTION';
}

export type SlackAcknowledgementResult =
  | 'ACKNOWLEDGED'
  | 'ALREADY_ACKNOWLEDGED'
  | 'INCIDENT_RESOLVED'
  | 'TICKET_NOT_FOUND'
  | 'DUPLICATE';

@Injectable()
export class SlackAcknowledgementService {
  constructor(
    @Inject(EXTERNAL_TICKET_REPOSITORY)
    private readonly tickets: ExternalTicketRepository,
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Inject(INCIDENT_ACKNOWLEDGEMENTS)
    private readonly acknowledgements: IncidentAcknowledgementRepository,
    @Inject(INCIDENT_NOTIFICATION_STATE_REPOSITORY)
    private readonly states: IncidentNotificationStateRepository,
    @Inject(NOTIFICATION_AUDIT_REPOSITORY)
    private readonly audit: NotificationAuditRepository,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
    @Inject(QUEUE) private readonly queue: Queue,
  ) {}

  async acknowledge(signal: SlackAcknowledgementSignal): Promise<SlackAcknowledgementResult> {
    const key = `slack:acknowledgement:${signal.eventId}`;
    if (!(await this.idempotency.claim(key))) return 'DUPLICATE';
    try {
      const ticket = await this.tickets.findByProviderMessage(
        'slack',
        signal.channelId,
        signal.messageTimestamp,
      );
      if (!ticket) return 'TICKET_NOT_FOUND';
      const incident = await this.incidents.getIncident(ticket.incidentId);
      if (!incident || incident.status === 'RESOLVED') return 'INCIDENT_RESOLVED';
      if (await this.acknowledgements.get(incident.id)) return 'ALREADY_ACKNOWLEDGED';

      const acknowledgement = {
        incidentId: incident.id,
        acknowledgedBy: `slack:${signal.userId}`,
        acknowledgedAt: signal.occurredAt,
        slackEventId: signal.eventId,
        channel: 'SLACK' as const,
        note: `Acknowledged from Slack ${signal.source.toLowerCase()}`,
      };
      const saved = await this.acknowledgements.save(acknowledgement);
      if (saved.slackEventId !== signal.eventId) return 'ALREADY_ACKNOWLEDGED';

      const state = await this.states.get(incident.id);
      if (state?.status === 'ACTIVE') {
        await this.states.save({
          ...state,
          status: 'ACKNOWLEDGED',
          completedAt: signal.occurredAt,
          updatedAt: signal.occurredAt,
        });
      }
      await this.audit.append({
        id: randomUUID(),
        incidentId: incident.id,
        type: 'INCIDENT_ACKNOWLEDGED',
        timestamp: signal.occurredAt,
        details: {
          channel: 'SLACK',
          slackEventId: signal.eventId,
          slackUserId: signal.userId,
          source: signal.source,
        },
      });
      if (state?.status === 'ACTIVE') {
        await this.audit.append({
          id: randomUUID(),
          incidentId: incident.id,
          type: 'NOTIFICATION_STOPPED',
          timestamp: signal.occurredAt,
          details: { reason: 'ACKNOWLEDGED', channel: 'SLACK' },
        });
      }
      await this.queue.publish(EVENT_TOPICS.incidentsLifecycle, {
        id: `${incident.id}:INCIDENT_ACKNOWLEDGED:${signal.eventId}`,
        payload: {
          id: `${incident.id}:INCIDENT_ACKNOWLEDGED:${signal.eventId}`,
          type: 'INCIDENT_ACKNOWLEDGED',
          incident,
          state: 'ACKNOWLEDGED',
          occurredAt: signal.occurredAt,
          changedFields: ['acknowledgement'],
        },
      }).catch(() => undefined);
      return 'ACKNOWLEDGED';
    } catch (error) {
      await this.idempotency.release(key).catch(() => undefined);
      throw error;
    }
  }
}
