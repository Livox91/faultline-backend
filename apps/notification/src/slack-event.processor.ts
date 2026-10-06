import { Injectable } from '@nestjs/common';
import { SlackAcknowledgementService } from './slack-acknowledgement.service';

const ACKNOWLEDGEMENT_REACTIONS = new Set([
  '+1',
  'ballot_box_with_check',
  'heavy_check_mark',
  'thumbsup',
  'white_check_mark',
]);

export type SlackEventBody = {
  type?: unknown;
  challenge?: unknown;
  event_id?: unknown;
  event_time?: unknown;
  event?: Record<string, unknown>;
};

export type SlackEventProcessingResult =
  | { challenge: string }
  | { accepted: false }
  | { accepted: true; result: string };

@Injectable()
export class SlackEventProcessor {
  constructor(private readonly acknowledgements: SlackAcknowledgementService) {}

  async process(body: SlackEventBody): Promise<SlackEventProcessingResult> {
    if (body?.type === 'url_verification')
      return { challenge: typeof body.challenge === 'string' ? body.challenge : '' };
    if (body?.type !== 'event_callback' || typeof body.event_id !== 'string')
      return { accepted: false };

    const signal = acknowledgementSignal(body);
    if (!signal) return { accepted: false };
    const result = await this.acknowledgements.acknowledge({
      ...signal,
      eventId: body.event_id,
      occurredAt: slackEventTime(body.event_time, body.event?.event_ts),
    });
    return { accepted: true, result };
  }
}

function acknowledgementSignal(body: SlackEventBody) {
  const event = body.event;
  if (!event || typeof event.user !== 'string') return undefined;
  if (event.type === 'reaction_added') {
    const item = event.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const message = item as Record<string, unknown>;
    if (
      message.type !== 'message' ||
      typeof message.channel !== 'string' ||
      typeof message.ts !== 'string' ||
      typeof event.reaction !== 'string' ||
      !ACKNOWLEDGEMENT_REACTIONS.has(event.reaction)
    ) return undefined;
    return { channelId: message.channel, messageTimestamp: message.ts, userId: event.user, source: 'REACTION' as const };
  }
  if (
    event.type === 'message' &&
    typeof event.channel === 'string' &&
    !event.subtype &&
    !event.bot_id &&
    typeof event.thread_ts === 'string' &&
    typeof event.text === 'string' &&
    /^(?:ack|acknowledge(?:d)?)$/i.test(event.text.trim().replace(/[.!]+$/, ''))
  ) {
    return { channelId: event.channel, messageTimestamp: event.thread_ts, userId: event.user, source: 'REPLY' as const };
  }
  return undefined;
}

function slackEventTime(primary: unknown, fallback: unknown): string {
  const value = typeof primary === 'number' ? primary : Number(String(fallback ?? '').split('.')[0]);
  return Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : new Date().toISOString();
}
