import { Module, SetMetadata, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  HealthController,
  HealthService,
  PlatformModule,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  DATABASE,
  PostgresAuditLogRepository,
  PostgresProcessedEventRepository,
  PostgresSubscriptionRepository,
  PostgresBaselineRepository,
  PostgresClusterDirectory,
  PostgresConnection,
  PostgresIncidentRepository,
  PostgresContactRepository,
  PostgresNotificationGroupRepository,
  PostgresEscalationPolicyRepository,
  PostgresEscalationExecutionRepository,
  PostgresIncidentAcknowledgementRepository,
  PostgresNotificationAuditRepository,
  PostgresNotificationAttemptRepository,
  PostgresIncidentCommunicationRepository,
  PostgresOnCallScheduleRepository,PostgresOnCallShiftRepository,PostgresAvailabilityOverrideRepository,
  PostgresIncidentAnalyticsRepository,
  PostgresExternalTicketRepository,
  PostgresProjectAssignmentRepository,
  PostgresUserRepository,
} from '@faultline/database';
import {
  CONTACT_REPOSITORY, ESCALATION_EXECUTION_REPOSITORY, ESCALATION_POLICY_REPOSITORY,
  INCIDENT_ACKNOWLEDGEMENTS, InMemoryContactRepository, InMemoryEscalationExecutionRepository,
  InMemoryEscalationPolicyRepository, InMemoryIncidentAcknowledgementRepository,
  InMemoryNotificationAuditRepository, InMemoryNotificationGroupRepository,
  InMemoryNotificationAttemptRepository,InMemoryIncidentCommunicationRepository,INCIDENT_COMMUNICATION_REPOSITORY,NOTIFICATION_ATTEMPTS,
  NOTIFICATION_AUDIT_REPOSITORY, NOTIFICATION_GROUP_REPOSITORY,
  ON_CALL_SCHEDULE_REPOSITORY,ON_CALL_SHIFT_REPOSITORY,AVAILABILITY_OVERRIDE_REPOSITORY,InMemoryOnCallScheduleRepository,InMemoryOnCallShiftRepository,InMemoryAvailabilityOverrideRepository,
  EXTERNAL_TICKET_REPOSITORY,InMemoryExternalTicketRepository,
} from '@faultline/notifications';
import {
  AUDIT_LOG_REPOSITORY,
  PROJECT_ASSIGNMENT_REPOSITORY,
  USER_REPOSITORY,
  getDevelopmentAuditLogRepository,
  getDevelopmentProjectAssignmentRepository,
  getDevelopmentUserRepository,
} from '@faultline/auth';
import {
  PROCESSED_EVENT_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  InMemoryProcessedEventRepository,
  InMemorySubscriptionRepository,
} from '@faultline/billing';
import {
  EMAIL_SENDER,
  RecordingEmailSender,
  SmtpEmailSender,
  type EmailSender,
} from '@faultline/email';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
} from '@faultline/incidents';
import {
  BASELINE_REPOSITORY,
  getDevelopmentBaselineRepository,
} from '@faultline/baselines';
import {
  TELEMETRY_STORE,
  getDevelopmentTelemetryStore,
} from '@faultline/telemetry';
import {
  ClickHouseConnection,
  ClickHouseTelemetryStore,
} from '@faultline/clickhouse';
import { OnCallController } from './on-call.controller';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { SystemController } from './system.controller';
import { IncidentsController } from './incidents.controller';
import { IncidentEvidenceController } from './incident-evidence.controller';
import { BaselinesController } from './baselines.controller';
import {
  ResourceTimelineController,
  TelemetryController,
} from './telemetry.controller';
import {
  TELEMETRY_SCOPE_RESOLVER,
  UserTelemetryScopeResolver,
} from './telemetry-scope';
import {
  CLUSTER_DIRECTORY,
  ClustersController,
  type RegisteredCluster,
} from './clusters.controller';
import { ContactsController, EscalationPoliciesController, NotificationGroupsController } from './notification-management.controller';
import { IncidentAcknowledgementController } from './incident-acknowledgement.controller';
import { IncidentNotificationStateController } from './incident-notification-state.controller';
import {
  INCIDENT_REPORT_BUILDER,
  IncidentReportController,
} from './incident-report.controller';
import {
  AnalyticsService,
  CSV_REPORT_EXPORTER,
  CsvReportExporter,
  CurrentApplicationHealthProvider,
  INCIDENT_ANALYTICS_REPOSITORY,
  IncidentReportBuilder,
  JSON_REPORT_EXPORTER,
  JsonReportExporter,
  PDF_REPORT_EXPORTER,
  PdfReportExporter,
  SystemSummaryService,
  type IncidentAnalyticsRepository,
} from '@faultline/reporting';
import {
  IncidentAnalyticsController,
  SystemSummaryController,
} from './analytics.controller';
import { IncidentExternalTicketController } from './incident-external-ticket.controller';
import { IS_PUBLIC } from './auth/context';
import { AuthenticationGuard } from './auth/authentication.guard';
import { AuthorizationGuard } from './auth/authorization.guard';
import { AuditTrail } from './auth/audit-trail';
import { AdminBootstrap } from './auth/bootstrap';
import { AuthController, LoginThrottle } from './auth/auth.controller';
import { BillingController } from './billing/billing.controller';
import { EntitlementsController } from './billing/entitlements.controller';
import { EntitlementsGuard, PlanEntitlements } from './billing/entitlements';
import { SubscriptionProvisioningService } from './billing/provisioning.service';
import { PAYMENT_GATEWAY, StripeGateway } from './billing/stripe.gateway';
import { AdminUsersController } from './auth/users.controller';
import { AdminAuditController } from './auth/audit.controller';

export const CLICKHOUSE_CONNECTION = Symbol('faultline.clickhouse-connection');

/**
 * Liveness and readiness stay reachable without a token.
 *
 * The health controller ships in `@faultline/platform`, which knows nothing about
 * authorization and should not start to. Applying the metadata from here keeps that
 * separation while still letting the global guard see the exemption - a decorator is
 * just a function, and this is the one place that decides what is public.
 */
SetMetadata(IS_PUBLIC, true)(HealthController);

const infrastructureProviders: Provider[] =
  process.env.NODE_ENV === 'test'
    ? [
        {
          provide: INCIDENT_REPOSITORY,
          useFactory: getDevelopmentIncidentRepository,
        },
        { provide: TELEMETRY_STORE, useFactory: getDevelopmentTelemetryStore },
        {
          provide: BASELINE_REPOSITORY,
          useFactory: getDevelopmentBaselineRepository,
        },
        { provide: CONTACT_REPOSITORY, useClass: InMemoryContactRepository },
        { provide: NOTIFICATION_GROUP_REPOSITORY, useClass: InMemoryNotificationGroupRepository },
        { provide: ESCALATION_POLICY_REPOSITORY, useClass: InMemoryEscalationPolicyRepository },
        { provide: ESCALATION_EXECUTION_REPOSITORY, useClass: InMemoryEscalationExecutionRepository },
        { provide: INCIDENT_ACKNOWLEDGEMENTS, useClass: InMemoryIncidentAcknowledgementRepository },
        {
          provide: INCIDENT_ANALYTICS_REPOSITORY,
          useValue: {
            listIncidentMetricRecords: async () => [],
            getIncidentTrendPoints: async () => [],
          } satisfies IncidentAnalyticsRepository,
        },
        { provide: NOTIFICATION_AUDIT_REPOSITORY, useClass: InMemoryNotificationAuditRepository },
        { provide: NOTIFICATION_ATTEMPTS, useClass: InMemoryNotificationAttemptRepository },
        { provide: INCIDENT_COMMUNICATION_REPOSITORY, useClass: InMemoryIncidentCommunicationRepository },
        { provide: ON_CALL_SCHEDULE_REPOSITORY, useClass: InMemoryOnCallScheduleRepository },
        { provide: ON_CALL_SHIFT_REPOSITORY, useClass: InMemoryOnCallShiftRepository },
        { provide: AVAILABILITY_OVERRIDE_REPOSITORY, useClass: InMemoryAvailabilityOverrideRepository },
        { provide: EXTERNAL_TICKET_REPOSITORY, useClass: InMemoryExternalTicketRepository },
        { provide: USER_REPOSITORY, useFactory: getDevelopmentUserRepository },
        {
          provide: PROJECT_ASSIGNMENT_REPOSITORY,
          useFactory: getDevelopmentProjectAssignmentRepository,
        },
        {
          provide: AUDIT_LOG_REPOSITORY,
          useFactory: getDevelopmentAuditLogRepository,
        },
        {
          provide: SUBSCRIPTION_REPOSITORY,
          useFactory: () => new InMemorySubscriptionRepository(),
        },
        {
          provide: PROCESSED_EVENT_REPOSITORY,
          useFactory: () => new InMemoryProcessedEventRepository(),
        },
        {
          provide: CLUSTER_DIRECTORY,
          useValue: {
            list: async () => [],
            get: async () => undefined,
            create: async () => {
              throw new Error('Not available in tests');
            },
            update: async () => undefined,
            remove: async () => false,
          },
        },
      ]
    : [
        {
          provide: DATABASE,
          inject: [APPLICATION_CONFIG, HealthService],
          useFactory: async (
            config: ApplicationConfig,
            health: HealthService,
          ) => {
            const database = new PostgresConnection(
              config.infrastructure.databaseUrl!,
            );
            await database.connect();
            health.register(database);
            return database;
          },
        },
        {
          provide: INCIDENT_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresIncidentRepository(database),
        },
        {
          provide: INCIDENT_ANALYTICS_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresIncidentAnalyticsRepository(database),
        },
        { provide: CONTACT_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresContactRepository(database) },
        { provide: NOTIFICATION_GROUP_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresNotificationGroupRepository(database) },
        { provide: ESCALATION_POLICY_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresEscalationPolicyRepository(database) },
        { provide: ESCALATION_EXECUTION_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresEscalationExecutionRepository(database) },
        { provide: INCIDENT_ACKNOWLEDGEMENTS, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresIncidentAcknowledgementRepository(database) },
        { provide: NOTIFICATION_AUDIT_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresNotificationAuditRepository(database) },
        { provide: NOTIFICATION_ATTEMPTS, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresNotificationAttemptRepository(database) },
        { provide: INCIDENT_COMMUNICATION_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresIncidentCommunicationRepository(database) },
        { provide: ON_CALL_SCHEDULE_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresOnCallScheduleRepository(database) },
        { provide: ON_CALL_SHIFT_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresOnCallShiftRepository(database) },
        { provide: AVAILABILITY_OVERRIDE_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresAvailabilityOverrideRepository(database) },
        { provide: EXTERNAL_TICKET_REPOSITORY, inject: [DATABASE], useFactory: (database: PostgresConnection) => new PostgresExternalTicketRepository(database) },
        {
          provide: USER_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresUserRepository(database),
        },
        {
          provide: PROJECT_ASSIGNMENT_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresProjectAssignmentRepository(database),
        },
        {
          provide: AUDIT_LOG_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresAuditLogRepository(database),
        },
        {
          provide: SUBSCRIPTION_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresSubscriptionRepository(database),
        },
        {
          provide: PROCESSED_EVENT_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresProcessedEventRepository(database),
        },
        {
          provide: CLUSTER_DIRECTORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresClusterDirectory(database),
        },
        {
          // Baselines are served from PostgreSQL, so they stay inspectable even while
          // ClickHouse - and therefore refresh - is unavailable.
          provide: BASELINE_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresBaselineRepository(database),
        },
        {
          provide: CLICKHOUSE_CONNECTION,
          inject: [APPLICATION_CONFIG, HealthService],
          useFactory: async (
            config: ApplicationConfig,
            health: HealthService,
          ) => {
            const connection = new ClickHouseConnection({
              url: config.infrastructure.clickhouseUrl!,
              database: config.infrastructure.clickhouseDatabase,
              username: config.infrastructure.clickhouseUsername,
              ...(config.infrastructure.clickhousePassword
                ? { password: config.infrastructure.clickhousePassword }
                : {}),
              requestTimeoutMs:
                config.infrastructure.clickhouseRequestTimeoutMs,
              retention: config.telemetryStorage.retention,
            });
            // Non-critical: incidents stay readable while telemetry history is down,
            // and readiness reports the degradation instead of failing outright.
            health.register(connection, { critical: false });
            return connection;
          },
        },
        {
          provide: TELEMETRY_STORE,
          inject: [CLICKHOUSE_CONNECTION, APPLICATION_CONFIG],
          useFactory: (
            connection: ClickHouseConnection,
            config: ApplicationConfig,
          ) =>
            new ClickHouseTelemetryStore(connection, {
              queryLimits: config.telemetryStorage.queryLimits,
            }),
        },
      ];

/**
 * Outbound email.
 *
 * The transport is configuration, not code: `log` records messages for development, and
 * configuration validation refuses it for a production deployment that sells
 * subscriptions - a purchaser whose credentials only reached a log file has bought
 * nothing they can use.
 */
const emailProvider: Provider = {
  provide: EMAIL_SENDER,
  inject: [APPLICATION_CONFIG, ApplicationLogger],
  useFactory: (
    config: ApplicationConfig,
    logger: ApplicationLogger,
  ): EmailSender =>
    config.email.transport === 'smtp'
      ? new SmtpEmailSender({
          host: config.email.smtp!.host,
          port: config.email.smtp!.port,
          secure: config.email.smtp!.secure,
          ...(config.email.smtp!.username
            ? { username: config.email.smtp!.username }
            : {}),
          ...(config.email.smtp!.password
            ? { password: config.email.smtp!.password }
            : {}),
          from: config.email.from,
        })
      : new RecordingEmailSender((message) =>
          // The body carries a temporary password, so it is printed only by the
          // development transport, which production configuration forbids.
          logger.warn({
            event: 'email_not_sent_development_transport',
            to: message.to,
            subject: message.subject,
            body: message.text,
          }),
        ),
};

/**
 * Reads one flag the way the application's own configuration reads it.
 *
 * Nest builds module metadata before any provider is instantiated, so the validated
 * `ApplicationConfig` does not exist yet - but whether billing is registered has to be
 * decided here. `PlatformModule` loads configuration from the app's `.env` file with
 * `skipProcessEnv: true`, so consulting `process.env` alone would let the two disagree:
 * the routes could be registered while the config said billing was off, or the reverse.
 * This reads the same file, and lets a real environment variable win for container
 * deployments that inject settings that way.
 */
const NEWLINE = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

function readEnvFlag(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined) return fromProcess;
  try {
    const text = readFileSync(resolve(__dirname, '../.env'), 'utf8');
    const lines = text.split(NEWLINE);
    for (const line of lines) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] === name) return match[2]?.replace(/^["']|["']$/g, '');
    }
  } catch {
    // No file in a container deployment; the process environment is the only source.
  }
  return undefined;
}

/**
 * Billing is registered only when it is turned on.
 *
 * With `BILLING_ENABLED=false` the checkout and webhook routes do not exist at all, so
 * a deployment that does not sell subscriptions exposes no public, account-creating
 * surface to probe - which is a stronger position than having the routes present and
 * refusing.
 */
const billingEnabled = readEnvFlag('BILLING_ENABLED') === 'true';

const billingProviders: Provider[] = billingEnabled
  ? [
      SubscriptionProvisioningService,
      { provide: PAYMENT_GATEWAY, useClass: StripeGateway },
    ]
  : [];

@Module({
  imports: [PlatformModule.forRoot('api', resolve(__dirname, '../.env'))],
  controllers: [
    AuthController,
    ...(billingEnabled ? [BillingController] : []),
    // Unlike the purchase routes, this one is registered either way: the console asks
    // what the account may reach on every deployment, and with billing off the honest
    // answer is "everything, unenforced" rather than a 404 to interpret.
    EntitlementsController,
    AdminUsersController,
    AdminAuditController,
    SystemController,
    IncidentsController,
    IncidentEvidenceController,
    TelemetryController,
    ResourceTimelineController,
    BaselinesController,
    ClustersController,
    ContactsController,
    NotificationGroupsController,
    EscalationPoliciesController,
    IncidentAcknowledgementController,
    IncidentNotificationStateController,
    IncidentExternalTicketController,
    IncidentReportController,
    IncidentAnalyticsController,
    SystemSummaryController,
    OnCallController,
  ],
  providers: [
    ...infrastructureProviders,
    emailProvider,
    ...billingProviders,
    AuditTrail,
    PlanEntitlements,
    LoginThrottle,
    AdminBootstrap,
    {
      provide: TELEMETRY_SCOPE_RESOLVER,
      useClass: UserTelemetryScopeResolver,
    },
    {
      provide: INCIDENT_REPORT_BUILDER,
      inject: [INCIDENT_REPOSITORY, INCIDENT_ACKNOWLEDGEMENTS],
      useFactory: (
        incidents: import('@faultline/incidents').IncidentRepository,
        acknowledgements: import('@faultline/notifications').IncidentAcknowledgementRepository,
      ) => new IncidentReportBuilder(incidents, acknowledgements),
    },
    {
      provide: JSON_REPORT_EXPORTER,
      useClass: JsonReportExporter,
    },
    {
      provide: CSV_REPORT_EXPORTER,
      useClass: CsvReportExporter,
    },
    {
      provide: PDF_REPORT_EXPORTER,
      useClass: PdfReportExporter,
    },
    {
      provide: AnalyticsService,
      inject: [INCIDENT_ANALYTICS_REPOSITORY],
      useFactory: (repository: IncidentAnalyticsRepository) =>
        new AnalyticsService(repository),
    },
    {
      provide: SystemSummaryService,
      inject: [AnalyticsService, HealthService],
      useFactory: (analytics: AnalyticsService, health: HealthService) =>
        new SystemSummaryService(analytics, {
          health: new CurrentApplicationHealthProvider(health),
        }),
    },
    // Registered globally and in this order: authentication establishes who is calling
    // and rejects with 401, then authorization decides what they may reach and rejects
    // with 403. Global rather than per-controller so that a route added later is
    // protected unless it is explicitly marked `@Public()` - the failure mode of a
    // forgotten decorator is a locked door, not an open one.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
    // Last, and only for routes that declare a module: who you are is settled before
    // what your plan bought is consulted, so a stranger is never told which tier a
    // module needs, and the lookup is paid for only where it is asked for.
    { provide: APP_GUARD, useClass: EntitlementsGuard },
  ],
})
export class AppModule {}
