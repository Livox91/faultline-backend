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
import { AUDIT_ACTIONS, type AuthenticatedUser } from '@faultline/auth';
import {
  INCIDENT_REPOSITORY,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  EXTERNAL_TICKET_REPOSITORY,
  type ExternalTicket,
  type ExternalTicketRepository,
} from '@faultline/notifications';
import { AuditTrail } from './auth/audit-trail';
import { CurrentUser, type RequestWithUser } from './auth/context';
import { EVENT_TOPICS, QUEUE, type Queue } from '@faultline/queue';

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
    private readonly audit: AuditTrail,
    @Inject(QUEUE) private readonly queue: Queue,
  ) {}

  @Get(':incidentId/external-tickets/slack')
  @Header('Cache-Control', 'no-store')
  async getSlackTicket(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<{ ticket: SlackTicketView | null }> {
    if (!(await this.incidents.getIncident(incidentId)))
      throw new NotFoundException('Incident not found');
    const ticket = await this.tickets.findByIncidentAndProvider(
      incidentId,
      'slack',
    );
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.SLACK_TICKET_REQUESTED,
      resourceType: 'incident',
      resourceId: incidentId,
      request,
      metadata: { found: !!ticket },
    });
    return { ticket: ticket ? toView(ticket) : null };
  }

  @Post(':incidentId/external-tickets/slack')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async createSlackTicket(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
  ): Promise<
    | { status: 'LINKED'; ticket: SlackTicketView }
    | { status: 'REQUESTED'; ticket: null }
  > {
    if (!(await this.incidents.getIncident(incidentId)))
      throw new NotFoundException('Incident not found');
    const existing = await this.tickets.findByIncidentAndProvider(
      incidentId,
      'slack',
    );
    if (existing) return { status: 'LINKED', ticket: toView(existing) };

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
      throw new ServiceUnavailableException(
        'Slack ticket creation could not be queued',
      );
    }
    return { status: 'REQUESTED', ticket: null };
  }
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
