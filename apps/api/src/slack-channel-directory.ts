import { Injectable } from '@nestjs/common';

export const SLACK_CHANNEL_DIRECTORY = Symbol('faultline.slack-channel-directory');

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface SlackChannelDirectory {
  list(botToken: string): Promise<readonly SlackChannel[]>;
}

interface ConversationsResponse {
  ok?: boolean;
  error?: string;
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_member?: boolean;
    is_archived?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
}

@Injectable()
export class HttpSlackChannelDirectory implements SlackChannelDirectory {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://slack.com/api',
  ) {}

  async list(botToken: string): Promise<readonly SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor = '';
    do {
      const query = new URLSearchParams({
        exclude_archived: 'true',
        limit: '200',
        types: 'public_channel,private_channel',
        ...(cursor ? { cursor } : {}),
      });
      const response = await this.fetcher(
        `${this.baseUrl}/conversations.list?${query.toString()}`,
        {
          headers: { Authorization: `Bearer ${botToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as ConversationsResponse;
      if (!response.ok || !body.ok)
        throw new Error(`Slack conversations.list failed: ${body.error ?? response.status}`);
      for (const channel of body.channels ?? []) {
        // chat.postMessage is reliably available only where the bot is a member.
        // Public channels outside the bot's membership may require an additional
        // chat:write.public grant, so they are not offered as routable destinations.
        if (!channel.id || !channel.name || channel.is_archived || !channel.is_member)
          continue;
        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.is_private ?? false,
          isMember: channel.is_member ?? false,
        });
      }
      cursor = body.response_metadata?.next_cursor?.trim() ?? '';
    } while (cursor);
    return channels.sort((left, right) => left.name.localeCompare(right.name));
  }
}
