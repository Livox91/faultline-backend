import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { INCIDENT_TICKET_PUBLISHER, type IncidentLifecycleEvent, type IncidentTicketPublisher } from '@faultline/notifications';
import { QUEUE, EVENT_TOPICS, type Queue, type QueueSubscription } from '@faultline/queue';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { NotificationService } from './notification.service';

@Injectable()
export class NotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly subscriptions: QueueSubscription[] = [];
  constructor(@Inject(QUEUE) private readonly queue: Queue, @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    private readonly notifications: NotificationService,
    @Inject(INCIDENT_TICKET_PUBLISHER) private readonly tickets:IncidentTicketPublisher) {}
  async onModuleInit(): Promise<void> {
    this.subscriptions.push(
      await this.queue.subscribe(
        EVENT_TOPICS.incidentsLifecycle,
        async (message) => {
          const event = message.payload as IncidentLifecycleEvent;
          await this.notifications.handleIncident(
            event.incident,
            this.config.organizationId,
          );
          await this.notifications.handleEndUserLifecycle(event,this.config.organizationId);
          if (event.type === 'INCIDENT_CREATED')
            await this.tickets.createIncidentTicket({
              incidentId: event.incident.id,
            });
          else if (shouldUpdateSlackTicket(event))
            await this.tickets.updateIncidentTicket({
              incidentId: event.incident.id,
              state: event.state,
            });
          await this.tickets.publishTimelineUpdates(event);
        },
        { consumerGroup: this.config.consumerGroup },
      ),
    );
    this.subscriptions.push(await this.queue.subscribe(EVENT_TOPICS.notificationTestCallRequested,async(message)=>{await this.notifications.handleTestCall(message.payload as {requestId:string;organizationId:string;phoneNumber:string});},{consumerGroup:`${this.config.consumerGroup}-test-calls`}));
    this.subscriptions.push(await this.queue.subscribe(EVENT_TOPICS.notificationTestSmsRequested,async(message)=>{await this.notifications.handleTestSms(message.payload as {requestId:string;organizationId:string;clusterId:string;contactId:string});},{consumerGroup:`${this.config.consumerGroup}-test-sms`}));
    this.subscriptions.push(await this.queue.subscribe(
      EVENT_TOPICS.incidentTicketRequested,
      async (message) => {
        const payload = message.payload as { incidentId?: unknown };
        if (typeof payload.incidentId !== 'string' || !payload.incidentId)
          throw new Error('Invalid incident ticket request');
        await this.tickets.createIncidentTicket({ incidentId: payload.incidentId });
      },
      { consumerGroup: `${this.config.consumerGroup}-ticket-requests` },
    ));
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.subscriptions.map((subscription) => subscription.close()));
  }
}

function shouldUpdateSlackTicket(event:IncidentLifecycleEvent):boolean {
  return event.type==='INCIDENT_ACKNOWLEDGED'||event.type==='INCIDENT_STATUS_CHANGED'||event.type==='INCIDENT_SEVERITY_CHANGED'||event.type==='INCIDENT_RESOLVED'||event.changedFields.includes('affectedServices');
}
