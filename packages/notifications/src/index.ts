import type { Incident } from '@faultline/incidents';
export * from './on-call';
import type { OnCallResolver } from './on-call';

export type NotificationChannel = 'VOICE' | 'SMS';
export type NotificationStatus =
  | 'PENDING' | 'SENT' | 'IN_PROGRESS' | 'DELIVERED' | 'ANSWERED'
  | 'ACKNOWLEDGED' | 'DECLINED' | 'COMPLETED'
  | 'FAILED' | 'NO_ANSWER' | 'CANCELLED';
export type VoiceAction = 'ACKNOWLEDGE_INCIDENT' | 'DECLINE_INCIDENT' | 'UNKNOWN';
export interface VoiceActionRequest { incidentId: string; notificationAttemptId: string; recipientId: string; action: VoiceAction; providerCallId: string; timestamp: string; }
export type NotificationAudience = 'ENGINEERING' | 'STAKEHOLDER' | 'END_USER';
export type ContactRole = 'ENGINEER' | 'SENIOR_ENGINEER' | 'TEAM_LEAD' | 'MANAGER' | 'STAKEHOLDER' | 'END_USER';
export interface ContactMethod { phoneNumber: string; smsEnabled: boolean; voiceEnabled: boolean; }
export interface Contact extends ContactMethod {
  id: string; organizationId: string; name: string; role: ContactRole; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface NotificationGroup {
  id: string; organizationId: string; name: string; contactIds: readonly string[]; enabled: boolean; createdAt: string; updatedAt: string;
}
export type IncidentCommunicationState = 'OPEN'|'ACKNOWLEDGED'|'INVESTIGATING'|'IDENTIFIED'|'MITIGATING'|'MONITORING'|'RESOLVED';
export type IncidentLifecycleEventType = 'INCIDENT_CREATED'|'INCIDENT_ACKNOWLEDGED'|'INCIDENT_STATUS_CHANGED'|'INCIDENT_SEVERITY_CHANGED'|'INCIDENT_ETA_UPDATED'|'INCIDENT_RESOLVED';
export interface IncidentLifecycleEvent { id:string; type:IncidentLifecycleEventType; incident:Incident; state:IncidentCommunicationState; previousState?:IncidentCommunicationState; previousSeverity?:Incident['severity']; previousEstimatedRestorationAt?:string; occurredAt:string; changedFields:readonly string[]; }
export type CommunicationType = 'INITIAL'|'STATUS_UPDATE'|'ETA_UPDATE'|'RESOLUTION';
export type CommunicationSubscription = 'INITIAL'|'STATUS_UPDATES'|'RESOLUTION';
export interface AudienceCommunicationRule { audience:NotificationAudience; target:{type:'CONTACT'|'GROUP';id:string}; channels:readonly NotificationChannel[]; subscriptions:readonly CommunicationSubscription[]; services?:readonly string[]; minimumIntervalMs?:number; }

export interface NotificationRecipient {
  id: string;
  name: string;
  phoneNumber: string;
  audience: NotificationAudience;
}

export interface EscalationStep {
  id: string;
  order: number;
  target: { type: 'CONTACT' | 'GROUP' | 'ON_CALL_SCHEDULE'; id: string };
  channels: readonly NotificationChannel[];
  maximumAttempts: number;
  retryDelayMs: number;
  waitBeforeNextStepMs: number;
}

export interface EscalationPolicy {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  match: { severities: readonly Incident['severity'][]; environments?: readonly string[]; services?: readonly string[]; classifications?: readonly Incident['classification'][] };
  steps: readonly EscalationStep[];
  sendResolution: boolean;
  communicationRules?: readonly AudienceCommunicationRule[];
  createdAt: string;
  updatedAt: string;
}
export interface IncidentCommunication { id:string; incidentId:string; audience:NotificationAudience; channel:NotificationChannel; recipientId:string; communicationType:CommunicationType; messageVersion:string; status:'PENDING'|'SENT'|'FAILED'|'SUPPRESSED'; createdAt:string; sentAt?:string; providerRequestId?:string; dedupeKey:string; }
export interface IncidentCommunicationRepository { save(value:IncidentCommunication):Promise<IncidentCommunication>; findByDedupeKey(key:string):Promise<IncidentCommunication|undefined>; listForIncident(incidentId:string):Promise<readonly IncidentCommunication[]>; }
export class InMemoryIncidentCommunicationRepository implements IncidentCommunicationRepository { private readonly values=new Map<string,IncidentCommunication>();async save(value:IncidentCommunication){this.values.set(value.id,structuredClone(value));return structuredClone(value);}async findByDedupeKey(key:string){const value=[...this.values.values()].find((item)=>item.dedupeKey===key);return value?structuredClone(value):undefined;}async listForIncident(id:string){return[...this.values.values()].filter((item)=>item.incidentId===id).map((item)=>structuredClone(item));}}

export interface NotificationRequest {
  incident: Incident;
  escalationPolicy: EscalationPolicy;
  resolution?: boolean;
}

export interface NotificationAttempt {
  id: string;
  incidentId: string;
  recipientId: string;
  escalationStep: number;
  channel: NotificationChannel;
  provider: string;
  providerRequestId?: string;
  status: NotificationStatus;
  attemptNumber: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface NotificationAttemptRepository {
  save(attempt: NotificationAttempt): Promise<NotificationAttempt>;
  get(id: string): Promise<NotificationAttempt | undefined>;
  findByProviderRequestId(id: string): Promise<NotificationAttempt | undefined>;
  listForIncident(incidentId: string): Promise<readonly NotificationAttempt[]>;
  updateStatus(id:string,status:NotificationStatus,completedAt?:string,metadata?:Readonly<Record<string,unknown>>):Promise<{attempt:NotificationAttempt;changed:boolean}>;
  listRecoverable(staleBefore:string):Promise<readonly NotificationAttempt[]>;
  purgeCompleted(before:string):Promise<number>;
}

export interface ContactRepository { create(contact: Contact): Promise<Contact>; update(contact: Contact): Promise<Contact>; get(id: string): Promise<Contact | undefined>; list(organizationId?: string): Promise<readonly Contact[]>; }
export interface NotificationGroupRepository { create(group: NotificationGroup): Promise<NotificationGroup>; update(group: NotificationGroup): Promise<NotificationGroup>; get(id: string): Promise<NotificationGroup | undefined>; list(organizationId?: string): Promise<readonly NotificationGroup[]>; }
export interface EscalationPolicyRepository { create(policy: EscalationPolicy): Promise<EscalationPolicy>; update(policy: EscalationPolicy): Promise<EscalationPolicy>; get(id: string): Promise<EscalationPolicy | undefined>; list(organizationId?: string): Promise<readonly EscalationPolicy[]>; }

export type EscalationExecutionStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'EXHAUSTED' | 'CANCELLED' | 'RESOLVED';
export interface EscalationExecution { incidentId: string; policyId: string; currentStep: number; attemptCount:number; status: EscalationExecutionStatus; nextAttemptAt?:string; leaseOwner?:string; leaseExpiresAt?:string; startedAt: string; updatedAt:string; lastAttemptAt?: string; completedAt?: string; }
export interface EscalationExecutionRepository { save(execution: EscalationExecution): Promise<EscalationExecution>; get(incidentId: string): Promise<EscalationExecution | undefined>; listDue(now:string):Promise<readonly EscalationExecution[]>; claimDue(incidentId:string,workerId:string,now:string,leaseUntil:string):Promise<EscalationExecution|undefined>; }
export interface IncidentAcknowledgement { incidentId: string; acknowledgedBy: string; acknowledgedAt: string; notificationAttemptId?: string; providerCallId?: string; channel?: 'VOICE'; note?: string; }
export interface IncidentAcknowledgementRepository { save(value: IncidentAcknowledgement): Promise<IncidentAcknowledgement>; get(incidentId: string): Promise<IncidentAcknowledgement | undefined>; }
export interface AcknowledgementTransaction { acknowledge(input:{acknowledgement:IncidentAcknowledgement;execution:EscalationExecution;attempt?:NotificationAttempt;events:readonly NotificationAuditEvent[]}):Promise<void>; }
export type NotificationAuditEventType = 'POLICY_SELECTED' | 'CONTACT_RESOLVED' | 'CONTACT_SKIPPED' | 'CALL_REQUESTED' | 'SMS_REQUESTED' | 'CALL_ANSWERED' | 'VOICE_CALL_ANSWERED' | 'ACKNOWLEDGEMENT_REQUESTED' | 'CALL_FAILED' | 'RETRY_SCHEDULED' | 'ESCALATION_ADVANCED' | 'INCIDENT_ACKNOWLEDGED' | 'INCIDENT_DECLINED' | 'ACKNOWLEDGEMENT_REJECTED' | 'ESCALATION_STOPPED' | 'INCIDENT_RESOLVED';
export interface NotificationAuditEvent { id: string; incidentId: string; type: NotificationAuditEventType; timestamp: string; policyId?: string; stepId?: string; contactId?: string; attemptId?: string; details?: Readonly<Record<string, unknown>>; }
export interface NotificationAuditRepository { append(event: NotificationAuditEvent): Promise<void>; list(incidentId: string): Promise<readonly NotificationAuditEvent[]>; purge(before:string):Promise<number>; }

class InMemoryCrudRepository<T extends { id: string; organizationId: string }> {
  protected readonly values = new Map<string, T>();
  async create(value: T): Promise<T> { if (this.values.has(value.id)) throw new Error('Entity already exists'); this.values.set(value.id, structuredClone(value)); return structuredClone(value); }
  async update(value: T): Promise<T> { if (!this.values.has(value.id)) throw new Error('Entity not found'); this.values.set(value.id, structuredClone(value)); return structuredClone(value); }
  async get(id: string): Promise<T | undefined> { const value = this.values.get(id); return value ? structuredClone(value) : undefined; }
  async list(organizationId?: string): Promise<readonly T[]> { return [...this.values.values()].filter((value) => !organizationId || value.organizationId === organizationId).map((value) => structuredClone(value)); }
}
export class InMemoryContactRepository extends InMemoryCrudRepository<Contact> implements ContactRepository {}
export class InMemoryNotificationGroupRepository extends InMemoryCrudRepository<NotificationGroup> implements NotificationGroupRepository {}
export class InMemoryEscalationPolicyRepository extends InMemoryCrudRepository<EscalationPolicy> implements EscalationPolicyRepository {}
export class InMemoryEscalationExecutionRepository implements EscalationExecutionRepository { private readonly values = new Map<string, EscalationExecution>(); async save(value: EscalationExecution) { this.values.set(value.incidentId, structuredClone(value)); return structuredClone(value); } async get(id: string) { const value = this.values.get(id); return value ? structuredClone(value) : undefined; } async listDue(now:string){return[...this.values.values()].filter((v)=>v.status==='ACTIVE'&&!!v.nextAttemptAt&&v.nextAttemptAt<=now&&(!v.leaseExpiresAt||v.leaseExpiresAt<=now)).map(v=>structuredClone(v));}async claimDue(id:string,owner:string,now:string,until:string){const v=this.values.get(id);if(!v||v.status!=='ACTIVE'||!v.nextAttemptAt||v.nextAttemptAt>now||v.leaseExpiresAt&&v.leaseExpiresAt>now)return undefined;return this.save({...v,leaseOwner:owner,leaseExpiresAt:until,updatedAt:now});} }
export class InMemoryIncidentAcknowledgementRepository implements IncidentAcknowledgementRepository { private readonly values = new Map<string, IncidentAcknowledgement>(); async save(value: IncidentAcknowledgement) { this.values.set(value.incidentId, structuredClone(value)); return structuredClone(value); } async get(id: string) { const value = this.values.get(id); return value ? structuredClone(value) : undefined; } }
export class InMemoryNotificationAuditRepository implements NotificationAuditRepository { private readonly values: NotificationAuditEvent[] = []; async append(value: NotificationAuditEvent) { this.values.push(structuredClone(value)); } async list(id: string) { return this.values.filter((value) => value.incidentId === id).map((value) => structuredClone(value)); } async purge(before:string){const old=this.values.length;for(let i=this.values.length-1;i>=0;i--)if(this.values[i]!.timestamp<before)this.values.splice(i,1);return old-this.values.length;} }

export function normalizePhoneNumber(value: string): string {
  const normalized = value.trim().replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error('Phone number must be valid E.164');
  return normalized;
}
export function contactAudience(role: ContactRole): NotificationAudience {
  return role === 'END_USER' ? 'END_USER' : role === 'STAKEHOLDER' || role === 'MANAGER' ? 'STAKEHOLDER' : 'ENGINEERING';
}
export interface PolicySelector { select(incident: Incident, organizationId: string): Promise<EscalationPolicy | undefined>; }
export class RepositoryPolicySelector implements PolicySelector {
  constructor(private readonly policies: EscalationPolicyRepository) {}
  async select(incident: Incident, organizationId: string): Promise<EscalationPolicy | undefined> {
    const service = incident.primaryResource.workload; const environment = incident.clusterId;
    return (await this.policies.list(organizationId)).filter((policy) => policy.enabled && policy.match.severities.includes(incident.severity)
      && (!policy.match.environments?.length || policy.match.environments.includes(environment))
      && (!policy.match.services?.length || (!!service && policy.match.services.includes(service)))
      && (!policy.match.classifications?.length || policy.match.classifications.includes(incident.classification)))
      .sort((a, b) => policySpecificity(b) - policySpecificity(a))[0];
  }
}
function policySpecificity(policy: EscalationPolicy): number { return (policy.match.environments?.length ? 1 : 0) + (policy.match.services?.length ? 1 : 0) + (policy.match.classifications?.length ? 1 : 0); }
export interface ResolvedRecipient { recipient: NotificationRecipient; channels: readonly NotificationChannel[]; }
export interface SkippedRecipient { contactId: string; reason: string; }
export class RecipientResolver {
  constructor(private readonly contacts: ContactRepository, private readonly groups: NotificationGroupRepository, private readonly onCall?:OnCallResolver) {}
  async resolve(step: EscalationStep, at=new Date().toISOString()): Promise<{ recipients: readonly ResolvedRecipient[]; skipped: readonly SkippedRecipient[] }> {
    let ids: readonly string[];
    if (step.target.type === 'CONTACT') ids = [step.target.id];
    else if(step.target.type==='GROUP') {
      const group = await this.groups.get(step.target.id);
      if (!group) return { recipients: [], skipped: [{ contactId: step.target.id, reason: 'GROUP_NOT_FOUND' }] };
      if (!group.enabled) return { recipients: [], skipped: [{ contactId: step.target.id, reason: 'GROUP_DISABLED' }] };
      ids = group.contactIds;
    } else {const assignment=await this.onCall?.resolve(step.target.id,at);if(!assignment)return{recipients:[],skipped:[{contactId:step.target.id,reason:'NO_ACTIVE_ON_CALL'}]};ids=[assignment.contactId];}
    const recipients: ResolvedRecipient[] = []; const skipped: SkippedRecipient[] = [];
    for (const id of [...new Set(ids)]) {
      const contact = await this.contacts.get(id);
      if (!contact) { skipped.push({ contactId: id, reason: 'CONTACT_NOT_FOUND' }); continue; }
      if (!contact.enabled) { skipped.push({ contactId: id, reason: 'CONTACT_DISABLED' }); continue; }
      let phoneNumber: string; try { phoneNumber = normalizePhoneNumber(contact.phoneNumber); } catch { skipped.push({ contactId: id, reason: 'INVALID_PHONE_NUMBER' }); continue; }
      const channels = step.channels.filter((channel) => channel === 'VOICE' ? contact.voiceEnabled : contact.smsEnabled);
      if (!channels.length) { skipped.push({ contactId: id, reason: 'CHANNEL_DISABLED' }); continue; }
      recipients.push({ recipient: { id: contact.id, name: contact.name, phoneNumber, audience: contactAudience(contact.role) }, channels });
    }
    return { recipients, skipped };
  }
}

export class InMemoryNotificationAttemptRepository implements NotificationAttemptRepository {
  private readonly attempts = new Map<string, NotificationAttempt>();
  async save(attempt: NotificationAttempt): Promise<NotificationAttempt> {
    this.attempts.set(attempt.id, structuredClone(attempt));
    return structuredClone(attempt);
  }
  async get(id: string): Promise<NotificationAttempt | undefined> {
    const value = this.attempts.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async findByProviderRequestId(id: string): Promise<NotificationAttempt | undefined> {
    const value = [...this.attempts.values()].find((attempt) => attempt.providerRequestId === id);
    return value ? structuredClone(value) : undefined;
  }
  async listForIncident(incidentId: string): Promise<readonly NotificationAttempt[]> {
    return [...this.attempts.values()].filter((attempt) => attempt.incidentId === incidentId).map((attempt) => structuredClone(attempt));
  }
  async updateStatus(id:string,status:NotificationStatus,completedAt?:string,metadata?:Readonly<Record<string,unknown>>){const current=this.attempts.get(id);if(!current)throw new Error('Notification attempt not found');if(current.status===status||!canTransitionNotificationStatus(current.status,status))return{attempt:structuredClone(current),changed:false};const attempt={...current,status,...(completedAt?{completedAt}:{}),...(metadata?{metadata:sanitizeProviderMetadata(metadata)}:{})};await this.save(attempt);return{attempt,changed:true};}
  async listRecoverable(staleBefore:string){return[...this.attempts.values()].filter((a)=>a.status==='PENDING'||a.status==='IN_PROGRESS'&&!!a.startedAt&&a.startedAt<staleBefore).map(a=>structuredClone(a));}
  async purgeCompleted(before:string){let count=0;for(const[id,a]of this.attempts)if(a.completedAt&&a.completedAt<before){this.attempts.delete(id);count++;}return count;}
}

const transitionRank:Record<NotificationStatus,number>={PENDING:0,SENT:1,IN_PROGRESS:2,ANSWERED:3,COMPLETED:4,DELIVERED:4,ACKNOWLEDGED:5,DECLINED:5,FAILED:5,NO_ANSWER:5,CANCELLED:5};
const terminalStatuses=new Set<NotificationStatus>(['COMPLETED','DELIVERED','ACKNOWLEDGED','DECLINED','FAILED','NO_ANSWER','CANCELLED']);
export function canTransitionNotificationStatus(from:NotificationStatus,to:NotificationStatus):boolean{return from===to||!terminalStatuses.has(from)&&transitionRank[to]>=transitionRank[from];}
export function sanitizeProviderMetadata(value:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>{const allowed=['call_id','chat_id','disconnection_reason','status','event'];return Object.fromEntries(allowed.filter((key)=>Object.hasOwn(value,key)).map((key)=>[key,value[key]]));}

export interface NotificationPolicy {
  shouldNotify(incident: Incident): boolean;
}

export class SeverityNotificationPolicy implements NotificationPolicy {
  constructor(private readonly highEscalationEnabled = false) {}
  shouldNotify(incident: Incident): boolean {
    return incident.status !== 'RESOLVED' &&
      (incident.severity === 'CRITICAL' || (incident.severity === 'HIGH' && this.highEscalationEnabled));
  }
}

export interface VoiceCallInput {
  recipient: NotificationRecipient;
  message: string;
  context: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, string>>;
}
export interface SmsInput { recipient: NotificationRecipient; message: string; metadata: Readonly<Record<string, string>>; }
export interface ProviderResult { requestId: string; status: NotificationStatus; metadata?: Readonly<Record<string, unknown>>; }
export interface CommunicationProvider {
  readonly name: string;
  startVoiceCall(input: VoiceCallInput): Promise<ProviderResult>;
  sendSms(input: SmsInput): Promise<ProviderResult>;
  getCallStatus(requestId: string): Promise<ProviderResult>;
}

export interface IdempotencyStore {
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface IncidentTicketPayload {
  incidentId: string;
}

export interface ExternalTicket {
  id: string;
  provider: 'slack';
  externalMessageId: string;
  incidentId: string;
  channelId: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
}

export interface ExternalTicketRepository {
  findByIncidentAndProvider(
    incidentId: string,
    provider: ExternalTicket['provider'],
  ): Promise<ExternalTicket | undefined>;
  /** Persists a ticket or returns the record that already owns the unique incident/provider key. */
  saveIfAbsent(ticket: ExternalTicket): Promise<ExternalTicket>;
  markUpdated(id: string, updatedAt: string): Promise<ExternalTicket | undefined>;
}

export class InMemoryExternalTicketRepository
  implements ExternalTicketRepository
{
  private readonly values = new Map<string, ExternalTicket>();
  private key(incidentId: string, provider: ExternalTicket['provider']) {
    return `${incidentId}:${provider}`;
  }
  async findByIncidentAndProvider(
    incidentId: string,
    provider: ExternalTicket['provider'],
  ): Promise<ExternalTicket | undefined> {
    const value = this.values.get(this.key(incidentId, provider));
    return value ? structuredClone(value) : undefined;
  }
  async saveIfAbsent(ticket: ExternalTicket): Promise<ExternalTicket> {
    const key = this.key(ticket.incidentId, ticket.provider);
    const existing = this.values.get(key);
    if (existing) return structuredClone(existing);
    this.values.set(key, structuredClone(ticket));
    return structuredClone(ticket);
  }
  async markUpdated(id: string, updatedAt: string): Promise<ExternalTicket | undefined> {
    const entry = [...this.values.entries()].find(([, value]) => value.id === id);
    if (!entry) return undefined;
    const updated = { ...entry[1], updatedAt };
    this.values.set(entry[0], updated);
    return structuredClone(updated);
  }
}

export interface IncidentTicketUpdatePayload {
  incidentId: string;
  state: IncidentCommunicationState;
}

/** Create-only external incident ticket boundary. Updates and threads are intentionally absent. */
export interface IncidentTicketPublisher {
  createIncidentTicket(
    payload: IncidentTicketPayload,
  ): Promise<ExternalTicket | undefined>;
  updateIncidentTicket(
    payload: IncidentTicketUpdatePayload,
  ): Promise<ExternalTicket | undefined>;
  publishTimelineUpdates(event: IncidentLifecycleEvent): Promise<void>;
}
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Set<string>();
  async claim(key: string): Promise<boolean> { if (this.keys.has(key)) return false; this.keys.add(key); return true; }
  async release(key: string): Promise<void> { this.keys.delete(key); }
}

export const NOTIFICATION_POLICY = Symbol('faultline.notification-policy');
export const COMMUNICATION_PROVIDER = Symbol('faultline.communication-provider');
export const NOTIFICATION_ATTEMPTS = Symbol('faultline.notification-attempts');
export const IDEMPOTENCY_STORE = Symbol('faultline.notification-idempotency');
export const INCIDENT_TICKET_PUBLISHER = Symbol(
  'faultline.incident-ticket-publisher',
);
export const EXTERNAL_TICKET_REPOSITORY = Symbol(
  'faultline.external-ticket-repository',
);
export const CONTACT_REPOSITORY = Symbol('faultline.contact-repository');
export const NOTIFICATION_GROUP_REPOSITORY = Symbol('faultline.notification-group-repository');
export const ESCALATION_POLICY_REPOSITORY = Symbol('faultline.escalation-policy-repository');
export const ESCALATION_EXECUTION_REPOSITORY = Symbol('faultline.escalation-execution-repository');
export const INCIDENT_ACKNOWLEDGEMENTS = Symbol('faultline.incident-acknowledgements');
export const NOTIFICATION_AUDIT_REPOSITORY = Symbol('faultline.notification-audit-repository');
export const POLICY_SELECTOR = Symbol('faultline.policy-selector');
export const INCIDENT_COMMUNICATION_REPOSITORY = Symbol('faultline.incident-communication-repository');
export const ACKNOWLEDGEMENT_TRANSACTION = Symbol('faultline.acknowledgement-transaction');
