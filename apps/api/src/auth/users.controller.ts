import { randomUUID } from 'node:crypto';
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
import { FEATURES } from '@faultline/billing';
import {
  AUDIT_ACTIONS,
  DuplicateEmailError,
  PERMISSIONS,
  PROJECT_ASSIGNMENT_REPOSITORY,
  ROLES,
  USER_REPOSITORY,
  allocateUsername,
  generateTemporaryPassword,
  passwordPolicyError,
  verifyPassword,
  parseRole,
  permissionsFor,
  hasProjectAccess,
  type AuthenticatedUser,
  type ProjectAssignmentRepository,
  type UserChanges,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from '@faultline/auth';
import {
  EMAIL_SENDER,
  credentialsEmail,
  type EmailSender,
} from '@faultline/email';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import type { ClusterDirectory } from '@faultline/database';
import {
  CONTACT_REPOSITORY,
  type ContactMethod,
  type ContactRepository,
} from '@faultline/notifications';
import { AuditTrail } from './audit-trail';
import {
  CurrentUser,
  RequirePermission,
  RequiresFeature,
  Roles,
  type RequestWithUser,
} from './context';
import { CLUSTER_DIRECTORY } from '../clusters.controller';
import { AuthSecurityStore } from './security-store';
import { ENGINEER_CONTACT_RULE, e164, isCallable } from '../engineer-contact';

/** Never exposes a password hash, whoever is asking. */
const present = (user: UserRecord, projectIds: readonly string[]) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
  mfaEnabled: user.mfaEnabled,
  permissions: permissionsFor(user.role),
  projectIds,
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
@RequiresFeature(FEATURES.TEAM_MANAGEMENT)
export class AdminUsersController {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROJECT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ProjectAssignmentRepository,
    @Inject(CLUSTER_DIRECTORY) private readonly projects: ClusterDirectory,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly audit: AuditTrail,
    private readonly security: AuthSecurityStore,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.USER_VIEW)
  @Header('Cache-Control', 'no-store')
  async list(@CurrentUser() actor: AuthenticatedUser) {
    const users = await this.users.listByOrganization(actor.organizationId);
    const assignments = await this.assignments.listForUsers(
      users.map((user) => user.id),
    );
    const visibleProjects = new Set(actor.assignments.map((a) => a.projectId));
    return {
      items: users.map((user) =>
        present(
          user,
          (assignments.get(user.id) ?? [])
            .map((a) => a.projectId)
            .filter((id) => visibleProjects.has(id)),
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
    const generatedCredentials = role === ROLES.ONSITE_ENGINEER;
    const password = generatedCredentials
      ? generateTemporaryPassword()
      : text(body?.password, 'password', { required: true })!;
    const passwordError = passwordPolicyError(password);
    if (passwordError) throw new BadRequestException(passwordError);
    const username = generatedCredentials
      ? await allocateUsername(
          name || email.split('@')[0]!,
          async (candidate) =>
            (await this.users.findByUsername(candidate)) !== undefined,
        )
      : undefined;
    if (body?.mfaEnabled === true)
      throw new BadRequestException(
        'MFA must be enabled by the user through authenticator enrollment',
      );
    if (body?.mfaEnabled !== undefined && body.mfaEnabled !== false)
      throw new BadRequestException('Invalid mfaEnabled');
    // Checked before anything is written: an onsite engineer is never created without
    // the phone number Retell calls them on.
    const contactMethod =
      role === ROLES.ONSITE_ENGINEER ? this.contactMethod(body) : undefined;

    let created: UserRecord;
    try {
      created = await this.users.create({
        organizationId: actor.organizationId,
        email,
        name,
        role,
        ...(username ? { username } : {}),
        password,
        status: status(body?.status) ?? 'active',
        // MFA must be enrolled by the account holder so a usable secret and recovery
        // codes exist. Administrators may reset it later, but cannot fabricate it.
        mfaEnabled: false,
        // An emailed password is only a bootstrap credential. The engineer is confined
        // to changing it before any project or incident data can be reached.
        mustChangePassword: generatedCredentials,
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError)
        throw new ConflictException(error.message);
      throw error;
    }

    const now = new Date().toISOString();
    const contact = contactMethod
      ? await this.contacts.create({
          id: randomUUID(),
          organizationId: created.organizationId,
          userId: created.id,
          name: created.name,
          role: 'ENGINEER',
          ...contactMethod,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
      : undefined;

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

    if (generatedCredentials) {
      // As with subscription-created admins, plaintext exists only long enough to
      // compose this message. It is never returned by the API or stored in the database.
      await this.email.send(
        credentialsEmail({
          applicationName: this.config.applicationName,
          to: created.email,
          username: username!,
          temporaryPassword: password,
          loginUrl: `${this.config.publicUrl}/login`,
          roleName: 'onsite engineer',
        }),
      );
    }
    return { ...present(created, projectIds), ...(contact ? { contact } : {}) };
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
    const existing = await this.users.findByIdInOrganization(
      id,
      actor.organizationId,
    );
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
    // Becoming an onsite engineer makes the account someone Retell calls, so it needs a
    // contact that can take the call first.
    if (
      role === ROLES.ONSITE_ENGINEER &&
      existing.role !== ROLES.ONSITE_ENGINEER &&
      !(await this.contacts.findByUserIds([id], existing.organizationId)).some(
        isCallable,
      )
    )
      throw new BadRequestException(ENGINEER_CONTACT_RULE);

    const password = text(body?.password, 'password');
    const passwordError =
      password === undefined ? undefined : passwordPolicyError(password);
    if (passwordError) throw new BadRequestException(passwordError);
    if (
      password !== undefined &&
      (await verifyPassword(password, existing.passwordHash ?? null))
    )
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    if (body?.mfaEnabled === true)
      throw new BadRequestException(
        'MFA must be enabled by the user through authenticator enrollment',
      );
    if (body?.mfaEnabled !== undefined && body.mfaEnabled !== false)
      throw new BadRequestException('Invalid mfaEnabled');

    const changes: UserChanges = {
      ...(text(body?.name, 'name') !== undefined
        ? { name: text(body?.name, 'name')! }
        : {}),
      ...(role ? { role } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(body?.mfaEnabled !== undefined ? { mfaEnabled: false } : {}),
    };
    if (password !== undefined || nextStatus === 'disabled' || body?.mfaEnabled === false)
      await this.security.revokeAllSessions(id);

    const updated = await this.users.updateInOrganization(
      id,
      actor.organizationId,
      changes,
    );
    if (!updated) throw new NotFoundException('User not found');

    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.USER_MODIFIED,
      resourceType: 'user',
      resourceId: id,
      request,
      metadata: {
        fields: Object.keys(changes).filter((f) => f !== 'password'),
      },
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
    if (nextStatus && nextStatus !== existing.status)
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        resourceType: 'user',
        resourceId: id,
        request,
        metadata: { from: existing.status, to: nextStatus },
      });
    if (password !== undefined)
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        resourceType: 'user',
        resourceId: id,
        request,
        metadata: { administratorInitiated: id !== actor.id },
      });
    if (body?.mfaEnabled === false && existing.mfaEnabled)
      await this.audit.record({
        user: actor,
        action: AUDIT_ACTIONS.USER_MFA_RESET,
        resourceType: 'user',
        resourceId: id,
        request,
        metadata: { administratorInitiated: id !== actor.id },
      });

    const visibleProjects = new Set(actor.assignments.map((a) => a.projectId));
    const assignments = (await this.assignments.listForUser(id)).filter((a) =>
      visibleProjects.has(a.projectId),
    );
    return present(
      updated,
      assignments.map((a) => a.projectId),
    );
  }

  /** Immediately signs a potentially compromised account out on every device. */
  @Post(':id/revoke-sessions')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @Header('Cache-Control', 'no-store')
  async revokeSessions(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<void> {
    const user = await this.users.findByIdInOrganization(id, actor.organizationId);
    if (!user) throw new NotFoundException('User not found');
    await this.security.revokeAllSessions(id);
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.SESSIONS_REVOKED,
      resourceType: 'user',
      resourceId: id,
      request,
      metadata: { reason: 'suspected_compromise' },
    });
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
    const user = await this.users.findByIdInOrganization(
      id,
      actor.organizationId,
    );
    if (!user) throw new NotFoundException('User not found');
    if (!hasProjectAccess(actor, projectId))
      throw new NotFoundException('Project not found');
    if (!(await this.projects.get(projectId, actor.organizationId)))
      throw new NotFoundException('Project not found');

    const environments = Array.isArray(body?.environments)
      ? (body.environments as unknown[]).filter(
          (value): value is string =>
            typeof value === 'string' && !!value.trim(),
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
    const user = await this.users.findByIdInOrganization(
      id,
      actor.organizationId,
    );
    if (!user) throw new NotFoundException('Assignment not found');
    if (!hasProjectAccess(actor, projectId))
      throw new NotFoundException('Assignment not found');
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

  /** Voice is not optional for an onsite engineer; SMS is, and defaults to on. */
  private contactMethod(body: Record<string, unknown>): ContactMethod {
    const phoneNumber = e164(body?.phoneNumber);
    if (body?.voiceEnabled === false)
      throw new BadRequestException(ENGINEER_CONTACT_RULE);
    if (body?.smsEnabled !== undefined && typeof body.smsEnabled !== 'boolean')
      throw new BadRequestException('Invalid smsEnabled');
    return {
      phoneNumber,
      voiceEnabled: true,
      smsEnabled: body?.smsEnabled !== false,
    };
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
      if (!hasProjectAccess(actor, projectId))
        throw new NotFoundException(`Project not found: ${projectId}`);
      if (!(await this.projects.get(projectId, actor.organizationId)))
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
