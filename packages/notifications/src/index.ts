import type { Incident } from '@faultline/incidents';
export * from './on-call';

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
  id: string; organizationId: string; userId?: string; name: string; role: ContactRole; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface EndUserContact {
  id:string; organizationId:string; clusterId:string; name:string; email:string;
  phoneNumber:string; service:string; enabled:boolean; createdAt:string; updatedAt:string;
}
export interface EndUserContactRepository {
  upsert(contact:EndUserContact):Promise<EndUserContact>;
  get(id:string):Promise<EndUserContact|undefined>;
  listForCluster(clusterId:string,organizationId:string):Promise<readonly EndUserContact[]>;
  remove(id:string,clusterId:string,organizationId:string):Promise<boolean>;
}
export class InMemoryEndUserContactRepository implements EndUserContactRepository {
  private readonly values=new Map<string,EndUserContact>();
  async upsert(value:EndUserContact){const duplicate=[...this.values.values()].find(item=>item.clusterId===value.clusterId&&item.phoneNumber===value.phoneNumber&&item.service.toLowerCase()===value.service.toLowerCase());const saved=duplicate?{...value,id:duplicate.id,createdAt:duplicate.createdAt}:value;this.values.set(saved.id,structuredClone(saved));return structuredClone(saved);}
  async get(id:string){const value=this.values.get(id);return value?structuredClone(value):undefined;}
  async listForCluster(clusterId:string,organizationId:string){return[...this.values.values()].filter(value=>value.clusterId===clusterId&&value.organizationId===organizationId).map(value=>structuredClone(value));}
  async remove(id:string,clusterId:string,organizationId:string){const value=this.values.get(id);return!!value&&value.clusterId===clusterId&&value.organizationId===organizationId&&this.values.delete(id);}
}
export interface NotificationGroup {
  id: string; organizationId: string; name: string; contactIds: readonly string[]; enabled: boolean; createdAt: string; updatedAt: string;
}
export type IncidentCommunicationState = 'OPEN'|'ACKNOWLEDGED'|'INVESTIGATING'|'IDENTIFIED'|'MITIGATING'|'MONITORING'|'RESOLVED';
export type IncidentLifecycleEventType = 'INCIDENT_CREATED'|'INCIDENT_ACKNOWLEDGED'|'INCIDENT_STATUS_CHANGED'|'INCIDENT_SEVERITY_CHANGED'|'INCIDENT_ETA_UPDATED'|'INCIDENT_RESOLVED';
export interface IncidentLifecycleEvent { id:string; type:IncidentLifecycleEventType; incident:Incident; state:IncidentCommunicationState; previousState?:IncidentCommunicationState; previousSeverity?:Incident['severity']; previousEstimatedRestorationAt?:string; occurredAt:string; changedFields:readonly string[]; }
export type CommunicationType = 'INITIAL'|'STATUS_UPDATE'|'ETA_UPDATE'|'RESOLUTION'|'TEST';

export interface NotificationRecipient {
  id: string;
  name: string;
  phoneNumber: string;
  audience: NotificationAudience;
}

export type IncidentCommunicationStatus = NotificationStatus | 'SUPPRESSED';
export interface IncidentCommunication { id:string; incidentId:string; organizationId:string; audience:NotificationAudience; channel:NotificationChannel; recipientId:string; recipientDisplayName?:string; maskedPhoneNumber?:string; communicationType:CommunicationType; messageVersion:string; status:IncidentCommunicationStatus; createdAt:string; sentAt?:string; providerRequestId?:string; dedupeKey:string; }
export interface IncidentCommunicationRepository { save(value:IncidentCommunication):Promise<IncidentCommunication>; findByDedupeKey(key:string):Promise<IncidentCommunication|undefined>; findByProviderRequestId(id:string):Promise<IncidentCommunication|undefined>; listForIncident(incidentId:string):Promise<readonly IncidentCommunication[]>; listRecent(organizationId:string,limit:number):Promise<readonly IncidentCommunication[]>; }
export class InMemoryIncidentCommunicationRepository implements IncidentCommunicationRepository { private readonly values=new Map<string,IncidentCommunication>();async save(value:IncidentCommunication){this.values.set(value.id,structuredClone(value));return structuredClone(value);}async findByDedupeKey(key:string){const value=[...this.values.values()].find((item)=>item.dedupeKey===key);return value?structuredClone(value):undefined;}async findByProviderRequestId(id:string){const value=[...this.values.values()].find((item)=>item.providerRequestId===id);return value?structuredClone(value):undefined;}async listForIncident(id:string){return[...this.values.values()].filter((item)=>item.incidentId===id).map((item)=>structuredClone(item));}async listRecent(organizationId:string,limit:number){return[...this.values.values()].filter((item)=>item.organizationId===organizationId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map((item)=>structuredClone(item));}}

export interface NotificationProviderStatus { organizationId:string; provider:'retell'; configured:boolean; connected:boolean; maskedFromNumber?:string; voiceAgentConfigured:boolean; smsAgentConfigured:boolean; checkedAt:string; message:string; }
export interface NotificationProviderStatusRepository { save(value:NotificationProviderStatus):Promise<NotificationProviderStatus>; get(organizationId:string):Promise<NotificationProviderStatus|undefined>; }
export class InMemoryNotificationProviderStatusRepository implements NotificationProviderStatusRepository {private readonly values=new Map<string,NotificationProviderStatus>();async save(value:NotificationProviderStatus){this.values.set(value.organizationId,structuredClone(value));return structuredClone(value);}async get(id:string){const value=this.values.get(id);return value?structuredClone(value):undefined;}}

export interface NotificationAttempt {
  id: string;
  incidentId: string;
  recipientId: string;
  clusterId: string;
  recipientSource: 'ASSIGNED_SRE' | 'ADMIN_FALLBACK' | 'END_USER';
  channel: NotificationChannel;
  provider: string;
  providerRequestId?: string;
  status: NotificationStatus;
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

export interface ContactRepository { create(contact: Contact): Promise<Contact>; update(contact: Contact): Promise<Contact>; get(id: string): Promise<Contact | undefined>; list(organizationId?: string): Promise<readonly Contact[]>; findByUserIds(userIds:readonly string[],organizationId:string):Promise<readonly Contact[]>; }
export interface NotificationGroupRepository { create(group: NotificationGroup): Promise<NotificationGroup>; update(group: NotificationGroup): Promise<NotificationGroup>; get(id: string): Promise<NotificationGroup | undefined>; list(organizationId?: string): Promise<readonly NotificationGroup[]>; }
export type IncidentNotificationStateStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
export interface IncidentNotificationState { incidentId:string; clusterId:string; organizationId:string; recipientIds:readonly string[]; fallbackUsed:boolean; status:IncidentNotificationStateStatus; startedAt:string; updatedAt:string; completedAt?:string; }
export interface IncidentNotificationStateRepository { save(value:IncidentNotificationState):Promise<IncidentNotificationState>; get(incidentId:string):Promise<IncidentNotificationState|undefined>; }
export interface IncidentAcknowledgement { incidentId: string; acknowledgedBy: string; acknowledgedAt: string; notificationAttemptId?: string; providerCallId?: string; channel?: 'VOICE'; note?: string; }
export interface IncidentAcknowledgementRepository { save(value: IncidentAcknowledgement): Promise<IncidentAcknowledgement>; get(incidentId: string): Promise<IncidentAcknowledgement | undefined>; }
export interface AcknowledgementTransaction { acknowledge(input:{acknowledgement:IncidentAcknowledgement;state:IncidentNotificationState;attempt?:NotificationAttempt;communication?:IncidentCommunication;events:readonly NotificationAuditEvent[]}):Promise<void>; }
export type NotificationAuditEventType = 'DIRECT_NOTIFICATION_STARTED' | 'RECIPIENT_RESOLVED' | 'ADMIN_FALLBACK_USED' | 'CONTACT_SKIPPED' | 'CALL_REQUESTED' | 'SMS_REQUESTED' | 'CALL_ANSWERED' | 'VOICE_CALL_ANSWERED' | 'ACKNOWLEDGEMENT_REQUESTED' | 'CALL_FAILED' | 'INCIDENT_ACKNOWLEDGED' | 'INCIDENT_DECLINED' | 'ACKNOWLEDGEMENT_REJECTED' | 'NOTIFICATION_STOPPED' | 'INCIDENT_RESOLVED';
export interface NotificationAuditEvent { id: string; incidentId: string; type: NotificationAuditEventType; timestamp: string; contactId?: string; attemptId?: string; details?: Readonly<Record<string, unknown>>; }
export interface NotificationAuditRepository { append(event: NotificationAuditEvent): Promise<void>; list(incidentId: string): Promise<readonly NotificationAuditEvent[]>; purge(before:string):Promise<number>; }

class InMemoryCrudRepository<T extends { id: string; organizationId: string }> {
  protected readonly values = new Map<string, T>();
  async create(value: T): Promise<T> { if (this.values.has(value.id)) throw new Error('Entity already exists'); this.values.set(value.id, structuredClone(value)); return structuredClone(value); }
  async update(value: T): Promise<T> { if (!this.values.has(value.id)) throw new Error('Entity not found'); this.values.set(value.id, structuredClone(value)); return structuredClone(value); }
  async get(id: string): Promise<T | undefined> { const value = this.values.get(id); return value ? structuredClone(value) : undefined; }
  async list(organizationId?: string): Promise<readonly T[]> { return [...this.values.values()].filter((value) => !organizationId || value.organizationId === organizationId).map((value) => structuredClone(value)); }
}
export class InMemoryContactRepository extends InMemoryCrudRepository<Contact> implements ContactRepository {async findByUserIds(ids:readonly string[],organizationId:string){const wanted=new Set(ids);return[...this.values.values()].filter(value=>value.organizationId===organizationId&&!!value.userId&&wanted.has(value.userId)).map(value=>structuredClone(value));}}
export class InMemoryNotificationGroupRepository extends InMemoryCrudRepository<NotificationGroup> implements NotificationGroupRepository {}
export class InMemoryIncidentNotificationStateRepository implements IncidentNotificationStateRepository {private readonly values=new Map<string,IncidentNotificationState>();async save(value:IncidentNotificationState){this.values.set(value.incidentId,structuredClone(value));return structuredClone(value);}async get(id:string){const value=this.values.get(id);return value?structuredClone(value):undefined;}}
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
  constructor(private readonly highSeverityEnabled = false) {}
  shouldNotify(incident: Incident): boolean {
    return incident.status !== 'RESOLVED' &&
      (incident.severity === 'CRITICAL' || (incident.severity === 'HIGH' && this.highSeverityEnabled));
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

export interface SlackIntegration {
  organizationId: string;
  enabled: boolean;
  botToken?: string;
  incidentChannelId?: string;
  serviceChannels: Readonly<Record<string, string>>;
  createdAt: string;
  updatedAt: string;
}

export interface SlackIntegrationChanges {
  enabled?: boolean;
  botToken?: string | null;
  incidentChannelId?: string | null;
  serviceChannels?: Readonly<Record<string, string>>;
}

export interface SlackIntegrationRepository {
  get(organizationId: string): Promise<SlackIntegration | undefined>;
  findForIncident(incidentId: string): Promise<SlackIntegration | undefined>;
  upsert(
    organizationId: string,
    changes: SlackIntegrationChanges,
  ): Promise<SlackIntegration>;
}

export class InMemorySlackIntegrationRepository
  implements SlackIntegrationRepository
{
  private readonly values = new Map<string, SlackIntegration>();
  async get(organizationId: string) {
    const value = this.values.get(organizationId);
    return value ? structuredClone(value) : undefined;
  }
  async findForIncident() { return undefined; }
  async upsert(organizationId: string, changes: SlackIntegrationChanges) {
    const now = new Date().toISOString();
    const current = this.values.get(organizationId);
    const value: SlackIntegration = {
      organizationId,
      enabled: changes.enabled ?? current?.enabled ?? false,
      ...(changes.botToken !== undefined
        ? changes.botToken ? { botToken: changes.botToken } : {}
        : current?.botToken ? { botToken: current.botToken } : {}),
      ...(changes.incidentChannelId !== undefined
        ? changes.incidentChannelId ? { incidentChannelId: changes.incidentChannelId } : {}
        : current?.incidentChannelId ? { incidentChannelId: current.incidentChannelId } : {}),
      serviceChannels: changes.serviceChannels ?? current?.serviceChannels ?? {},
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.values.set(organizationId, value);
    return structuredClone(value);
  }
}

export interface ClusterSreAssignment {
  clusterId: string;
  userId: string;
  assignedBy?: string;
  assignedAt: string;
}

export interface ClusterSreAssignmentRepository {
  listForCluster(clusterId: string): Promise<readonly ClusterSreAssignment[]>;
  assign(
    clusterId: string,
    userId: string,
    assignedBy: string,
  ): Promise<ClusterSreAssignment | undefined>;
  remove(clusterId: string, userId: string): Promise<boolean>;
}

export class InMemoryClusterSreAssignmentRepository
  implements ClusterSreAssignmentRepository
{
  private readonly values = new Map<string, ClusterSreAssignment>();

  async listForCluster(clusterId: string) {
    return [...this.values.values()]
      .filter((value) => value.clusterId === clusterId)
      .sort((left, right) => left.assignedAt.localeCompare(right.assignedAt))
      .map((value) => structuredClone(value));
  }

  async assign(clusterId: string, userId: string, assignedBy: string) {
    const value: ClusterSreAssignment = {
      clusterId,
      userId,
      assignedBy,
      assignedAt: new Date().toISOString(),
    };
    this.values.set(`${clusterId}:${userId}`, value);
    return structuredClone(value);
  }

  async remove(clusterId: string, userId: string) {
    return this.values.delete(`${clusterId}:${userId}`);
  }
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
export const SLACK_INTEGRATION_REPOSITORY = Symbol(
  'faultline.slack-integration-repository',
);
export const CLUSTER_SRE_ASSIGNMENT_REPOSITORY = Symbol(
  'faultline.cluster-sre-assignment-repository',
);
export const CONTACT_REPOSITORY = Symbol('faultline.contact-repository');
export const END_USER_CONTACT_REPOSITORY = Symbol('faultline.end-user-contact-repository');
export const NOTIFICATION_GROUP_REPOSITORY = Symbol('faultline.notification-group-repository');
export const INCIDENT_NOTIFICATION_STATE_REPOSITORY = Symbol('faultline.incident-notification-state-repository');
export const INCIDENT_ACKNOWLEDGEMENTS = Symbol('faultline.incident-acknowledgements');
export const NOTIFICATION_AUDIT_REPOSITORY = Symbol('faultline.notification-audit-repository');
export const INCIDENT_COMMUNICATION_REPOSITORY = Symbol('faultline.incident-communication-repository');
export const ACKNOWLEDGEMENT_TRANSACTION = Symbol('faultline.acknowledgement-transaction');
export const NOTIFICATION_PROVIDER_STATUS_REPOSITORY = Symbol('faultline.notification-provider-status-repository');
