import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
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
