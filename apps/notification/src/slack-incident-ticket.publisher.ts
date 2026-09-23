import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_TICKET_REPOSITORY,
  IDEMPOTENCY_STORE,
  type ExternalTicket,
  type ExternalTicketRepository,
  type IdempotencyStore,
  type IncidentTicketPayload,
  type IncidentTicketPublisher,
  type IncidentTicketUpdatePayload,
  type IncidentLifecycleEvent,
} from '@faultline/notifications';
import { ApplicationLogger } from '@faultline/platform';
import {
  INCIDENT_REPOSITORY,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  NOTIFICATION_CONFIG,
  type NotificationWorkerConfig,
} from './config';
import { SlackApiError, SLACK_CLIENT, type SlackClient } from './slack.client';
import { SlackMessageBuilder } from './slack-message-builder';
import { SlackIncidentChannelResolver } from './slack-incident-channel.resolver';
import { SlackIncidentTimelineMapper } from './slack-incident-timeline.mapper';

@Injectable()
export class SlackIncidentTicketPublisher implements IncidentTicketPublisher {
  constructor(
    @Inject(NOTIFICATION_CONFIG)
    private readonly config: NotificationWorkerConfig,
    @Inject(SLACK_CLIENT) private readonly slack: SlackClient,
    private readonly messages: SlackMessageBuilder,
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Inject(EXTERNAL_TICKET_REPOSITORY)
    private readonly tickets: ExternalTicketRepository,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
    private readonly channels: SlackIncidentChannelResolver,
    private readonly timeline: SlackIncidentTimelineMapper = new SlackIncidentTimelineMapper(),
    @Optional() private readonly logger?: ApplicationLogger,
  ) {}

  async createIncidentTicket(
    payload: IncidentTicketPayload,
  ): Promise<ExternalTicket | undefined> {
    try {
      return await this.create(payload);
    } catch (error) {
      this.failure('slack.ticket.create_failed', payload.incidentId, error);
      return undefined;
    }
  }

  private async create(
    payload: IncidentTicketPayload,
  ): Promise<ExternalTicket | undefined> {
    const slack = this.config.slack;
    if (!slack.enabled) return undefined;

    // Always publish the durable aggregate, never a broker payload or raw telemetry.
    const incident = await this.incidents.getIncident(payload.incidentId);
    if (!incident || !incident.classification) return undefined;
    const channel = this.channels.resolve(incident);
    if (!channel) return undefined;

    const existing = await this.tickets.findByIncidentAndProvider(
      incident.id,
      'slack',
    );
    if (existing) return existing;

    const key = `slack:incident-ticket:${incident.id}`;
    if (!(await this.idempotency.claim(key))) {
      return this.tickets.findByIncidentAndProvider(incident.id, 'slack');
    }
    let posted;
    try {
      const message = this.messages.buildIncidentCreatedMessage(
        incident,
        slack.dashboardUrl,
      );
      posted = await this.slack.postMessage({
        channel,
        ...message,
      });
    } catch (error) {
      await this.idempotency.release(key).catch(() => undefined);
      this.failure('slack.ticket.create_failed', incident.id, error, {
        channelId: channel,
      });
      return undefined;
    }

    const now = new Date().toISOString();
    const ticket: ExternalTicket = {
      id: randomUUID(),
      provider: 'slack',
      externalMessageId: posted.timestamp,
      incidentId: incident.id,
      channelId: posted.channel,
      createdAt: now,
      updatedAt: now,
      url: `https://slack.com/archives/${encodeURIComponent(posted.channel)}/p${posted.timestamp.replace('.', '')}`,
    };
    // Do not release the claim if persistence fails after Slack accepted the post:
    // a retry must not knowingly create a second top-level message.
    const persisted = await this.tickets.saveIfAbsent(ticket);
    await this.idempotency.release(key);
    this.success('slack.ticket.created', incident.id, persisted);
    return persisted;
  }

  async updateIncidentTicket(
    payload: IncidentTicketUpdatePayload,
  ): Promise<ExternalTicket | undefined> {
    if (!this.config.slack.enabled) return undefined;
    let ticket: ExternalTicket | undefined;
    try {
      const incident = await this.incidents.getIncident(payload.incidentId);
      if (!incident) return undefined;
      ticket = await this.tickets.findByIncidentAndProvider(
        incident.id,
        'slack',
      );
      if (!ticket) return undefined;
      const message = this.messages.buildIncidentUpdatedMessage(
        incident,
        payload.state,
        this.config.slack.dashboardUrl,
      );
      await this.slack.updateMessage({
        channel: ticket.channelId,
        timestamp: ticket.externalMessageId,
        ...message,
      });
      const updated = (await this.tickets.markUpdated(ticket.id, new Date().toISOString())) ?? ticket;
      this.success('slack.ticket.updated', incident.id, updated);
      return updated;
    } catch (error) {
      this.failure('slack.ticket.update_failed', payload.incidentId, error,
        ticket ? {
          channelId: ticket.channelId,
          externalMessageId: ticket.externalMessageId,
        } : {},
      );
      return undefined;
    }
  }

  async publishTimelineUpdates(event: IncidentLifecycleEvent): Promise<void> {
    if (!this.config.slack.enabled) return;
    let ticket: ExternalTicket | undefined;
    try {
      ticket = await this.tickets.findByIncidentAndProvider(event.incident.id, 'slack');
    } catch (error) {
      this.failure('slack.thread.publish_failed', event.incident.id, error, {
        eventId: event.id,
      });
      return;
    }
    if (!ticket) return;

    for (const update of this.timeline.map(event)) {
      const key = `slack:timeline:${ticket.id}:${update.id}`;
      try {
        if (!(await this.idempotency.claim(key))) continue;
      } catch (error) {
        this.failure('slack.thread.publish_failed', event.incident.id, error, {
          channelId: ticket.channelId,
          externalMessageId: ticket.externalMessageId,
          eventId: update.id,
        });
        continue;
      }
      try {
        await this.slack.postThreadReply({
          channel: ticket.channelId,
          threadTimestamp: ticket.externalMessageId,
          ...this.messages.buildTimelineUpdate(update),
        });
        this.logger?.log({
          event: 'slack.thread.published',
          incidentId: event.incident.id,
          channelId: ticket.channelId,
          externalMessageId: ticket.externalMessageId,
          eventId: update.id,
        });
      } catch (error) {
        await this.idempotency.release(key).catch(() => undefined);
        this.failure('slack.thread.publish_failed', event.incident.id, error, {
          channelId: ticket.channelId,
          externalMessageId: ticket.externalMessageId,
          eventId: update.id,
        });
      }
    }
  }

  private success(event:string,incidentId:string,ticket:ExternalTicket):void {
    this.logger?.log({
      event,
      incidentId,
      channelId:ticket.channelId,
      externalMessageId:ticket.externalMessageId,
    });
  }

  private failure(
    event:string,
    incidentId:string,
    error:unknown,
    context:Readonly<Record<string,string>>={},
  ):void {
    this.logger?.warn({
      event,
      incidentId,
      ...context,
      errorCode:error instanceof SlackApiError?error.code:'unexpected_error',
      retryable:error instanceof SlackApiError?error.transient:false,
    });
  }
}
