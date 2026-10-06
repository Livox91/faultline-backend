import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { SlackEventProcessor, type SlackEventBody } from './slack-event.processor';

@Controller('webhooks/slack')
export class SlackEventsController {
  constructor(
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    private readonly events: SlackEventProcessor,
  ) {}

  @Post('events')
  @HttpCode(200)
  async receive(
    @Req() request: { rawBody?: Buffer },
    @Body() body: SlackEventBody,
    @Headers('x-slack-request-timestamp') timestamp?: string,
    @Headers('x-slack-signature') signature?: string,
  ) {
    const secret = this.config.slack.signingSecret;
    if (!secret)
      throw new ServiceUnavailableException('Slack event signing is not configured');
    if (!request.rawBody || !verifySlackSignature(request.rawBody, timestamp, signature, secret))
      throw new UnauthorizedException('Invalid Slack signature');
    return this.events.process(body);
  }
}

export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature?.startsWith('v0=')) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(nowMs - seconds * 1000) > 5 * 60_000)
    return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
