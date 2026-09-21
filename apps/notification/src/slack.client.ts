import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  NOTIFICATION_CONFIG,
  type NotificationWorkerConfig,
} from './config';

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  blocks?: readonly Readonly<Record<string, unknown>>[];
}

export interface SlackPostedMessage {
  channel: string;
  timestamp: string;
}

export interface SlackUpdateMessageInput extends SlackPostMessageInput {
  timestamp: string;
}

export interface SlackThreadReplyInput extends SlackPostMessageInput {
  threadTimestamp: string;
}

export interface SlackClient {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostedMessage>;
  updateMessage(input: SlackUpdateMessageInput): Promise<SlackPostedMessage>;
  postThreadReply(input: SlackThreadReplyInput): Promise<SlackPostedMessage>;
}

export const SLACK_CLIENT = Symbol('faultline.slack-client');
export const SLACK_FETCH = Symbol('faultline.slack-fetch');

type Fetcher = typeof fetch;

export class SlackApiError extends Error {
  constructor(
    readonly operation: 'chat.postMessage' | 'chat.update',
    readonly code: string,
    readonly status: number,
    readonly transient: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`Slack ${operation} failed (${code})`);
    this.name = 'SlackApiError';
  }
}

@Injectable()
export class HttpSlackClient implements SlackClient {
  private readonly fetcher: Fetcher;
  constructor(
    @Inject(NOTIFICATION_CONFIG)
    private readonly config: NotificationWorkerConfig,
    @Optional() @Inject(SLACK_FETCH) fetcher?: Fetcher,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostedMessage> {
    return this.request('chat.postMessage', input);
  }

  async updateMessage(input: SlackUpdateMessageInput): Promise<SlackPostedMessage> {
    const { timestamp, ...message } = input;
    return this.request('chat.update', { ...message, ts: timestamp });
  }

  async postThreadReply(input: SlackThreadReplyInput): Promise<SlackPostedMessage> {
    const { threadTimestamp, ...message } = input;
    return this.request('chat.postMessage', {
      ...message,
      thread_ts: threadTimestamp,
    });
  }

  private async request(
    method: 'chat.postMessage' | 'chat.update',
    input: object,
  ): Promise<SlackPostedMessage> {
    const token = this.config.slack.botToken;
    if (!this.config.slack.enabled || !token)
      throw new Error('Slack integration is not configured');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.requestOnce(method, input, token);
      } catch (error) {
        if (attempt === 3 || !isTransientSlackError(error)) throw error;
        const delay = error instanceof SlackApiError && error.retryAfterMs
          ? Math.min(error.retryAfterMs, 1_000)
          : 50 * 2 ** (attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Slack request exhausted');
  }

  private async requestOnce(
    method: 'chat.postMessage' | 'chat.update',
    input: object,
    token: string,
  ): Promise<SlackPostedMessage> {
    const response = await this.fetcher(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };
    if (!response.ok || !result.ok || !result.channel || !result.ts) {
      const code = safeSlackCode(result.error);
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      throw new SlackApiError(
        method,
        code,
        response.status,
        response.status === 429 || response.status >= 500 || transientCodes.has(code),
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : undefined,
      );
    }
    return { channel: result.channel, timestamp: result.ts };
  }
}

const transientCodes = new Set([
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
]);

function safeSlackCode(value: string | undefined): string {
  return value && /^[a-z0-9_]{1,64}$/i.test(value)
    ? value.toLowerCase()
    : 'slack_api_error';
}

export function isTransientSlackError(error: unknown): boolean {
  return error instanceof SlackApiError
    ? error.transient
    : error instanceof TypeError ||
        error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError');
}
