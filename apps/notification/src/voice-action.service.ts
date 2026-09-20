import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { INCIDENT_REPOSITORY, type IncidentRepository } from '@faultline/incidents';
import { ACKNOWLEDGEMENT_TRANSACTION, ESCALATION_EXECUTION_REPOSITORY, IDEMPOTENCY_STORE, INCIDENT_ACKNOWLEDGEMENTS, NOTIFICATION_ATTEMPTS, NOTIFICATION_AUDIT_REPOSITORY,
  type AcknowledgementTransaction,
  type EscalationExecutionRepository, type IdempotencyStore, type IncidentAcknowledgementRepository, type NotificationAttempt,
  type NotificationAttemptRepository, type NotificationAuditRepository, type VoiceActionRequest } from '@faultline/notifications';
import { NotificationService } from './notification.service';
import { EVENT_TOPICS, QUEUE, type Queue } from '@faultline/queue';

export interface VoiceActionResult { outcome: 'ACKNOWLEDGED'|'DECLINED'|'UNKNOWN'|'ALREADY_ACKNOWLEDGED'|'NO_LONGER_REQUIRED'; message: string; processed: boolean; }
@Injectable()
export class VoiceActionService {
  constructor(@Inject(INCIDENT_REPOSITORY) private readonly incidents: IncidentRepository,
    @Inject(NOTIFICATION_ATTEMPTS) private readonly attempts: NotificationAttemptRepository,
    @Inject(ESCALATION_EXECUTION_REPOSITORY) private readonly executions: EscalationExecutionRepository,
    @Inject(INCIDENT_ACKNOWLEDGEMENTS) private readonly acknowledgements: IncidentAcknowledgementRepository,
    @Inject(NOTIFICATION_AUDIT_REPOSITORY) private readonly audit: NotificationAuditRepository,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
    private readonly notifications: NotificationService,
    @Inject(QUEUE) private readonly queue:Queue,
    @Optional() @Inject(ACKNOWLEDGEMENT_TRANSACTION)private readonly acknowledgementTransaction?:AcknowledgementTransaction) {}

  async process(action: VoiceActionRequest): Promise<VoiceActionResult> {
    const incident = await this.incidents.getIncident(action.incidentId);
    if (!incident) throw new NotFoundException('Incident not found');
    const attempt = await this.attempts.get(action.notificationAttemptId);
    if (!attempt || attempt.incidentId !== incident.id) throw new BadRequestException('Notification attempt does not belong to incident');
    if (attempt.channel !== 'VOICE' || attempt.recipientId !== action.recipientId || attempt.providerRequestId !== action.providerCallId)
      throw new BadRequestException('Voice action does not match contacted recipient and call');
    const duplicate=(await this.audit.list(incident.id)).find((event)=>
      (event.type==='INCIDENT_ACKNOWLEDGED'||event.type==='INCIDENT_DECLINED')&&
      event.details?.providerCallId===action.providerCallId&&event.details?.action===action.action);
    if(duplicate)return action.action==='ACKNOWLEDGE_INCIDENT'
      ? {outcome:'ALREADY_ACKNOWLEDGED',message:'This acknowledgement was already processed.',processed:false}
      : {outcome:'DECLINED',message:'This decline was already processed.',processed:false};
    const execution = await this.executions.get(incident.id);
    if (!execution) throw new ConflictException('Escalation execution not found');
    if (incident.status === 'RESOLVED' || execution.status === 'RESOLVED') {
      await this.rejected(action, attempt, 'INCIDENT_RESOLVED');
      return { outcome:'NO_LONGER_REQUIRED', message:'This incident has already been resolved. No acknowledgement is required.', processed:false };
    }
    if (execution.status === 'ACKNOWLEDGED' || await this.acknowledgements.get(incident.id))
      return { outcome:'ALREADY_ACKNOWLEDGED', message:'This incident has already been acknowledged. Further escalation is stopped.', processed:false };
    if (execution.status !== 'ACTIVE') { await this.rejected(action,attempt,`ESCALATION_${execution.status}`); throw new ConflictException('Escalation is no longer active'); }
    if (execution.currentStep !== attempt.escalationStep) { await this.rejected(action,attempt,'ESCALATION_ADVANCED'); throw new ConflictException('Escalation has advanced beyond this recipient'); }
    if (action.action === 'UNKNOWN') { await this.rejected(action,attempt,'AMBIGUOUS_RESPONSE'); return { outcome:'UNKNOWN',message:'I could not confirm acknowledgement. Please answer yes or no.',processed:false }; }
    const key=`voice-action:${incident.id}:${action.providerCallId}:${action.action}`;
    if (!(await this.idempotency.claim(key))) return action.action === 'ACKNOWLEDGE_INCIDENT'
      ? { outcome:'ALREADY_ACKNOWLEDGED',message:'This acknowledgement was already processed.',processed:false }
      : { outcome:'DECLINED',message:'This decline was already processed.',processed:false };
    const now=new Date().toISOString();
    if (action.action === 'ACKNOWLEDGE_INCIDENT') {
      const acknowledgement={ incidentId:incident.id,acknowledgedBy:attempt.recipientId,acknowledgedAt:now,notificationAttemptId:attempt.id,providerCallId:action.providerCallId,channel:'VOICE' as const };
      const stopped={...execution,status:'ACKNOWLEDGED' as const,nextAttemptAt:undefined,leaseOwner:undefined,leaseExpiresAt:undefined,completedAt:now,updatedAt:now};
      const completed={...attempt,status:'ACKNOWLEDGED' as const,completedAt:now};
      const events=[{id:randomUUID(),incidentId:incident.id,type:'INCIDENT_ACKNOWLEDGED' as const,timestamp:now,attemptId:attempt.id,contactId:attempt.recipientId,details:{providerCallId:action.providerCallId,action:action.action}},{id:randomUUID(),incidentId:incident.id,type:'ESCALATION_STOPPED' as const,timestamp:now,attemptId:attempt.id,contactId:attempt.recipientId,details:{reason:'ACKNOWLEDGED'}}];
      if(this.acknowledgementTransaction)await this.acknowledgementTransaction.acknowledge({acknowledgement,execution:stopped,attempt:completed,events});
      else{await this.acknowledgements.save(acknowledgement);await this.executions.save(stopped);await this.attempts.save(completed);for(const event of events)await this.audit.append(event);}
      await this.queue.publish(EVENT_TOPICS.incidentsLifecycle,{id:`${incident.id}:INCIDENT_ACKNOWLEDGED:${now}`,payload:{id:`${incident.id}:INCIDENT_ACKNOWLEDGED:${now}`,type:'INCIDENT_ACKNOWLEDGED',incident,state:'ACKNOWLEDGED',occurredAt:now,changedFields:['acknowledgement']}}).catch(()=>undefined);
      return { outcome:'ACKNOWLEDGED',message:'The incident has been acknowledged. Further escalation will stop.',processed:true };
    }
    const declined={ ...attempt,status:'DECLINED' as const,completedAt:now };
    await this.attempts.save(declined); await this.event(incident.id,'INCIDENT_DECLINED',attempt,{ providerCallId:action.providerCallId,action:action.action });
    await this.notifications.continueAfterDecline(declined);
    return { outcome:'DECLINED',message:'You declined this incident. Faultline will contact the next escalation recipient.',processed:true };
  }
  private rejected(action:VoiceActionRequest,attempt:NotificationAttempt,reason:string){return this.event(action.incidentId,'ACKNOWLEDGEMENT_REJECTED',attempt,{reason,action:action.action,providerCallId:action.providerCallId});}
  private event(incidentId:string,type:'INCIDENT_ACKNOWLEDGED'|'INCIDENT_DECLINED'|'ACKNOWLEDGEMENT_REJECTED'|'ESCALATION_STOPPED',attempt:NotificationAttempt,details:Record<string,unknown>){return this.audit.append({id:randomUUID(),incidentId,type,timestamp:new Date().toISOString(),attemptId:attempt.id,contactId:attempt.recipientId,details});}
}
