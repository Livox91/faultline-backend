import { Injectable } from '@nestjs/common';
import type { Incident } from '@faultline/incidents';
import type { IncidentCommunicationState } from '@faultline/notifications';
import { redactSensitiveText } from '@faultline/platform';
import type { SlackPostMessageInput } from './slack.client';
import type { SlackTimelineUpdate } from './slack-incident-timeline.mapper';

export interface SlackIncidentMessage
  extends Omit<SlackPostMessageInput, 'channel'> {}

@Injectable()
export class SlackMessageBuilder {
  buildIncidentCreatedMessage(
    incident: Incident,
    dashboardUrl?: string,
  ): SlackIncidentMessage {
    const services = affectedServices(incident);
    const dashboard = dashboardUrl
      ? new URL(
          `incidents/${encodeURIComponent(incident.id)}`,
          dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`,
        ).toString()
      : undefined;
    const summary = safeText(incident.summary, 500);
    const fields = [
      field('Severity', incident.severity),
      field('Status', incident.status),
      field('Detected', incident.firstSeen),
      field('Incident ID', incident.id),
      field('Affected services', services.length ? services.join(', ') : 'Not specified'),
    ];
    return {
      text: `[${incident.severity}] ${safeText(incident.title, 180)} (${incident.id})`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: safeText(incident.title, 150),
            emoji: true,
          },
        },
        { type: 'section', fields },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Summary*\n${escapeSlack(summary)}` },
        },
        ...(dashboard
          ? [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `<${dashboard}|Open incident in Faultline>`,
                },
              },
            ]
          : []),
      ],
    };
  }

  buildIncidentUpdatedMessage(
    incident: Incident,
    state: IncidentCommunicationState,
    dashboardUrl?: string,
  ): SlackIncidentMessage {
    const services = affectedServices(incident);
    const resolved = state === 'RESOLVED';
    const resolvedAt = incident.resolvedAt;
    const fields = [
      field('Severity', titleCase(incident.severity)),
      field('Status', titleCase(state)),
      field('Detected', incident.firstSeen),
      ...(resolved && resolvedAt
        ? [
            field('Resolved', resolvedAt),
            field('Resolution time', formatDuration(incident.firstSeen, resolvedAt)),
          ]
        : []),
      field('Incident ID', incident.id),
    ];
    const summary = safeText(
      resolved
        ? incident.confirmedRootCause ?? incident.serviceImpact ?? incident.summary
        : incident.serviceImpact ?? incident.summary,
      500,
    );
    const dashboard = dashboardUrl
      ? new URL(
          `incidents/${encodeURIComponent(incident.id)}`,
          dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`,
        ).toString()
      : undefined;
    return {
      text: `${resolved ? 'Resolved' : 'Updated'} incident: ${safeText(incident.title, 180)} (${incident.id})`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: resolved ? '✅ Resolved Incident' : 'Incident Update',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${escapeSlack(safeText(incident.title, 180))}*` },
        },
        { type: 'section', fields },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Affected services*\n${services.length ? services.map((service) => `• ${escapeSlack(safeText(service, 100))}`).join('\n') : 'Not specified'}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${resolved && incident.confirmedRootCause ? 'Root cause' : 'Summary'}*\n${escapeSlack(summary)}`,
          },
        },
        ...(dashboard
          ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${dashboard}|Open incident in Faultline>` } }]
          : []),
      ],
    };
  }

  buildTimelineUpdate(update: SlackTimelineUpdate): SlackIncidentMessage {
    const title = safeText(update.title, 180);
    const summary = update.summary ? safeText(update.summary, 500) : undefined;
    return {
      text: `${title} — ${update.timestamp}${summary ? `: ${summary}` : ''}`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlack(title)}*\n${escapeSlack(update.timestamp)}${summary ? `\n${escapeSlack(summary)}` : ''}`,
        },
      }],
    };
  }
}

function affectedServices(incident: Incident): string[] {
  return [
    ...new Set(
      [
        incident.logicalService,
        incident.primaryResource.workload,
        ...incident.affectedResources.map((resource) => resource.workload),
      ].filter((value): value is string => !!value),
    ),
  ].sort();
}

function titleCase(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(detectedAt: string, resolvedAt: string): string {
  const duration = Math.max(0, Date.parse(resolvedAt) - Date.parse(detectedAt));
  if (!Number.isFinite(duration)) return 'Not available';
  const seconds = Math.floor(duration / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`].filter(Boolean).join(' ');
}

function field(label: string, value: string): Readonly<Record<string, unknown>> {
  return {
    type: 'mrkdwn',
    text: `*${label}*\n${escapeSlack(safeText(value, 300))}`,
  };
}

function safeText(value: string, maximumLength: number): string {
  const redacted = redactSensitiveText(value)
    .replaceAll(/(?:^|[\r\n])\s*at\s+[^\r\n]*/g, '')
    .replaceAll(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;]+/g, '[REDACTED]')
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(/\s{2,}/g, ' ')
    .trim();
  return redacted.length <= maximumLength
    ? redacted
    : `${redacted.slice(0, maximumLength - 1)}…`;
}

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
