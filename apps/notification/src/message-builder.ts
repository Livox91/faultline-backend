import { Injectable } from '@nestjs/common';
import type { Incident } from '@faultline/incidents';
import type { IncidentLifecycleEvent, NotificationAudience } from '@faultline/notifications';

@Injectable()
export class IncidentMessageBuilder {
  buildLifecycle(event:IncidentLifecycleEvent,audience:NotificationAudience):string {
    const incident=event.incident;
    const publicService=incident.logicalService??'affected service';
    const engineeringService=incident.logicalService??incident.primaryResource.workload??'affected workload';
    const eta=incident.estimatedRestorationAt?` Current estimated restoration time is ${new Date(incident.estimatedRestorationAt).toISOString().slice(11,16)} UTC.`:'';
    if(event.state==='RESOLVED'){
      if(audience==='ENGINEERING'){const duration=Math.max(0,Date.parse(incident.resolvedAt??event.occurredAt)-Date.parse(incident.firstSeen));return `The ${engineeringService} incident has been resolved at ${incident.resolvedAt??event.occurredAt}. Duration was ${Math.round(duration/60000)} minutes. Classification: ${incident.classification.toLowerCase().replaceAll('_',' ')}.`;}
      return `The ${publicService} incident has been resolved. Normal service has been restored.`;
    }
    if(event.state==='ACKNOWLEDGED')return audience==='ENGINEERING'
      ? `The ${engineeringService} incident has been acknowledged and is now owned by the engineering team. Severity remains ${incident.severity.toLowerCase()}.`
      : `The ${publicService} incident has been acknowledged by the engineering team and is under investigation.${eta}`;
    const phase=event.state.toLowerCase().replaceAll('_',' ');
    if(audience==='ENGINEERING'){const signal=incident.evidence[0]?.summary??incident.summary;return `The ${engineeringService} incident is now ${phase}. Current leading signal: ${signal}. Severity is ${incident.severity.toLowerCase()}.${eta}`;}
    if(audience==='STAKEHOLDER')return `Engineering is actively ${phase==='open'?'investigating':phase} the ${publicService} disruption. The incident is ${incident.severity.toLowerCase()} and service impact is ongoing.${eta}`;
    return `We are continuing to investigate disruption affecting the ${publicService}. Our team is working to restore normal operation.${eta}`;
  }
  build(incident: Incident, audience: NotificationAudience, resolution = false): string {
    const service = incident.primaryResource.workload ?? incident.primaryResource.node ?? 'affected service';
    if (resolution) return audience === 'END_USER'
      ? `The ${service} incident has been resolved. Service operation has returned to normal.`
      : `Incident ${incident.id} affecting ${service} has been resolved. Service operation has returned to normal.`;
    if (audience === 'END_USER') {
      return `We are currently experiencing disruption to the ${service} service. Our engineering team is investigating the issue. We will provide another update when the service status changes.`;
    }
    if (audience === 'STAKEHOLDER') return `A ${incident.severity.toLowerCase()} incident is affecting the ${service} service. Engineering has been notified and investigation is in progress.`;
    const evidence = incident.evidence[0]?.summary;
    return [
      `${incident.severity === 'CRITICAL' ? 'Critical' : 'High severity'} incident ${incident.id} detected in ${service}.`,
      `${incident.title}. Classification is ${incident.classification.toLowerCase().replaceAll('_', ' ')}.`,
      `Cluster ${incident.clusterId}${incident.namespace ? `, namespace ${incident.namespace}` : ''}. Status is ${incident.status.toLowerCase()}.`,
      evidence ? `Evidence: ${evidence}.` : undefined,
    ].filter(Boolean).join(' ');
  }
}
