import { Injectable } from '@nestjs/common';
import type { IncidentTimelineEntry } from '@faultline/incidents';
import type { IncidentLifecycleEvent } from '@faultline/notifications';

export interface SlackTimelineUpdate {
  id: string;
  timestamp: string;
  title: string;
  summary?: string;
}

@Injectable()
export class SlackIncidentTimelineMapper {
  map(event: IncidentLifecycleEvent): readonly SlackTimelineUpdate[] {
    const updates = [
      ...this.lifecycle(event),
      ...event.incident.timeline.flatMap((entry) => this.incidentEntry(entry)),
    ];
    return [...new Map(updates.map((update) => [update.id, update])).values()]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  }

  private lifecycle(event: IncidentLifecycleEvent): SlackTimelineUpdate[] {
    if (event.type === 'INCIDENT_ACKNOWLEDGED')
      return [update(event, 'Incident acknowledged')];
    if (event.type === 'INCIDENT_RESOLVED')
      return [update(
        event,
        'Incident resolved',
        event.incident.confirmedRootCause ?? event.incident.serviceImpact ?? event.incident.summary,
      )];

    const updates: SlackTimelineUpdate[] = [];
    if (
      event.changedFields.includes('confirmedRootCause') &&
      event.incident.confirmedRootCause
    )
      updates.push(update(event, 'Root cause identified', event.incident.confirmedRootCause, 'root-cause'));

    if (
      event.type === 'INCIDENT_STATUS_CHANGED' &&
      event.state !== event.previousState
    ) {
      const title = stateTitle(event.state);
      if (title)
        updates.push(update(
          event,
          title,
          event.incident.serviceImpact ?? event.incident.summary,
          `state:${event.state}`,
        ));
    }
    return updates;
  }

  private incidentEntry(entry: IncidentTimelineEntry): SlackTimelineUpdate[] {
    if (
      entry.type === 'ANOMALY_ACTIVE' ||
      (entry.severity !== 'HIGH' && entry.severity !== 'CRITICAL')
    ) return [];
    return [{
      id: `incident-timeline:${entry.id}`,
      timestamp: entry.timestamp,
      title: entry.type === 'ANOMALY_RESOLVED'
        ? 'Significant signal recovered'
        : 'Significant anomaly detected',
      summary: entry.summary,
    }];
  }
}

function update(
  event: IncidentLifecycleEvent,
  title: string,
  summary?: string,
  suffix = 'event',
): SlackTimelineUpdate {
  return {
    id: `lifecycle:${event.id}:${suffix}`,
    timestamp: event.occurredAt,
    title,
    ...(summary ? { summary } : {}),
  };
}

function stateTitle(state: IncidentLifecycleEvent['state']): string | undefined {
  switch (state) {
    case 'INVESTIGATING': return 'Investigation started';
    case 'IDENTIFIED': return 'Suspected cause identified';
    case 'MITIGATING': return 'Mitigation in progress';
    case 'MONITORING': return 'Mitigation applied; monitoring recovery';
    default: return undefined;
  }
}
