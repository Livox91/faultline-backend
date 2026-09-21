import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { INCIDENT_TICKET_PUBLISHER, type IncidentLifecycleEvent, type IncidentTicketPublisher } from '@faultline/notifications';
import { QUEUE, EVENT_TOPICS, type Queue, type QueueSubscription } from '@faultline/queue';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { NotificationService } from './notification.service';
import { LifecycleCommunicationService } from './lifecycle-communication.service';

@Injectable()
export class NotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private subscription?: QueueSubscription;
  constructor(@Inject(QUEUE) private readonly queue: Queue, @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    private readonly notifications: NotificationService, private readonly lifecycle:LifecycleCommunicationService,
    @Inject(INCIDENT_TICKET_PUBLISHER) private readonly tickets:IncidentTicketPublisher) {}
  async onModuleInit(): Promise<void> {
    this.subscription = await this.queue.subscribe(EVENT_TOPICS.incidentsLifecycle,
      async(message) => { const event=message.payload as IncidentLifecycleEvent; await this.notifications.handleIncident(event.incident,this.config.organizationId); await this.lifecycle.handle(event,this.config.organizationId); if(event.type==='INCIDENT_CREATED')await this.tickets.createIncidentTicket({incidentId:event.incident.id}); else if(shouldUpdateSlackTicket(event))await this.tickets.updateIncidentTicket({incidentId:event.incident.id,state:event.state}); await this.tickets.publishTimelineUpdates(event); }, { consumerGroup: this.config.consumerGroup });
  }
  async onModuleDestroy(): Promise<void> { await this.subscription?.close(); }
}

function shouldUpdateSlackTicket(event:IncidentLifecycleEvent):boolean {
  return event.type==='INCIDENT_ACKNOWLEDGED'||event.type==='INCIDENT_STATUS_CHANGED'||event.type==='INCIDENT_SEVERITY_CHANGED'||event.type==='INCIDENT_RESOLVED'||event.changedFields.includes('affectedServices');
}
