import { BadRequestException, Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { mapRetellStatus, RetellCommunicationProvider } from './retell.provider';
import { NotificationService } from './notification.service';
import { extractRetellVoiceAction } from './retell-webhook.parser';
import { VoiceActionService } from './voice-action.service';

@Controller('webhooks/retell')
export class RetellWebhookController {
  constructor(private readonly provider: RetellCommunicationProvider, private readonly notifications: NotificationService, private readonly actions: VoiceActionService) {}
  @Post() @HttpCode(204)
  async receive(@Req() request: { rawBody?: Buffer; body: unknown }, @Headers('x-retell-signature') signature?: string): Promise<void> {
    if (!request.rawBody || !(await this.provider.verifyWebhook(request.rawBody, signature))) throw new UnauthorizedException('Invalid webhook signature');
    const body = request.body as Record<string, unknown>; const call = (body.call ?? body) as Record<string, unknown>;
    const requestId = call.call_id ?? call.chat_id; if (typeof requestId !== 'string') throw new BadRequestException('Missing provider request id');
    const action=extractRetellVoiceAction(body);
    if(action)await this.actions.processProviderResponse(requestId,action,new Date().toISOString());
    await this.notifications.processProviderEvent({ requestId, status: mapRetellStatus(String(call.call_status ?? body.event ?? ''), String(call.disconnection_reason ?? '')),
      metadata: typeof call.metadata === 'object' && call.metadata ? call.metadata as Record<string, unknown> : undefined });
  }
}
