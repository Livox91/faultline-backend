import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  assignedProjectIds,
  hasProjectAccess,
  isAdmin,
  type AuthenticatedUser,
} from '@faultline/auth';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  type ClusterDirectory,
  type RegisteredCluster,
} from '@faultline/database';
import { AuditTrail } from './auth/audit-trail';
import {
  CurrentUser,
  RequirePermission,
  RequiresProjectAccess,
  Roles,
  type RequestWithUser,
} from './auth/context';

export const CLUSTER_DIRECTORY = Symbol('faultline.cluster-directory');

export type { ClusterDirectory, RegisteredCluster };

/**
 * Trims a project to what the caller should see.
 *
 * Who else is assigned to a project is an administrative fact. An engineer needs the
 * project, not the roster: knowing which colleagues hold access is the kind of detail
 * that makes a compromised account more useful than it should be.
 */
function present(
  project: RegisteredCluster,
  user: AuthenticatedUser,
): RegisteredCluster {
  if (isAdmin(user)) return project;
  const { assignedUserIds: _assignedUserIds, ...visible } = project;
  return visible;
}

/** Project ids appear in URLs and become cluster ids in telemetry; keep them tame. */
const idPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value.trim()))
    throw new BadRequestException(
      'Project id must be 1-63 characters of letters, digits, dash or underscore',
    );
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`Invalid ${field}`);
  return value.trim();
}

/**
 * Projects.
 *
 * Mounted at both paths: `clusters` is what the control plane and the onboarding
 * scripts have always called this resource, `projects` is what the product and the UI
 * call it. They are the same rows and the same authorization.
 *
 * Reads are scoped by assignment; writes are Admin-only. Note that the read scope is
 * passed into the query rather than filtered out of its result - an engineer's listing
 * is a different query, not a trimmed one.
 */
@Controller(['clusters', 'projects'])
export class ClustersController {
  constructor(
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.PROJECT_VIEW)
  @Header('Cache-Control', 'no-store')
  async list(@CurrentUser() user: AuthenticatedUser) {
    const projects = await this.clusters.list(
      isAdmin(user) ? undefined : assignedProjectIds(user),
    );
    return projects.map((project) => present(project, user));
  }

  /**
   * One project.
   *
   * The guard has already refused callers without an assignment to `:id`, so reaching
   * the handler at all means the access check passed. The redundant check below is
   * cheap insurance against the decorator being removed in a future edit.
   */
  @Get(':id')
  @RequirePermission(PERMISSIONS.PROJECT_VIEW)
  @RequiresProjectAccess('id')
  @Header('Cache-Control', 'no-store')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    if (!hasProjectAccess(user, id))
      throw new ForbiddenException('You do not have access to this project');
    const project = await this.clusters.get(id);
    if (!project) throw new NotFoundException('Project not found');
    return present(project, user);
  }

  @Post()
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_CREATE)
  @Header('Cache-Control', 'no-store')
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const id = projectId(body?.id);
    const name = optionalText(body?.name, 'name') ?? id;
    try {
      const created = await this.clusters.create({
        id,
        name,
        ...(optionalText(body?.environment, 'environment')
          ? { environment: optionalText(body?.environment, 'environment')! }
          : {}),
        kubernetesContext: optionalText(body?.kubernetesContext, 'kubernetesContext') ?? null,
        workloadNamespace: optionalText(body?.workloadNamespace, 'workloadNamespace') ?? null,
        workloadSelector: optionalText(body?.workloadSelector, 'workloadSelector') ?? null,
      });
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.PROJECT_CREATED,
        resourceType: 'project',
        resourceId: id,
        request,
        metadata: { name, environment: created.environment },
      });
      return created;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('A project with that id already exists');
      throw error;
    }
  }

  @Patch(':id')
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_EDIT)
  @Header('Cache-Control', 'no-store')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const changes = {
      ...(optionalText(body?.name, 'name') !== undefined
        ? { name: optionalText(body?.name, 'name')! }
        : {}),
      ...(optionalText(body?.environment, 'environment') !== undefined
        ? { environment: optionalText(body?.environment, 'environment')! }
        : {}),
      ...(body?.kubernetesContext !== undefined
        ? { kubernetesContext: optionalText(body.kubernetesContext, 'kubernetesContext') ?? null }
        : {}),
      ...(body?.workloadNamespace !== undefined
        ? { workloadNamespace: optionalText(body.workloadNamespace, 'workloadNamespace') ?? null }
        : {}),
      ...(body?.workloadSelector !== undefined
        ? { workloadSelector: optionalText(body.workloadSelector, 'workloadSelector') ?? null }
        : {}),
    };
    const updated = await this.clusters.update(id, changes);
    if (!updated) throw new NotFoundException('Project not found');
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.PROJECT_MODIFIED,
      resourceType: 'project',
      resourceId: id,
      request,
      metadata: { fields: Object.keys(changes) },
    });
    return updated;
  }

  /**
   * Deletes a project and its assignments.
   *
   * Refuses while incidents still reference it: losing an incident's cluster would
   * destroy the record of something that actually happened, which the audit trail is
   * meant to prevent. Resolve or archive the history first.
   */
  @Delete(':id')
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_DELETE)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<void> {
    try {
      const removed = await this.clusters.remove(id);
      if (!removed) throw new NotFoundException('Project not found');
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw new ConflictException(
          'This project still has recorded incidents and cannot be deleted',
        );
      throw error;
    }
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.PROJECT_DELETED,
      resourceType: 'project',
      resourceId: id,
      request,
    });
  }
}
