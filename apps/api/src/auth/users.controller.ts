import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  DuplicateEmailError,
  PERMISSIONS,
  PROJECT_ASSIGNMENT_REPOSITORY,
  ROLES,
  USER_REPOSITORY,
  parseRole,
  permissionsFor,
  type AuthenticatedUser,
  type ProjectAssignmentRepository,
  type UserChanges,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from '@faultline/auth';
import type { ClusterDirectory } from '@faultline/database';
import { AuditTrail } from './audit-trail';
import {
  CurrentUser,
  RequirePermission,
  Roles,
  type RequestWithUser,
} from './context';
import { CLUSTER_DIRECTORY } from '../clusters.controller';

/** Never exposes a password hash, whoever is asking. */
const present = (user: UserRecord, projectIds: readonly string[]) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
  mfaEnabled: user.mfaEnabled,
  permissions: permissionsFor(user.role),
  // An Admin reaches every project, so listing projects against one would misrepresent
  // their access as a finite set. Null says "not scoped by assignment".
  projectIds: user.role === ROLES.ADMIN ? null : projectIds,
  external: !!user.externalSubject,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const text = (value: unknown, field: string, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`Invalid ${field}`);
  return value.trim();
};

const status = (value: unknown): UserStatus | undefined => {
  if (value === undefined) return undefined;
  if (value !== 'active' && value !== 'disabled')
    throw new BadRequestException('Invalid status');
  return value;
};

/**
 * User management, and with it project assignment.
 *
 * Assignment lives on the user rather than in a separate permissions screen on purpose:
 * `project_users` is the only thing that grants an Onsite Engineer access, so there is
 * exactly one place to look and one place to change it.
 */
@Controller('admin/users')
@Roles(ROLES.ADMIN)
export class AdminUsersController {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROJECT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ProjectAssignmentRepository,
    @Inject(CLUSTER_DIRECTORY) private readonly projects: ClusterDirectory,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.USER_VIEW)
  @Header('Cache-Control', 'no-store')
  async list() {
    const users = await this.users.list();
    const assignments = await this.assignments.listForUsers(
      users.map((user) => user.id),
    );
    return {
      items: users.map((user) =>
        present(
          user,
          (assignments.get(user.id) ?? []).map((a) => a.projectId),
        ),
      ),
      count: users.length,
    };
  }

  @Post()
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @Header('Cache-Control', 'no-store')
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const email = text(body?.email, 'email', { required: true })!;
    const name = text(body?.name, 'name', { required: true })!;
    const role = parseRole(body?.role);
    if (!role) throw new BadRequestException('Invalid role');
    const password = text(body?.password, 'password', { required: true })!;
    if (password.length < 12)
      throw new BadRequestException('Password must be at least 12 characters');

    let created: UserRecord;
    try {
      created = await this.users.create({
        email,
        name,
        role,
        password,
        status: status(body?.status) ?? 'active',
        mfaEnabled: body?.mfaEnabled === true,
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError)
        throw new ConflictException(error.message);
      throw error;
    }

    // Projects may be named at creation so an engineer is never briefly account-
    // without-access, which reads as a broken login to the person using it.
    const projectIds = await this.assignProjects(
      created.id,
      body?.projectIds,
      actor,
      request,
    );

    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.USER_CREATED,
      resourceType: 'user',
      resourceId: created.id,
      request,
      metadata: { email: created.email, role: created.role },
    });
    return present(created, projectIds);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @Header('Cache-Control', 'no-store')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const existing = await this.users.findById(id);
    if (!existing) throw new NotFoundException('User not found');

    const role = body?.role === undefined ? undefined : parseRole(body.role);
    if (body?.role !== undefined && !role)
      throw new BadRequestException('Invalid role');
    const nextStatus = status(body?.status);

    // An Admin must not be able to lock the system out of administration by demoting
    // or disabling themselves; another Admin can still do either.
    if (id === actor.id && role && role !== ROLES.ADMIN)
      throw new BadRequestException('You cannot change your own role');
    if (id === actor.id && nextStatus === 'disabled')
      throw new BadRequestException('You cannot disable your own account');

    const password = text(body?.password, 'password');
    if (password !== undefined && password.length < 12)
      throw new BadRequestException('Password must be at least 12 characters');

    const changes: UserChanges = {
      ...(text(body?.name, 'name') !== undefined
        ? { name: text(body?.name, 'name')! }
        : {}),
      ...(role ? { role } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(body?.mfaEnabled !== undefined
        ? { mfaEnabled: body.mfaEnabled === true }
        : {}),
    };
    const updated = await this.users.update(id, changes);
    if (!updated) throw new NotFoundException('User not found');

    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.USER_MODIFIED,
      resourceType: 'user',
      resourceId: id,
      request,
      metadata: { fields: Object.keys(changes).filter((f) => f !== 'password') },
    });
    // A role change is a permission change; it is recorded as one so that auditing
    // "who gained access to what" does not have to infer it from a generic edit.
    if (role && role !== existing.role)
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.PERMISSION_CHANGED,
        resourceType: 'user',
        resourceId: id,
        request,
        metadata: { from: existing.role, to: role },
      });

    const assignments = await this.assignments.listForUser(id);
    return present(
      updated,
      assignments.map((a) => a.projectId),
    );
  }

  @Put(':id/projects/:projectId')
  @RequirePermission(PERMISSIONS.PROJECT_ASSIGN)
  @Header('Cache-Control', 'no-store')
  async assign(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException('User not found');
    if (!(await this.projects.get(projectId)))
      throw new NotFoundException('Project not found');

    const environments = Array.isArray(body?.environments)
      ? (body.environments as unknown[]).filter(
          (value): value is string => typeof value === 'string' && !!value.trim(),
        )
      : [];

    const assignment = await this.assignments.assign(
      id,
      projectId,
      actor.id,
      environments,
    );
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.PROJECT_ASSIGNED,
      resourceType: 'project',
      resourceId: projectId,
      request,
      metadata: { userId: id, email: user.email, environments },
    });
    return assignment;
  }

  @Delete(':id/projects/:projectId')
  @RequirePermission(PERMISSIONS.PROJECT_ASSIGN)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async unassign(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<void> {
    const removed = await this.assignments.remove(id, projectId);
    if (!removed) throw new NotFoundException('Assignment not found');
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.PROJECT_ASSIGNMENT_REMOVED,
      resourceType: 'project',
      resourceId: projectId,
      request,
      metadata: { userId: id },
    });
  }

  private async assignProjects(
    userId: string,
    value: unknown,
    actor: AuthenticatedUser,
    request: RequestWithUser,
  ): Promise<readonly string[]> {
    if (!Array.isArray(value)) return [];
    const ids = value.filter(
      (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
    );
    const assigned: string[] = [];
    for (const projectId of ids) {
      if (!(await this.projects.get(projectId)))
        throw new NotFoundException(`Project not found: ${projectId}`);
      await this.assignments.assign(userId, projectId, actor.id, []);
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.PROJECT_ASSIGNED,
        resourceType: 'project',
        resourceId: projectId,
        request,
        metadata: { userId },
      });
      assigned.push(projectId);
    }
    return assigned;
  }
}
