import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  INCIDENT_REPOSITORY,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  AUDIT_ACTIONS,
  hasProjectAccess,
  type AuthenticatedUser,
} from '@faultline/auth';
import {
  EXTERNAL_TICKET_REPOSITORY,
  SLACK_INTEGRATION_REPOSITORY,
  type ExternalTicket,
  type ExternalTicketRepository,
  type SlackIntegrationRepository,
} from '@faultline/notifications';
import type { ClusterDirectory } from '@faultline/database';
import { EVENT_TOPICS, QUEUE, type Queue } from '@faultline/queue';
import { AuditTrail } from './auth/audit-trail';
import { CurrentUser, type RequestWithUser } from './auth/context';
import { CLUSTER_DIRECTORY } from './clusters.controller';

export interface SlackTicketView {
  provider: 'slack';
  status: 'LINKED';
  channelId: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
}

/** Exposes only safe, read-only Slack ticket metadata for an incident. */
@Controller('incidents')
export class IncidentExternalTicketController {
  constructor(
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Inject(EXTERNAL_TICKET_REPOSITORY)
    private readonly tickets: ExternalTicketRepository,
    @Inject(SLACK_INTEGRATION_REPOSITORY)
    private readonly slackIntegrations: SlackIntegrationRepository,
    @Inject(CLUSTER_DIRECTORY)
    private readonly clusters: ClusterDirectory,
    @Inject(QUEUE) private readonly queue: Queue,
    private readonly audit: AuditTrail,
  ) {}

  @Get(':incidentId/external-tickets/slack')
  @Header('Cache-Control', 'no-store')
  async getSlackTicket(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ ticket: SlackTicketView | null }> {
    const incident = await this.incidents.getIncident(incidentId);
    if (!incident || !hasProjectAccess(actor, incident.clusterId))
      throw new NotFoundException('Incident not found');
    const ticket = await this.tickets.findByIncidentAndProvider(
      incidentId,
      'slack',
    );
    return { ticket: ticket ? toView(ticket) : null };
  }

  @Post(':incidentId/external-tickets/slack')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async createSlackTicket(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<
    | { status: 'LINKED'; ticket: SlackTicketView }
    | { status: 'REQUESTED'; ticket: null }
  > {
    const incident = await this.incidents.getIncident(incidentId);
    if (!incident || !hasProjectAccess(actor, incident.clusterId))
      throw new NotFoundException('Incident not found');
    const existing = await this.tickets.findByIncidentAndProvider(
      incidentId,
      'slack',
    );
    if (existing) return { status: 'LINKED', ticket: toView(existing) };

    const [slack, cluster] = await Promise.all([
      this.slackIntegrations.get(actor.organizationId),
      this.clusters.get(incident.clusterId, actor.organizationId),
    ]);
    const service = normalizeService(
      incident.logicalService ?? incident.primaryResource.workload,
    );
    const channelId =
      cluster?.slackChannelId ??
      (service ? slack?.serviceChannels[service] : undefined) ??
      slack?.incidentChannelId;
    if (!slack?.enabled || !slack.botToken || !channelId) {
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.SLACK_TICKET_REQUESTED,
        resourceType: 'incident',
        resourceId: incidentId,
        outcome: 'denied',
        request,
        metadata: {
          clusterId: incident.clusterId,
          reason: 'slack_not_configured',
        },
      });
      throw new ServiceUnavailableException({
        code: 'SLACK_NOT_CONFIGURED',
        message:
          'Slack is not configured for this incident. Configure and enable Slack with an available incident channel, then try again.',
      });
    }

    try {
      await this.queue.publish(EVENT_TOPICS.incidentTicketRequested, {
        id: `manual-slack-ticket:${incidentId}:${randomUUID()}`,
        payload: { incidentId },
        headers: {
          eventType: EVENT_TOPICS.incidentTicketRequested,
          schemaVersion: '1',
          source: 'faultline-api',
        },
      });
    } catch {
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.SLACK_TICKET_REQUESTED,
        resourceType: 'incident',
        resourceId: incidentId,
        outcome: 'denied',
        request,
        metadata: {
          clusterId: incident.clusterId,
          reason: 'queue_publish_failed',
        },
      });
      throw new ServiceUnavailableException(
        'Slack ticket creation could not be queued',
      );
    }
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.SLACK_TICKET_REQUESTED,
      resourceType: 'incident',
      resourceId: incidentId,
      request,
      metadata: { clusterId: incident.clusterId, provider: 'slack' },
    });
    return { status: 'REQUESTED', ticket: null };
  }
}

function normalizeService(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function toView(ticket: ExternalTicket): SlackTicketView {
  const url = safeSlackUrl(ticket.url);
  return {
    provider: 'slack',
    status: 'LINKED',
    channelId: ticket.channelId,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(url ? { url } : {}),
  };
}

function safeSlackUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'slack.com' && !url.hostname.endsWith('.slack.com'))
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
