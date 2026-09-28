import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  COMMUNICATION_PROVIDER,
  NOTIFICATION_ATTEMPTS,
  NOTIFICATION_AUDIT_REPOSITORY,
  type CommunicationProvider,
  type NotificationAttemptRepository,
  type NotificationAuditRepository,
} from '@faultline/notifications';
import { HealthService } from '@faultline/platform';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { NotificationService } from './notification.service';

@Injectable()
export class RecoverySchedulerService implements OnModuleInit, OnModuleDestroy {
  readonly name = 'notification-scheduler';
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastSuccessfulRun = 0;

  constructor(
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    @Inject(NOTIFICATION_ATTEMPTS) private readonly attempts: NotificationAttemptRepository,
    @Inject(NOTIFICATION_AUDIT_REPOSITORY) private readonly audit: NotificationAuditRepository,
    @Inject(COMMUNICATION_PROVIDER) private readonly provider: CommunicationProvider,
    private readonly notifications: NotificationService,
    health: HealthService,
  ) {
    health.register(this, { critical: false });
  }

  async onModuleInit() {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.schedulerPollMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async ping() {
    if (!this.lastSuccessfulRun || Date.now() - this.lastSuccessfulRun > this.config.schedulerPollMs * 3)
      throw new Error('Notification scheduler is stalled');
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - this.config.staleAttemptMs).toISOString();
      for (const attempt of await this.attempts.listRecoverable(staleBefore)) {
        if (!attempt.providerRequestId) continue;
        try {
          const status = await this.provider.getCallStatus(attempt.providerRequestId);
          await this.notifications.processProviderEvent(status);
        } catch {
          // Provider outages leave the attempt recoverable for the next poll.
        }
      }
      const day = 86_400_000;
      await this.attempts.purgeCompleted(new Date(now.getTime() - this.config.attemptRetentionDays * day).toISOString());
      await this.audit.purge(new Date(now.getTime() - this.config.auditRetentionDays * day).toISOString());
      this.lastSuccessfulRun = Date.now();
    } finally {
      this.running = false;
    }
  }
}
