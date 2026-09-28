import { Injectable } from '@nestjs/common';
import type { Incident } from '@faultline/incidents';
import type { SlackIntegration } from '@faultline/notifications';
import type { NotificationWorkerConfig } from './config';

@Injectable()
export class SlackIncidentChannelResolver {
  constructor(private readonly legacyConfig?: NotificationWorkerConfig) {}
  resolve(
    incident: Incident,
    slack?: SlackIntegration,
    clusterChannelId?: string,
  ): string | undefined {
    const settings = slack ?? (this.legacyConfig ? {
      organizationId: 'test',
      enabled: this.legacyConfig.slack.enabled,
      botToken: this.legacyConfig.slack.botToken,
      incidentChannelId: this.legacyConfig.slack.incidentChannelId,
      serviceChannels: this.legacyConfig.slack.serviceChannels,
      createdAt: '', updatedAt: '',
    } : undefined);
    if (!settings) return undefined;
    if (clusterChannelId) return clusterChannelId;
    const service = selectedService(incident);
    if (!service) return settings.incidentChannelId;

    const serviceChannel = settings.serviceChannels[service];
    if (serviceChannel) return serviceChannel;

    const legacyTeam = this.legacyConfig?.slack.serviceOwners[service];
    return (legacyTeam ? this.legacyConfig?.slack.teamChannels[legacyTeam.toLowerCase()] : undefined)
      ?? settings.incidentChannelId;
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
