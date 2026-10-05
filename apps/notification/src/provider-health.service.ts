import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NOTIFICATION_PROVIDER_STATUS_REPOSITORY, type NotificationProviderStatusRepository } from '@faultline/notifications';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { RetellCommunicationProvider } from './retell.provider';

@Injectable()
export class ProviderHealthService implements OnModuleInit,OnModuleDestroy{
  private timer?:NodeJS.Timeout;
  constructor(private readonly provider:RetellCommunicationProvider,@Inject(NOTIFICATION_CONFIG)private readonly config:NotificationWorkerConfig,@Inject(NOTIFICATION_PROVIDER_STATUS_REPOSITORY)private readonly statuses:NotificationProviderStatusRepository){}
  async onModuleInit(){await this.refresh();this.timer=setInterval(()=>void this.refresh(),60_000);this.timer.unref();}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  async refresh(){const result=await this.provider.checkConnection();await this.statuses.save({organizationId:this.config.organizationId,provider:'retell',...result,checkedAt:new Date().toISOString()});}
}
