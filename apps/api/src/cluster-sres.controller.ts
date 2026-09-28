import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  USER_REPOSITORY,
  type AuthenticatedUser,
  type UserRepository,
} from '@faultline/auth';
import type { ClusterDirectory } from '@faultline/database';
import {
  CLUSTER_SRE_ASSIGNMENT_REPOSITORY,
  CONTACT_REPOSITORY,
  type ClusterSreAssignmentRepository,
  type ContactRepository,
} from '@faultline/notifications';
import { AuditTrail } from './auth/audit-trail';
import {
  CurrentUser,
  RequirePermission,
  Roles,
  type RequestWithUser,
} from './auth/context';
import { CLUSTER_DIRECTORY } from './clusters.controller';

@Controller('clusters/:id/sres')
@Roles(ROLES.ADMIN)
@RequirePermission(PERMISSIONS.PROJECT_ASSIGN)
export class ClusterSresController {
  constructor(
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLUSTER_SRE_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ClusterSreAssignmentRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Param('id') clusterId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.cluster(clusterId, actor.organizationId);
    const users = (await this.users.list()).filter(
      (user) =>
        user.organizationId === actor.organizationId &&
        user.role === ROLES.ONSITE_ENGINEER,
    );
    const assigned = new Map(
      (await this.assignments.listForCluster(clusterId)).map((value) => [
        value.userId,
        value,
      ]),
    );
    const contacts = new Map(
      (await this.contacts.findByUserIds(
        users.map((user) => user.id),
        actor.organizationId,
      )).flatMap((contact) =>
        contact.userId ? [[contact.userId, contact] as const] : [],
      ),
    );
    return {
      clusterId,
      items: users.map((user) => {
        const assignment = assigned.get(user.id);
        const contact = contacts.get(user.id);
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          status: user.status,
          assigned: !!assignment,
          assignedAt: assignment?.assignedAt ?? null,
          phoneConfigured: !!contact?.phoneNumber,
          voiceEnabled: !!contact?.enabled && !!contact?.voiceEnabled,
        };
      }),
    };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async assign(
    @Param('id') clusterId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    await this.cluster(clusterId, actor.organizationId);
    const user = await this.sre(body?.userId, actor.organizationId);
    const assignment = await this.assignments.assign(
      clusterId,
      user.id,
      actor.id,
    );
    if (!assignment)
      throw new BadRequestException('SRE could not be assigned to this cluster');
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.CLUSTER_SRE_ASSIGNED,
      resourceType: 'cluster',
      resourceId: clusterId,
      request,
      metadata: { userId: user.id, email: user.email },
    });
    return assignment;
  }

  @Delete(':userId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async remove(
    @Param('id') clusterId: string,
    @Param('userId') userId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<void> {
    await this.cluster(clusterId, actor.organizationId);
    const user = await this.sre(userId, actor.organizationId, false);
    if (!(await this.assignments.remove(clusterId, user.id)))
      throw new NotFoundException('SRE assignment not found');
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.CLUSTER_SRE_REMOVED,
      resourceType: 'cluster',
      resourceId: clusterId,
      request,
      metadata: { userId: user.id, email: user.email },
    });
  }

  private async cluster(id: string, organizationId: string) {
    const cluster = await this.clusters.get(id, organizationId);
    if (!cluster) throw new NotFoundException('Cluster not found');
    return cluster;
  }

  private async sre(
    value: unknown,
    organizationId: string,
    requireActive = true,
  ) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException('userId is required');
    const user = await this.users.findById(value.trim());
    if (
      !user ||
      user.organizationId !== organizationId ||
      user.role !== ROLES.ONSITE_ENGINEER
    )
      throw new BadRequestException('User must be an Onsite Engineer in this organization');
    if (requireActive && user.status !== 'active')
      throw new BadRequestException('Disabled Onsite Engineers cannot be assigned');
    return user;
  }
}
