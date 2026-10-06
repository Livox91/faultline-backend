import type {NotificationProviderStatus} from '@faultline/notifications';

const STATUS_STALE_AFTER_MS=150_000;

export function presentNotificationProviderStatus(status:NotificationProviderStatus|undefined,organizationId:string){
  if(!status)return{organizationId,provider:'retell' as const,configured:false,connected:false,voiceAgentConfigured:false,smsAgentConfigured:false,checkedAt:null,stale:true,message:'Notification worker has not reported Retell status'};
  const checkedAt=Date.parse(status.checkedAt);
  const stale=!Number.isFinite(checkedAt)||Date.now()-checkedAt>STATUS_STALE_AFTER_MS;
  return stale?{...status,organizationId,connected:false,stale:true,message:'Notification worker status is stale; restart or check the notification service'}:{...status,organizationId,stale:false};
}
