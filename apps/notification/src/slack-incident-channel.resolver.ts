import { Inject, Injectable } from '@nestjs/common';
import type { Incident } from '@faultline/incidents';
import {
  NOTIFICATION_CONFIG,
  type NotificationWorkerConfig,
} from './config';

@Injectable()
export class SlackIncidentChannelResolver {
  constructor(
    @Inject(NOTIFICATION_CONFIG)
    private readonly config: NotificationWorkerConfig,
  ) {}

  resolve(incident: Incident): string | undefined {
    const slack = this.config.slack;
    const service = selectedService(incident);
    if (!service) return slack.incidentChannelId;

    const serviceChannel = slack.serviceChannels[service];
    if (serviceChannel) return serviceChannel;

    const team = slack.serviceOwners[service];
    const teamChannel = team ? slack.teamChannels[team.toLowerCase()] : undefined;
    return teamChannel ?? slack.incidentChannelId;
  }
}

function selectedService(incident: Incident): string | undefined {
  const primary = normalize(incident.logicalService) ??
    normalize(incident.primaryResource.workload);
  if (primary) return primary;
  return incident.affectedResources
    .map((resource) => normalize(resource.workload))
    .filter((service): service is string => !!service)
    .sort(compare)[0];
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
