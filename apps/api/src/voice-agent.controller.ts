import { randomUUID } from 'node:crypto';
import { BadRequestException,Controller,Get,Header,HttpCode,Inject,Post } from '@nestjs/common';
import { ROLES,type AuthenticatedUser } from '@faultline/auth';
import { FEATURES } from '@faultline/billing';
import { CONTACT_REPOSITORY,INCIDENT_COMMUNICATION_REPOSITORY,NOTIFICATION_PROVIDER_STATUS_REPOSITORY,normalizePhoneNumber,type ContactRepository,type IncidentCommunicationRepository,type NotificationProviderStatusRepository } from '@faultline/notifications';
import { EVENT_TOPICS,QUEUE,type Queue } from '@faultline/queue';
import { CurrentUser,RequiresFeature,Roles } from './auth/context';
import { AuditTrail } from './auth/audit-trail';

@Controller('voice-agent')
@Roles(ROLES.ADMIN)
@RequiresFeature(FEATURES.VOICE_AGENT)
export class VoiceAgentController{
  constructor(@Inject(NOTIFICATION_PROVIDER_STATUS_REPOSITORY)private readonly statuses:NotificationProviderStatusRepository,@Inject(INCIDENT_COMMUNICATION_REPOSITORY)private readonly communications:IncidentCommunicationRepository,@Inject(CONTACT_REPOSITORY)private readonly contacts:ContactRepository,@Inject(QUEUE)private readonly queue:Queue,private readonly audit:AuditTrail){}
  @Get('status')@Header('Cache-Control','no-store')async status(@CurrentUser()user:AuthenticatedUser){return(await this.statuses.get(user.organizationId))??{organizationId:user.organizationId,provider:'retell',configured:false,connected:false,voiceAgentConfigured:false,smsAgentConfigured:false,checkedAt:null,message:'Notification worker has not reported Retell status'};}
  @Get('deliveries')@Header('Cache-Control','no-store')async deliveries(@CurrentUser()user:AuthenticatedUser){const values=await this.communications.listRecent(user.organizationId,100);const contacts=await this.contacts.list(user.organizationId);const byId=new Map(contacts.map((contact)=>[contact.id,contact]));return values.filter((value)=>value.channel==='VOICE').map((value)=>{const contact=byId.get(value.recipientId);return{id:value.id,incidentId:value.incidentId,sreName:contact?.name??'Unknown recipient',maskedPhoneNumber:contact?maskPhone(contact.phoneNumber):'Unavailable',status:value.status,timestamp:value.sentAt??value.createdAt,isTest:value.communicationType==='TEST'};});}
  @Post('test-call')@HttpCode(202)async testCall(@CurrentUser()user:AuthenticatedUser){const contact=(await this.contacts.findByUserIds([user.id],user.organizationId))[0];if(!contact||!contact.enabled||!contact.voiceEnabled)throw new BadRequestException('Your Admin account does not have an enabled voice contact');try{normalizePhoneNumber(contact.phoneNumber);}catch{throw new BadRequestException('Your Admin contact does not have a valid E.164 phone number');}const requestId=randomUUID();await this.queue.publish(EVENT_TOPICS.notificationTestCallRequested,{id:requestId,payload:{requestId,organizationId:user.organizationId,userId:user.id}});await this.audit.record({user,action:'voice-agent.test-call.requested',resourceType:'notification-test-call',resourceId:requestId,metadata:{recipientId:contact.id}});return{requestId,status:'QUEUED',maskedPhoneNumber:maskPhone(contact.phoneNumber)};}
}

function maskPhone(value:string){const digits=value.replace(/\D/g,'');return digits.length<4?'••••':`+${'•'.repeat(Math.max(2,digits.length-4))}${digits.slice(-4)}`;}
