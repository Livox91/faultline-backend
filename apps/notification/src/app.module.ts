import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { APPLICATION_CONFIG, HealthService, PlatformModule, type ApplicationConfig } from '@faultline/platform';
import { NatsJetStreamQueue, QUEUE, getDevelopmentQueue } from '@faultline/queue';
import { PostgresAcknowledgementTransaction, PostgresConnection, PostgresContactRepository, PostgresEscalationExecutionRepository, PostgresEscalationPolicyRepository, PostgresExternalTicketRepository, PostgresIdempotencyStore, PostgresIncidentAcknowledgementRepository, PostgresIncidentCommunicationRepository, PostgresIncidentRepository, PostgresNotificationAttemptRepository, PostgresNotificationAuditRepository, PostgresNotificationGroupRepository,PostgresOnCallScheduleRepository,PostgresOnCallShiftRepository,PostgresAvailabilityOverrideRepository } from '@faultline/database';
import { INCIDENT_REPOSITORY } from '@faultline/incidents';
import { ACKNOWLEDGEMENT_TRANSACTION, COMMUNICATION_PROVIDER, CONTACT_REPOSITORY, ESCALATION_EXECUTION_REPOSITORY, ESCALATION_POLICY_REPOSITORY, EXTERNAL_TICKET_REPOSITORY, IDEMPOTENCY_STORE, INCIDENT_ACKNOWLEDGEMENTS, INCIDENT_COMMUNICATION_REPOSITORY, INCIDENT_TICKET_PUBLISHER, NOTIFICATION_ATTEMPTS, NOTIFICATION_AUDIT_REPOSITORY, NOTIFICATION_GROUP_REPOSITORY, NOTIFICATION_POLICY, POLICY_SELECTOR, RecipientResolver, RepositoryPolicySelector, SeverityNotificationPolicy, type ContactRepository, type EscalationPolicyRepository, type NotificationGroupRepository,ON_CALL_SCHEDULE_REPOSITORY,ON_CALL_SHIFT_REPOSITORY,AVAILABILITY_OVERRIDE_REPOSITORY,OnCallResolver,type OnCallScheduleRepository,type OnCallShiftRepository,type AvailabilityOverrideRepository } from '@faultline/notifications';
import { loadNotificationConfig, NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { IncidentMessageBuilder } from './message-builder';
import { NotificationConsumer } from './notification.consumer';
import { NotificationService } from './notification.service';
import { RetellCommunicationProvider } from './retell.provider';
import { RetellWebhookController } from './webhook.controller';
import { VoiceActionController } from './voice-action.controller';
import { VoiceActionService } from './voice-action.service';
import { LifecycleCommunicationService } from './lifecycle-communication.service';
import { RecoverySchedulerService } from './recovery-scheduler.service';
import { HttpSlackClient, SLACK_CLIENT } from './slack.client';
import { SlackMessageBuilder } from './slack-message-builder';
import { SlackIncidentTicketPublisher } from './slack-incident-ticket.publisher';
import { SlackIncidentChannelResolver } from './slack-incident-channel.resolver';
import { SlackIncidentTimelineMapper } from './slack-incident-timeline.mapper';
@Module({
  imports:[PlatformModule.forRoot('notification',resolve(__dirname,'../.env'))],controllers:[RetellWebhookController,VoiceActionController],providers:[
    {provide:NOTIFICATION_CONFIG,useFactory:loadNotificationConfig},
    {provide:PostgresConnection,inject:[APPLICATION_CONFIG,HealthService],useFactory:async(config:ApplicationConfig,health:HealthService)=>{const db=new PostgresConnection(config.infrastructure.databaseUrl!);await db.connect();health.register(db);return db;}},
    {provide:CONTACT_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresContactRepository(db)},
    {provide:NOTIFICATION_GROUP_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresNotificationGroupRepository(db)},
    {provide:ESCALATION_POLICY_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresEscalationPolicyRepository(db)},
    {provide:NOTIFICATION_ATTEMPTS,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresNotificationAttemptRepository(db)},
    {provide:ESCALATION_EXECUTION_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresEscalationExecutionRepository(db)},
    {provide:NOTIFICATION_AUDIT_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresNotificationAuditRepository(db)},
    {provide:INCIDENT_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresIncidentRepository(db)},
    {provide:INCIDENT_ACKNOWLEDGEMENTS,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresIncidentAcknowledgementRepository(db)},
    {provide:INCIDENT_COMMUNICATION_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresIncidentCommunicationRepository(db)},
    {provide:IDEMPOTENCY_STORE,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresIdempotencyStore(db)},
    {provide:EXTERNAL_TICKET_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresExternalTicketRepository(db)},
    {provide:ACKNOWLEDGEMENT_TRANSACTION,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresAcknowledgementTransaction(db)},
    {provide:ON_CALL_SCHEDULE_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresOnCallScheduleRepository(db)},
    {provide:ON_CALL_SHIFT_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresOnCallShiftRepository(db)},
    {provide:AVAILABILITY_OVERRIDE_REPOSITORY,inject:[PostgresConnection],useFactory:(db:PostgresConnection)=>new PostgresAvailabilityOverrideRepository(db)},
    {provide:OnCallResolver,inject:[ON_CALL_SCHEDULE_REPOSITORY,ON_CALL_SHIFT_REPOSITORY,AVAILABILITY_OVERRIDE_REPOSITORY],useFactory:(s:OnCallScheduleRepository,h:OnCallShiftRepository,o:AvailabilityOverrideRepository)=>new OnCallResolver(s,h,o)},
    {provide:POLICY_SELECTOR,inject:[ESCALATION_POLICY_REPOSITORY],useFactory:(repo:EscalationPolicyRepository)=>new RepositoryPolicySelector(repo)},
    {provide:RecipientResolver,inject:[CONTACT_REPOSITORY,NOTIFICATION_GROUP_REPOSITORY,OnCallResolver],useFactory:(contacts:ContactRepository,groups:NotificationGroupRepository,onCall:OnCallResolver)=>new RecipientResolver(contacts,groups,onCall)},
    {provide:QUEUE,inject:[APPLICATION_CONFIG,HealthService],useFactory:async(config:ApplicationConfig,health:HealthService)=>{if(!config.infrastructure.brokerUrl)return getDevelopmentQueue();const queue=await NatsJetStreamQueue.connect({servers:config.infrastructure.brokerUrl,clientId:config.infrastructure.brokerClientId,consumerGroup:'faultline-notifications',maxDeliver:config.infrastructure.brokerMaxDeliver,retryDelayMs:config.infrastructure.brokerRetryDelayMs});health.register(queue);return queue;}},
    {provide:NOTIFICATION_POLICY,inject:[NOTIFICATION_CONFIG],useFactory:(config:NotificationWorkerConfig)=>new SeverityNotificationPolicy(config.highEscalationEnabled)},
    RetellCommunicationProvider,{provide:COMMUNICATION_PROVIDER,useExisting:RetellCommunicationProvider},
    HttpSlackClient,{provide:SLACK_CLIENT,useExisting:HttpSlackClient},SlackMessageBuilder,SlackIncidentChannelResolver,SlackIncidentTimelineMapper,SlackIncidentTicketPublisher,{provide:INCIDENT_TICKET_PUBLISHER,useExisting:SlackIncidentTicketPublisher},
    IncidentMessageBuilder,NotificationService,NotificationConsumer,VoiceActionService,LifecycleCommunicationService,RecoverySchedulerService,
  ],
}) export class AppModule {}
