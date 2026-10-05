import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { FEATURES } from '@faultline/billing';
import {
  CurrentUser,
  RequiresFeature,
  type RequestWithUser,
} from './auth/context';
import {
  AUDIT_ACTIONS,
  ROLES,
  USER_REPOSITORY,
  type AuthenticatedUser,
  type UserRepository,
} from '@faultline/auth';
import {
  CONTACT_REPOSITORY,
  NOTIFICATION_GROUP_REPOSITORY,
  normalizePhoneNumber,
  type Contact,
  type ContactRepository,
  type NotificationGroupRepository,
} from '@faultline/notifications';
import { z } from 'zod';
import { ENGINEER_CONTACT_RULE, isCallable } from './engineer-contact';
import { AuditTrail } from './auth/audit-trail';

const id = z.string().trim().min(1).max(128);
const contactInput = z.object({
  organizationId: id.optional(),
  userId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(['ENGINEER', 'SENIOR_ENGINEER', 'TEAM_LEAD', 'MANAGER', 'STAKEHOLDER', 'END_USER']),
  phoneNumber: z.string(),
  smsEnabled: z.boolean().default(true),
  voiceEnabled: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
const groupInput = z.object({
  organizationId: id.optional(),
  name: z.string().trim().min(1).max(200),
  contactIds: z.array(id).max(1000),
  enabled: z.boolean().default(true),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      message: 'Invalid request',
      fields: result.error.issues.map((issue) => issue.path.join('.')),
    });
  return result.data;
}

@Controller('contacts')
@RequiresFeature(FEATURES.VOICE_AGENT)
export class ContactsController {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly audit: AuditTrail,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const input = parse(contactInput, body);
    this.assertOrganization(input.organizationId, actor.organizationId);
    await this.validateUser(input.userId, actor.organizationId);
    const now = new Date().toISOString();
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(input.phoneNumber);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const contact: Contact = {
      id: randomUUID(),
      ...input,
      organizationId: actor.organizationId,
      phoneNumber,
      createdAt: now,
      updatedAt: now,
    };
    await this.requireCallableEngineer(contact);
    const created = await this.contacts.create(contact);
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.CONTACT_CREATED,
      resourceType: 'contact',
      resourceId: created.id,
      request,
    });
    return created;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.contacts.list(actor.organizationId);
  }

  @Get(':id')
  async get(
    @Param('id') contactId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const value = await this.contacts.get(contactId);
    if (!value || value.organizationId !== actor.organizationId)
      throw new NotFoundException('Contact not found');
    return value;
  }

  @Patch(':id')
  async update(
    @Param('id') contactId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const current = await this.contacts.get(contactId);
    if (!current || current.organizationId !== actor.organizationId)
      throw new NotFoundException('Contact not found');
    const input = parse(contactInput.partial(), body);
    this.assertOrganization(input.organizationId, actor.organizationId);
    await this.validateUser(input.userId, actor.organizationId);
    let phoneNumber = current.phoneNumber;
    if (input.phoneNumber !== undefined)
      try {
        phoneNumber = normalizePhoneNumber(input.phoneNumber);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    const contact: Contact = {
      ...current,
      ...input,
      organizationId: actor.organizationId,
      phoneNumber,
      updatedAt: new Date().toISOString(),
    };
    await this.requireCallableEngineer(contact);
    const updated = await this.contacts.update(contact);
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.CONTACT_UPDATED,
      resourceType: 'contact',
      resourceId: updated.id,
      request,
    });
    return updated;
  }

  /** An onsite engineer's contact is how Retell reaches them, so it must stay callable. */
  private async requireCallableEngineer(contact: Contact) {
    if (!contact.userId) return;
    const user = await this.users.findById(contact.userId);
    if (user?.role === ROLES.ONSITE_ENGINEER && !isCallable(contact))
      throw new BadRequestException(ENGINEER_CONTACT_RULE);
  }

  private async validateUser(userId: string | undefined, organizationId: string) {
    if (!userId) return;
    const user = await this.users.findById(userId);
    if (!user || user.organizationId !== organizationId)
      throw new BadRequestException('Linked user does not belong to this organization');
  }

  private assertOrganization(requested: string | undefined, actual: string) {
    if (requested && requested !== actual)
      throw new BadRequestException('Organization does not match the authenticated user');
  }
}

@Controller('notification-groups')
@RequiresFeature(FEATURES.VOICE_AGENT)
export class NotificationGroupsController {
  constructor(
    @Inject(NOTIFICATION_GROUP_REPOSITORY) private readonly groups: NotificationGroupRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    private readonly audit: AuditTrail,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const input = parse(groupInput, body);
    if (input.organizationId && input.organizationId !== actor.organizationId)
      throw new BadRequestException('Organization does not match the authenticated user');
    for (const contactId of input.contactIds) {
      const contact = await this.contacts.get(contactId);
      if (!contact || contact.organizationId !== actor.organizationId)
        throw new BadRequestException(`Unknown contact: ${contactId}`);
    }
    const now = new Date().toISOString();
    const created = await this.groups.create({
      id: randomUUID(),
      ...input,
      organizationId: actor.organizationId,
      contactIds: [...new Set(input.contactIds)],
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.record({
      user: actor,
      action: AUDIT_ACTIONS.NOTIFICATION_GROUP_CREATED,
      resourceType: 'notification-group',
      resourceId: created.id,
      request,
    });
    return created;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.groups.list(actor.organizationId);
  }
}
