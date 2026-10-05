import { randomUUID } from 'node:crypto';
import { BadRequestException,Body,Controller,Get,Header,HttpCode,Inject,Post } from '@nestjs/common';
import { ROLES,type AuthenticatedUser } from '@faultline/auth';
import { FEATURES } from '@faultline/billing';
import { CONTACT_REPOSITORY,INCIDENT_COMMUNICATION_REPOSITORY,NOTIFICATION_PROVIDER_STATUS_REPOSITORY,normalizePhoneNumber,type ContactRepository,type IncidentCommunicationRepository,type NotificationProviderStatusRepository } from '@faultline/notifications';
import { EVENT_TOPICS,QUEUE,type Queue } from '@faultline/queue';
import { CurrentUser,RequiresFeature,Roles } from './auth/context';
import { AuditTrail } from './auth/audit-trail';
import {presentNotificationProviderStatus} from './notification-provider-status';

@Controller('voice-agent')
@Roles(ROLES.ADMIN)
@RequiresFeature(FEATURES.VOICE_AGENT)
export class VoiceAgentController{
  constructor(@Inject(NOTIFICATION_PROVIDER_STATUS_REPOSITORY)private readonly statuses:NotificationProviderStatusRepository,@Inject(INCIDENT_COMMUNICATION_REPOSITORY)private readonly communications:IncidentCommunicationRepository,@Inject(CONTACT_REPOSITORY)private readonly contacts:ContactRepository,@Inject(QUEUE)private readonly queue:Queue,private readonly audit:AuditTrail){}
  @Get('status')@Header('Cache-Control','no-store')async status(@CurrentUser()user:AuthenticatedUser){return presentNotificationProviderStatus(await this.statuses.get(user.organizationId),user.organizationId);}
  @Get('deliveries')@Header('Cache-Control','no-store')async deliveries(@CurrentUser()user:AuthenticatedUser){const values=await this.communications.listRecent(user.organizationId,100);const contacts=await this.contacts.list(user.organizationId);const byId=new Map(contacts.map((contact)=>[contact.id,contact]));return values.filter((value)=>value.channel==='VOICE').map((value)=>{const contact=byId.get(value.recipientId);return{id:value.id,incidentId:value.incidentId,sreName:contact?.name??value.recipientDisplayName??'Unknown recipient',maskedPhoneNumber:contact?maskPhone(contact.phoneNumber):value.maskedPhoneNumber??'Unavailable',status:value.status,timestamp:value.sentAt??value.createdAt,isTest:value.communicationType==='TEST'};});}
  @Post('test-call')@HttpCode(202)async testCall(@CurrentUser()user:AuthenticatedUser,@Body()body:unknown){const supplied=body&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).phoneNumber:undefined;if(typeof supplied!=='string')throw new BadRequestException('phoneNumber is required');let phoneNumber:string;try{phoneNumber=normalizePhoneNumber(supplied);}catch{throw new BadRequestException('Enter a valid international E.164 phone number');}const requestId=randomUUID();const maskedPhoneNumber=maskPhone(phoneNumber);await this.queue.publish(EVENT_TOPICS.notificationTestCallRequested,{id:requestId,payload:{requestId,organizationId:user.organizationId,phoneNumber}});await this.audit.record({user,action:'voice-agent.test-call.requested',resourceType:'notification-test-call',resourceId:requestId,metadata:{maskedPhoneNumber}});return{requestId,status:'QUEUED',maskedPhoneNumber};}
}

function maskPhone(value:string){const digits=value.replace(/\D/g,'');return digits.length<4?'••••':`+${'•'.repeat(Math.max(2,digits.length-4))}${digits.slice(-4)}`;}
