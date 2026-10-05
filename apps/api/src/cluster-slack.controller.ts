import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import { FEATURES } from '@faultline/billing';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type AuthenticatedUser,
} from '@faultline/auth';
import type { ClusterDirectory } from '@faultline/database';
import {
  SLACK_INTEGRATION_REPOSITORY,
  type SlackIntegrationRepository,
} from '@faultline/notifications';
import { AuditTrail } from './auth/audit-trail';
import {
  CurrentUser,
  RequirePermission,
  RequiresFeature,
  Roles,
  type RequestWithUser,
} from './auth/context';
import { CLUSTER_DIRECTORY } from './clusters.controller';
import {
  SLACK_CHANNEL_DIRECTORY,
  type SlackChannelDirectory,
} from './slack-channel-directory';

@Controller('clusters/:id')
@Roles(ROLES.ADMIN)
@RequiresFeature(FEATURES.INTEGRATIONS)
export class ClusterSlackController {
  constructor(
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
    @Inject(SLACK_INTEGRATION_REPOSITORY)
    private readonly integrations: SlackIntegrationRepository,
    @Inject(SLACK_CHANNEL_DIRECTORY)
    private readonly channels: SlackChannelDirectory,
    private readonly audit: AuditTrail,
  ) {}

  @Get('slack-channels')
  @RequirePermission(PERMISSIONS.PROJECT_EDIT)
  @Header('Cache-Control', 'no-store')
  async list(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const cluster = await this.cluster(id, user.organizationId);
    const channels = await this.availableChannels(user.organizationId);
    return {
      channels,
      mapping: cluster.slackChannelId
        ? { id: cluster.slackChannelId, name: cluster.slackChannelName }
        : null,
    };
  }

  @Patch('slack-mapping')
  @RequirePermission(PERMISSIONS.PROJECT_EDIT)
  @Header('Cache-Control', 'no-store')
  async save(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    await this.cluster(id, user.organizationId);
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'slackChannelId'))
      throw new BadRequestException('slackChannelId is required');
    if (body.slackChannelId !== null && typeof body.slackChannelId !== 'string')
      throw new BadRequestException('slackChannelId must be a Slack channel id or null');

    const requested = typeof body.slackChannelId === 'string'
      ? body.slackChannelId.trim()
      : null;
    let mapping: { id: string; name: string } | null = null;
    if (requested) {
      const available = await this.availableChannels(user.organizationId);
      const selected = available.find((channel) => channel.id === requested);
      if (!selected)
        throw new BadRequestException('Selected Slack channel is not available to this integration');
      mapping = { id: selected.id, name: selected.name };
    }

    const updated = await this.clusters.updateSlackMapping(
      id,
      user.organizationId,
      mapping,
    );
    if (!updated) throw new NotFoundException('Project not found');
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.PROJECT_MODIFIED,
      resourceType: 'project',
      resourceId: id,
      request,
      metadata: {
        fields: ['slackChannelId', 'slackChannelName'],
        slackChannelId: mapping?.id ?? null,
      },
    });
    return {
      clusterId: updated.id,
      mapping: updated.slackChannelId
        ? { id: updated.slackChannelId, name: updated.slackChannelName }
        : null,
    };
  }

  private async cluster(id: string, organizationId: string) {
    const cluster = await this.clusters.get(id, organizationId);
    if (!cluster) throw new NotFoundException('Project not found');
    return cluster;
  }

  private async availableChannels(organizationId: string) {
    const integration = await this.integrations.get(organizationId);
    if (!integration?.enabled || !integration.botToken)
      throw new BadRequestException('Slack integration must be enabled and connected first');
    try {
      return await this.channels.list(integration.botToken);
    } catch {
      throw new BadGatewayException(
        'Slack channels could not be loaded. Confirm the app has channels:read and groups:read scopes.',
      );
    }
  }
}
