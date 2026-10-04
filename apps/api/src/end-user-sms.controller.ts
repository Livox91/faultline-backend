import {randomUUID} from 'node:crypto';
import {BadRequestException,Body,Controller,Delete,Get,Header,HttpCode,Inject,NotFoundException,Param,Post,UploadedFile,UseInterceptors} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {PDFParse} from 'pdf-parse';
import {FEATURES} from '@faultline/billing';
import {ROLES,type AuthenticatedUser} from '@faultline/auth';
import type {ClusterDirectory} from '@faultline/database';
import {END_USER_CONTACT_REPOSITORY,INCIDENT_COMMUNICATION_REPOSITORY,NOTIFICATION_PROVIDER_STATUS_REPOSITORY,normalizePhoneNumber,type EndUserContactRepository,type IncidentCommunicationRepository,type NotificationProviderStatusRepository} from '@faultline/notifications';
import {EVENT_TOPICS,QUEUE,type Queue} from '@faultline/queue';
import {CurrentUser,RequiresFeature,Roles} from './auth/context';
import {CLUSTER_DIRECTORY} from './clusters.controller';
import {presentNotificationProviderStatus} from './notification-provider-status';

type UploadRow={name:unknown;email:unknown;contact:unknown;service:unknown};
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller('clusters/:id/sms-agent')
@Roles(ROLES.ADMIN)
@RequiresFeature(FEATURES.VOICE_AGENT)
export class EndUserSmsController{
  constructor(@Inject(CLUSTER_DIRECTORY)private readonly clusters:ClusterDirectory,@Inject(END_USER_CONTACT_REPOSITORY)private readonly contacts:EndUserContactRepository,@Inject(NOTIFICATION_PROVIDER_STATUS_REPOSITORY)private readonly statuses:NotificationProviderStatusRepository,@Inject(INCIDENT_COMMUNICATION_REPOSITORY)private readonly communications:IncidentCommunicationRepository,@Inject(QUEUE)private readonly queue:Queue){}
  @Get()@Header('Cache-Control','no-store')async dashboard(@Param('id')clusterId:string,@CurrentUser()user:AuthenticatedUser){await this.cluster(clusterId,user.organizationId);const[contacts,status,communications]=await Promise.all([this.contacts.listForCluster(clusterId,user.organizationId),this.statuses.get(user.organizationId),this.communications.listRecent(user.organizationId,250)]);const ids=new Set(contacts.map(item=>item.id));return{clusterId,status:presentNotificationProviderStatus(status,user.organizationId),contacts,deliveries:communications.filter(item=>item.channel==='SMS'&&item.audience==='END_USER'&&ids.has(item.recipientId)).slice(0,100)};}
  @Post('contacts/import')@UseInterceptors(FileInterceptor('file',{limits:{fileSize:5*1024*1024,files:1}}))async import(@Param('id')clusterId:string,@CurrentUser()user:AuthenticatedUser,@UploadedFile()file?:Express.Multer.File,@Body()body?:Record<string,unknown>){await this.cluster(clusterId,user.organizationId);if(body?.consentConfirmed!=='true')throw new BadRequestException('Confirm that every uploaded recipient has opted in to service-status SMS');if(!file)throw new BadRequestException('Choose a CSV, JSON, or PDF file');const rows=await parseUpload(file);if(!rows.length)throw new BadRequestException('The file contains no contact rows');if(rows.length>5000)throw new BadRequestException('A file may contain at most 5,000 contacts');const errors:string[]=[];const values=[];const now=new Date().toISOString();for(let index=0;index<rows.length;index++){try{const row=validateRow(rows[index]!,index+2);values.push(await this.contacts.upsert({id:randomUUID(),organizationId:user.organizationId,clusterId,...row,enabled:true,createdAt:now,updatedAt:now}));}catch(error){errors.push(error instanceof Error?error.message:`Row ${index+2} is invalid`);}}return{imported:values.length,rejected:errors.length,errors:errors.slice(0,100),contacts:values};}
  @Delete('contacts/:contactId')@HttpCode(204)async remove(@Param('id')clusterId:string,@Param('contactId')contactId:string,@CurrentUser()user:AuthenticatedUser){await this.cluster(clusterId,user.organizationId);if(!(await this.contacts.remove(contactId,clusterId,user.organizationId)))throw new NotFoundException('End-user contact not found');}
  @Post('test')@HttpCode(202)async test(@Param('id')clusterId:string,@CurrentUser()user:AuthenticatedUser){await this.cluster(clusterId,user.organizationId);const contact=(await this.contacts.listForCluster(clusterId,user.organizationId)).find(item=>item.enabled);if(!contact)throw new BadRequestException('Upload at least one enabled end-user contact first');const requestId=randomUUID();await this.queue.publish(EVENT_TOPICS.notificationTestSmsRequested,{id:requestId,payload:{requestId,organizationId:user.organizationId,clusterId,contactId:contact.id}});return{requestId,status:'QUEUED',recipient:mask(contact.phoneNumber)};}
  private async cluster(id:string,organizationId:string){const value=await this.clusters.get(id,organizationId);if(!value)throw new NotFoundException('Cluster not found');return value;}
}

async function parseUpload(file:Express.Multer.File):Promise<UploadRow[]>{
  const name=file.originalname.toLowerCase();
  if(name.endsWith('.json')||file.mimetype==='application/json'){let value:unknown;try{value=JSON.parse(file.buffer.toString('utf8'));}catch{throw new BadRequestException('JSON file is not valid JSON');}const rows=Array.isArray(value)?value:(value&&typeof value==='object'&&Array.isArray((value as {contacts?:unknown}).contacts)?(value as {contacts:UploadRow[]}).contacts:undefined);if(!rows)throw new BadRequestException('JSON must be an array or an object with a contacts array');return rows as UploadRow[];}
  let text:string;
  if(name.endsWith('.pdf')||file.mimetype==='application/pdf'){const parser=new PDFParse({data:file.buffer});try{text=(await parser.getText()).text;}catch{throw new BadRequestException('PDF text could not be extracted; use a text-based PDF, CSV, or JSON');}finally{await parser.destroy();}}
  else if(name.endsWith('.csv')||['text/csv','application/csv','application/vnd.ms-excel'].includes(file.mimetype))text=file.buffer.toString('utf8');
  else throw new BadRequestException('Only CSV, JSON, and PDF files are accepted');
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);if(!lines.length)return[];
  const delimiter=lines[0]!.includes('|')?'|':lines[0]!.includes('\t')?'\t':',';
  const records=lines.map(line=>parseDelimited(line,delimiter));const header=records.shift()!.map(value=>value.trim().toLowerCase());
  const required=['name','email','contact','service'];if(required.some(field=>!header.includes(field)))throw new BadRequestException('Header must contain exactly: name, email, contact, service');
  return records.map(record=>Object.fromEntries(required.map(field=>[field,record[header.indexOf(field)]])) as UploadRow);
}
function parseDelimited(line:string,delimiter:string){const values:string[]=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const char=line[i]!;if(char==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(char===delimiter&&!quoted){values.push(value.trim());value='';}else value+=char;}values.push(value.trim());return values;}
function validateRow(row:UploadRow,line:number){if(!row||typeof row!=='object')throw new Error(`Row ${line}: expected an object`);const name=String(row.name??'').trim(),email=String(row.email??'').trim().toLowerCase(),service=String(row.service??'').trim();if(!name||name.length>200)throw new Error(`Row ${line}: name is required (max 200 characters)`);if(!EMAIL.test(email)||email.length>320)throw new Error(`Row ${line}: email is invalid`);if(!service||service.length>200)throw new Error(`Row ${line}: service is required (max 200 characters)`);let phoneNumber:string;try{phoneNumber=normalizePhoneNumber(String(row.contact??''));}catch{throw new Error(`Row ${line}: contact must be an E.164 phone number such as +15551234567`);}return{name,email,phoneNumber,service};}
function mask(value:string){return value.length<5?'••••':`${value.slice(0,2)}••••${value.slice(-4)}`;}
