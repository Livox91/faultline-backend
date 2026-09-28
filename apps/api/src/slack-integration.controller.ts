import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Patch,
  Post,
} from '@nestjs/common';
import { FEATURES } from '@faultline/billing';
import { z } from 'zod';
import { ROLES, type AuthenticatedUser } from '@faultline/auth';
import {
  SLACK_INTEGRATION_REPOSITORY,
  type SlackIntegration,
  type SlackIntegrationChanges,
  type SlackIntegrationRepository,
} from '@faultline/notifications';
import { CurrentUser, RequiresFeature, Roles } from './auth/context';

const channelId = z.string().trim().regex(/^[CGD][A-Z0-9]{8,}$/);
const serviceChannels = z.record(
  z.string().trim().min(1).max(128),
  channelId,
).transform((mapping) =>
  Object.fromEntries(
    Object.entries(mapping).map(([service, channel]) => [
      service.trim().toLowerCase(),
      channel,
    ]),
  ),
);
const changes = z.object({
  slackEnabled: z.boolean().optional(),
  // Omit to retain the current secret; null or an empty string explicitly clears it.
  slackBotToken: z.union([
    z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,}$/),
    z.literal(''),
    z.null(),
  ]).optional(),
  slackIncidentChannelId: z.union([channelId, z.literal(''), z.null()]).optional(),
  slackServiceChannels: serviceChannels.optional(),
}).strict();

export interface SlackIntegrationView {
  slackEnabled: boolean;
  botTokenConfigured: boolean;
  slackIncidentChannelId: string | null;
  slackServiceChannels: Readonly<Record<string, string>>;
  updatedAt: string | null;
}

@Injectable()
export class SlackIntegrationService {
  constructor(
    @Inject(SLACK_INTEGRATION_REPOSITORY)
    private readonly integrations: SlackIntegrationRepository,
  ) {}

  async get(organizationId: string): Promise<SlackIntegrationView> {
    return present(await this.integrations.get(organizationId));
  }

  async save(organizationId: string, body: unknown): Promise<SlackIntegrationView> {
    const parsed = changes.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        message: 'Invalid Slack integration configuration',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const input: SlackIntegrationChanges = {
      ...(parsed.data.slackEnabled !== undefined
        ? { enabled: parsed.data.slackEnabled }
        : {}),
      ...(parsed.data.slackBotToken !== undefined
        ? { botToken: parsed.data.slackBotToken || null }
        : {}),
      ...(parsed.data.slackIncidentChannelId !== undefined
        ? { incidentChannelId: parsed.data.slackIncidentChannelId || null }
        : {}),
      ...(parsed.data.slackServiceChannels !== undefined
        ? { serviceChannels: parsed.data.slackServiceChannels }
        : {}),
    };
    const saved = await this.integrations.upsert(organizationId, input);
    return present(saved);
  }
}

@Controller('integrations/slack')
@Roles(ROLES.ADMIN)
@RequiresFeature(FEATURES.INTEGRATIONS)
export class SlackIntegrationController {
  constructor(private readonly service: SlackIntegrationService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.service.get(user.organizationId);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.service.save(user.organizationId, body);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.service.save(user.organizationId, body);
  }
}

function present(value: SlackIntegration | undefined): SlackIntegrationView {
  return {
    slackEnabled: value?.enabled ?? false,
    botTokenConfigured: !!value?.botToken,
    slackIncidentChannelId: value?.incidentChannelId ?? null,
    slackServiceChannels: value?.serviceChannels ?? {},
    updatedAt: value?.updatedAt ?? null,
  };
}
