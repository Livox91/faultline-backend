import { Inject, Injectable, Optional } from '@nestjs/common';
import Retell, { verify } from 'retell-sdk';
import type {
  CommunicationProvider,
  NotificationStatus,
  ProviderResult,
  SmsInput,
  VoiceCallInput,
} from '@faultline/notifications';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';

export const RETELL_CLIENT = Symbol('faultline.retell-client');

@Injectable()
export class RetellCommunicationProvider implements CommunicationProvider {
  readonly name = 'retell';
  private sdkClient?: Retell;
  constructor(
    @Inject(NOTIFICATION_CONFIG)
    private readonly config: NotificationWorkerConfig,
    @Optional() @Inject(RETELL_CLIENT)
    private readonly injectedClient?: Pick<Retell, 'call'> & Partial<Pick<Retell, 'agent'|'phoneNumber'>>,
  ) {}
  async startVoiceCall(input: VoiceCallInput): Promise<ProviderResult> {
    if (
      !this.config.apiKey ||
      !this.config.fromNumber ||
      !this.config.voiceAgentId
    )
      return Promise.reject(
        new Error('Retell voice delivery is not configured'),
      );
    const response = await this.client().call.createPhoneCall({
        from_number: this.config.fromNumber,
        to_number: input.recipient.phoneNumber,
        override_agent_id: this.config.voiceAgentId,
        metadata: input.metadata,
        retell_llm_dynamic_variables: {
          ...input.context,
          notification_message: input.message,
          voice_script: `This is the Faultline incident notification system. ${input.message} Would you like to acknowledge this incident?`,
          caller_identity: 'Faultline incident notification system',
          acknowledgement_prompt:
            'Would you like to acknowledge this incident?',
          acknowledgement_confirmation:
            'The incident has been acknowledged. Further notification will stop.',
          allowed_actions: 'ACKNOWLEDGE_INCIDENT,DECLINE_INCIDENT,UNKNOWN',
        },
      });
    if (!response.call_id) throw new Error('Retell returned an invalid response');
    return { requestId: response.call_id, status: 'SENT' };
  }
  sendSms(input: SmsInput): Promise<ProviderResult> {
    if (
      !this.config.apiKey ||
      !this.config.fromNumber ||
      !this.config.smsAgentId
    )
      return Promise.reject(new Error('Retell SMS delivery is not configured'));
    return this.request(
      '/create-sms-chat',
      {
        from_number: this.config.fromNumber,
        to_number: input.recipient.phoneNumber,
        override_agent_id: this.config.smsAgentId,
        metadata: input.metadata,
        retell_llm_dynamic_variables: { notification_message: input.message },
      },
      'chat_id',
    );
  }
  async getCallStatus(requestId: string): Promise<ProviderResult> {
    if (!this.config.apiKey) throw new Error('Retell is not configured');
    const response = await this.client().call.retrieve(requestId);
    return {
      requestId,
      status: mapRetellStatus(
        String(response.call_status ?? ''),
        'disconnection_reason' in response
          ? String(response.disconnection_reason ?? '')
          : undefined,
      ),
    };
  }
  async verifyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<boolean> {
    if (!this.config.apiKey || !signature) return false;
    return verify(rawBody.toString('utf8'), this.config.apiKey, signature);
  }
  async checkConnection():Promise<{configured:boolean;connected:boolean;maskedFromNumber?:string;voiceAgentConfigured:boolean;smsAgentConfigured:boolean;message:string}>{
    const configured=Boolean(this.config.apiKey&&this.config.fromNumber&&this.config.voiceAgentId);
    const safe={configured,maskedFromNumber:this.config.fromNumber?maskPhoneNumber(this.config.fromNumber):undefined,voiceAgentConfigured:Boolean(this.config.voiceAgentId),smsAgentConfigured:Boolean(this.config.smsAgentId)};
    if(!configured)return{...safe,connected:false,message:'Retell configuration is incomplete'};
    try{
      const client=this.client();
      if(!client.agent||!client.phoneNumber)throw new Error('Retell health resources unavailable');
      await Promise.all([client.agent.retrieve(this.config.voiceAgentId!),client.phoneNumber.retrieve(this.config.fromNumber!)]);
      return{...safe,connected:true,message:'Retell voice agent and outbound number are reachable'};
    }catch{return{...safe,connected:false,message:'Retell could not validate the voice agent or outbound number'};}
  }
  private async request(
    path: string,
    body: object,
    idField: string,
  ): Promise<ProviderResult> {
    const response = await this.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const requestId = response[idField];
    if (typeof requestId !== 'string' || !requestId)
      throw new Error('Retell returned an invalid response');
    return { requestId, status: 'SENT' };
  }
  private client(): Pick<Retell, 'call'> & Partial<Pick<Retell, 'agent'|'phoneNumber'>> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.config.apiKey) throw new Error('Retell is not configured');
    return (this.sdkClient ??= new Retell({
      apiKey: this.config.apiKey,
      timeout: 15_000,
      maxRetries: 2,
    }));
  }
  private async fetch(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    if (!this.config.apiKey) throw new Error('Retell is not configured');
    let response: Response;
    try {
      response = await fetch(`https://api.retellai.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    } catch {
      throw new Error('Retell API unavailable');
    }
    if (!response.ok)
      throw new Error(`Retell request failed with status ${response.status}`);
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error('Retell returned an invalid response');
    }
  }
}

export function maskPhoneNumber(value:string):string{const digits=value.replace(/\D/g,'');if(digits.length<4)return'••••';return`+${'•'.repeat(Math.max(2,digits.length-4))}${digits.slice(-4)}`;}

export function mapRetellStatus(
  status: string,
  disconnectionReason?: string,
): NotificationStatus {
  const reason = disconnectionReason?.toLowerCase() ?? '';
  if (reason === 'user_declined') return 'DECLINED';
  if ([
    'dial_no_answer',
    'voicemail_reached',
    'ivr_reached',
    'dial_busy',
    'inactivity',
    'max_duration_reached',
  ].includes(reason))
    return 'NO_ANSWER';
  if (reason.includes('timeout') || reason.includes('failed') || reason.includes('error') || [
    'concurrency_limit_reached',
    'no_concurrency_fallback',
    'no_valid_payment',
    'scam_detected',
    'invalid_destination',
    'telephony_provider_permission_denied',
    'telephony_provider_unavailable',
    'sip_routing_error',
    'marked_as_spam',
  ].includes(reason))
    return 'FAILED';
  const value = status.toLowerCase();
  if (['registered', 'ongoing', 'in_progress'].includes(value))
    return 'IN_PROGRESS';
  if (['ended', 'answered'].includes(value)) return 'ANSWERED';
  if (['delivered', 'completed'].includes(value)) return 'DELIVERED';
  if (['canceled', 'cancelled'].includes(value)) return 'CANCELLED';
  if (['failed', 'error'].includes(value)) return 'FAILED';
  return 'SENT';
}
