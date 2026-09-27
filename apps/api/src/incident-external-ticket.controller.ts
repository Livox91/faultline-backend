import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  INCIDENT_REPOSITORY,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  EXTERNAL_TICKET_REPOSITORY,
  type ExternalTicket,
  type ExternalTicketRepository,
} from '@faultline/notifications';

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
  ) {}

  @Get(':incidentId/external-tickets/slack')
  @Header('Cache-Control', 'no-store')
  async getSlackTicket(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
  ): Promise<{ ticket: SlackTicketView | null }> {
    if (!(await this.incidents.getIncident(incidentId)))
      throw new NotFoundException('Incident not found');
    const ticket = await this.tickets.findByIncidentAndProvider(
      incidentId,
      'slack',
    );
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
