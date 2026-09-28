import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { USER_REPOSITORY } from '@faultline/auth';
import {
  PostgresAcknowledgementTransaction,
  PostgresConnection,
  PostgresClusterDirectory,
  PostgresContactRepository,
  PostgresExternalTicketRepository,
  PostgresIdempotencyStore,
  PostgresIncidentAcknowledgementRepository,
  PostgresIncidentNotificationStateRepository,
  PostgresIncidentRepository,
  PostgresNotificationAttemptRepository,
  PostgresNotificationAuditRepository,
  PostgresClusterSreAssignmentRepository,
  PostgresSlackIntegrationRepository,
  PostgresUserRepository,
} from '@faultline/database';
import { INCIDENT_REPOSITORY } from '@faultline/incidents';
import {
  ACKNOWLEDGEMENT_TRANSACTION,
  COMMUNICATION_PROVIDER,
  CONTACT_REPOSITORY,
  EXTERNAL_TICKET_REPOSITORY,
  IDEMPOTENCY_STORE,
  INCIDENT_ACKNOWLEDGEMENTS,
  INCIDENT_NOTIFICATION_STATE_REPOSITORY,
  INCIDENT_TICKET_PUBLISHER,
  NOTIFICATION_ATTEMPTS,
  NOTIFICATION_AUDIT_REPOSITORY,
  NOTIFICATION_POLICY,
  SLACK_INTEGRATION_REPOSITORY,
  SeverityNotificationPolicy,
  CLUSTER_SRE_ASSIGNMENT_REPOSITORY,
} from '@faultline/notifications';
import { APPLICATION_CONFIG, HealthService, PlatformModule, type ApplicationConfig } from '@faultline/platform';
import { NatsJetStreamQueue, QUEUE, getDevelopmentQueue } from '@faultline/queue';
import { ClusterRecipientResolver } from './cluster-recipient.resolver';
import { loadNotificationConfig, NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { IncidentMessageBuilder } from './message-builder';
import { NotificationConsumer } from './notification.consumer';
import { NotificationService } from './notification.service';
import { RecoverySchedulerService } from './recovery-scheduler.service';
import { RetellCommunicationProvider } from './retell.provider';
import { HttpSlackClient, SLACK_CLIENT } from './slack.client';
import { SlackIncidentChannelResolver } from './slack-incident-channel.resolver';
import {
  NOTIFICATION_CLUSTER_DIRECTORY,
  SlackIncidentTicketPublisher,
} from './slack-incident-ticket.publisher';
import { SlackIncidentTimelineMapper } from './slack-incident-timeline.mapper';
import { SlackMessageBuilder } from './slack-message-builder';
import { VoiceActionController } from './voice-action.controller';
import { VoiceActionService } from './voice-action.service';
import { RetellWebhookController } from './webhook.controller';

@Module({
  imports: [PlatformModule.forRoot('notification', resolve(__dirname, '../.env'))],
  controllers: [RetellWebhookController, VoiceActionController],
  providers: [
    { provide: NOTIFICATION_CONFIG, useFactory: loadNotificationConfig },
    {
      provide: PostgresConnection,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        const database = new PostgresConnection(config.infrastructure.databaseUrl!);
        await database.connect();
        health.register(database);
        return database;
      },
    },
    { provide: CONTACT_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresContactRepository(db) },
    { provide: USER_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresUserRepository(db) },
    { provide: CLUSTER_SRE_ASSIGNMENT_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresClusterSreAssignmentRepository(db) },
    { provide: NOTIFICATION_ATTEMPTS, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresNotificationAttemptRepository(db) },
    { provide: INCIDENT_NOTIFICATION_STATE_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresIncidentNotificationStateRepository(db) },
    { provide: NOTIFICATION_AUDIT_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresNotificationAuditRepository(db) },
    { provide: INCIDENT_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresIncidentRepository(db) },
    { provide: INCIDENT_ACKNOWLEDGEMENTS, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresIncidentAcknowledgementRepository(db) },
    { provide: IDEMPOTENCY_STORE, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresIdempotencyStore(db) },
    { provide: EXTERNAL_TICKET_REPOSITORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresExternalTicketRepository(db) },
    { provide: SLACK_INTEGRATION_REPOSITORY, inject: [PostgresConnection, NOTIFICATION_CONFIG], useFactory: (db: PostgresConnection, config: NotificationWorkerConfig) => new PostgresSlackIntegrationRepository(db, config.slackTokenEncryptionKey) },
    { provide: NOTIFICATION_CLUSTER_DIRECTORY, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresClusterDirectory(db) },
    { provide: ACKNOWLEDGEMENT_TRANSACTION, inject: [PostgresConnection], useFactory: (db: PostgresConnection) => new PostgresAcknowledgementTransaction(db) },
    {
      provide: QUEUE,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        if (!config.infrastructure.brokerUrl) return getDevelopmentQueue();
        const queue = await NatsJetStreamQueue.connect({
          servers: config.infrastructure.brokerUrl,
          clientId: config.infrastructure.brokerClientId,
          consumerGroup: 'faultline-notifications',
          maxDeliver: config.infrastructure.brokerMaxDeliver,
          retryDelayMs: config.infrastructure.brokerRetryDelayMs,
        });
        health.register(queue);
        return queue;
      },
    },
    { provide: NOTIFICATION_POLICY, inject: [NOTIFICATION_CONFIG], useFactory: (config: NotificationWorkerConfig) => new SeverityNotificationPolicy(config.highSeverityEnabled) },
    RetellCommunicationProvider,
    { provide: COMMUNICATION_PROVIDER, useExisting: RetellCommunicationProvider },
    { provide: HttpSlackClient, useFactory: () => new HttpSlackClient() },
    { provide: SLACK_CLIENT, useExisting: HttpSlackClient },
    SlackMessageBuilder,
    { provide: SlackIncidentChannelResolver, useFactory: () => new SlackIncidentChannelResolver() },
    SlackIncidentTimelineMapper,
    SlackIncidentTicketPublisher,
    { provide: INCIDENT_TICKET_PUBLISHER, useExisting: SlackIncidentTicketPublisher },
    ClusterRecipientResolver,
    IncidentMessageBuilder,
    NotificationService,
    NotificationConsumer,
    VoiceActionService,
    RecoverySchedulerService,
  ],
})
export class AppModule {}
