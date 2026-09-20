import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { IncidentLifecycleEvent } from '@faultline/notifications';
import { QUEUE, EVENT_TOPICS, type Queue, type QueueSubscription } from '@faultline/queue';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { NotificationService } from './notification.service';
import { LifecycleCommunicationService } from './lifecycle-communication.service';

@Injectable()
export class NotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private subscription?: QueueSubscription;
  constructor(@Inject(QUEUE) private readonly queue: Queue, @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    private readonly notifications: NotificationService, private readonly lifecycle:LifecycleCommunicationService) {}
  async onModuleInit(): Promise<void> {
    this.subscription = await this.queue.subscribe(EVENT_TOPICS.incidentsLifecycle,
      async(message) => { const event=message.payload as IncidentLifecycleEvent; await this.notifications.handleIncident(event.incident,this.config.organizationId); await this.lifecycle.handle(event,this.config.organizationId); }, { consumerGroup: this.config.consumerGroup });
  }
  async onModuleDestroy(): Promise<void> { await this.subscription?.close(); }
}
