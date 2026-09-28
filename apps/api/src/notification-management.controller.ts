import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { USER_REPOSITORY, type UserRepository } from '@faultline/auth';
import {
  CONTACT_REPOSITORY,
  NOTIFICATION_GROUP_REPOSITORY,
  normalizePhoneNumber,
  type ContactRepository,
  type NotificationGroupRepository,
} from '@faultline/notifications';
import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const contactInput = z.object({
  organizationId: id,
  userId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(['ENGINEER', 'SENIOR_ENGINEER', 'TEAM_LEAD', 'MANAGER', 'STAKEHOLDER', 'END_USER']),
  phoneNumber: z.string(),
  smsEnabled: z.boolean().default(true),
  voiceEnabled: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
const groupInput = z.object({
  organizationId: id,
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
export class ContactsController {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = parse(contactInput, body);
    await this.validateUser(input.userId, input.organizationId);
    const now = new Date().toISOString();
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(input.phoneNumber);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return this.contacts.create({
      id: randomUUID(),
      ...input,
      phoneNumber,
      createdAt: now,
      updatedAt: now,
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.contacts.list();
  }

  @Get(':id')
  async get(@Param('id') contactId: string) {
    const value = await this.contacts.get(contactId);
    if (!value) throw new NotFoundException('Contact not found');
    return value;
  }

  @Patch(':id')
  async update(@Param('id') contactId: string, @Body() body: unknown) {
    const current = await this.contacts.get(contactId);
    if (!current) throw new NotFoundException('Contact not found');
    const input = parse(contactInput.partial(), body);
    const organizationId = input.organizationId ?? current.organizationId;
    await this.validateUser(input.userId, organizationId);
    let phoneNumber = current.phoneNumber;
    if (input.phoneNumber !== undefined)
      try {
        phoneNumber = normalizePhoneNumber(input.phoneNumber);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    return this.contacts.update({
      ...current,
      ...input,
      phoneNumber,
      updatedAt: new Date().toISOString(),
    });
  }

  private async validateUser(userId: string | undefined, organizationId: string) {
    if (!userId) return;
    const user = await this.users.findById(userId);
    if (!user || user.organizationId !== organizationId)
      throw new BadRequestException('Linked user does not belong to this organization');
  }
}

@Controller('notification-groups')
export class NotificationGroupsController {
  constructor(
    @Inject(NOTIFICATION_GROUP_REPOSITORY) private readonly groups: NotificationGroupRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = parse(groupInput, body);
    for (const contactId of input.contactIds)
      if (!(await this.contacts.get(contactId)))
        throw new BadRequestException(`Unknown contact: ${contactId}`);
    const now = new Date().toISOString();
    return this.groups.create({
      id: randomUUID(),
      ...input,
      contactIds: [...new Set(input.contactIds)],
      createdAt: now,
      updatedAt: now,
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.groups.list();
  }
}
