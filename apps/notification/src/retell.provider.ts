import { Inject, Injectable } from '@nestjs/common';
import { verify } from 'retell-sdk';
import type { CommunicationProvider, NotificationStatus, ProviderResult, SmsInput, VoiceCallInput } from '@faultline/notifications';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';

@Injectable()
export class RetellCommunicationProvider implements CommunicationProvider {
  readonly name = 'retell';
  constructor(@Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig) {}
  startVoiceCall(input: VoiceCallInput): Promise<ProviderResult> {
    return this.request('/v2/create-phone-call', {
      from_number: this.config.fromNumber, to_number: input.recipient.phoneNumber, override_agent_id: this.config.voiceAgentId,
      metadata: input.metadata, retell_llm_dynamic_variables: {
        ...input.context,
        notification_message: input.message,
        voice_script: `This is the Faultline incident notification system. ${input.message} Would you like to acknowledge this incident?`,
        caller_identity: 'Faultline incident notification system',
        acknowledgement_prompt: 'Would you like to acknowledge this incident?',
        acknowledgement_confirmation: 'The incident has been acknowledged. Further escalation will stop.',
        allowed_actions: 'ACKNOWLEDGE_INCIDENT,DECLINE_INCIDENT,UNKNOWN',
      },
    }, 'call_id');
  }
  sendSms(input: SmsInput): Promise<ProviderResult> {
    if (!this.config.smsAgentId) return Promise.reject(new Error('Retell SMS agent is not configured'));
    return this.request('/create-sms-chat', {
      from_number: this.config.fromNumber, to_number: input.recipient.phoneNumber, override_agent_id: this.config.smsAgentId,
      metadata: input.metadata, retell_llm_dynamic_variables: { notification_message: input.message },
    }, 'chat_id');
  }
  async getCallStatus(requestId: string): Promise<ProviderResult> {
    const response = await this.fetch(`/v2/get-call/${encodeURIComponent(requestId)}`, { method: 'GET' });
    return { requestId, status: mapRetellStatus(String(response.call_status ?? response.status ?? '')) };
  }
  async verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
    if (!signature) return false;
    return verify(rawBody.toString('utf8'), this.config.apiKey, signature);
  }
  private async request(path: string, body: object, idField: string): Promise<ProviderResult> {
    const response = await this.fetch(path, { method: 'POST', body: JSON.stringify(body) });
    const requestId = response[idField];
    if (typeof requestId !== 'string' || !requestId) throw new Error('Retell returned an invalid response');
    return { requestId, status: 'SENT' };
  }
  private async fetch(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await fetch(`https://api.retellai.com${path}`, { ...init, headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' } }); }
    catch { throw new Error('Retell API unavailable'); }
    if (!response.ok) throw new Error(`Retell request failed with status ${response.status}`);
    try { return await response.json() as Record<string, unknown>; } catch { throw new Error('Retell returned an invalid response'); }
  }
}

export function mapRetellStatus(status: string, disconnectionReason?: string): NotificationStatus {
  if (disconnectionReason?.includes('dial_no_answer') || disconnectionReason?.includes('voicemail')) return 'NO_ANSWER';
  const value = status.toLowerCase();
  if (['registered','ongoing','in_progress'].includes(value)) return 'IN_PROGRESS';
  if (['ended','answered'].includes(value)) return 'ANSWERED';
  if (['delivered','completed'].includes(value)) return 'DELIVERED';
  if (['canceled','cancelled'].includes(value)) return 'CANCELLED';
  if (['failed','error'].includes(value)) return 'FAILED';
  return 'SENT';
}
