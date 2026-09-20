import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CONTACT_REPOSITORY, ESCALATION_POLICY_REPOSITORY, NOTIFICATION_GROUP_REPOSITORY, ON_CALL_SCHEDULE_REPOSITORY, normalizePhoneNumber,
  type Contact, type ContactRepository, type EscalationPolicy, type EscalationPolicyRepository,
  type NotificationGroup, type NotificationGroupRepository, type OnCallScheduleRepository,
} from '@faultline/notifications';

const id = z.string().trim().min(1).max(128);
const contactInput = z.object({ organizationId: id, name: z.string().trim().min(1).max(200),
  role: z.enum(['ENGINEER','SENIOR_ENGINEER','TEAM_LEAD','MANAGER','STAKEHOLDER','END_USER']),
  phoneNumber: z.string(), smsEnabled: z.boolean().default(true), voiceEnabled: z.boolean().default(true), enabled: z.boolean().default(true) });
const groupInput = z.object({ organizationId: id, name: z.string().trim().min(1).max(200), contactIds: z.array(id).max(1000), enabled: z.boolean().default(true) });
const target = z.object({ type: z.enum(['CONTACT','GROUP']), id });
const escalationTarget=z.object({type:z.enum(['CONTACT','GROUP','ON_CALL_SCHEDULE']),id});
const step = z.object({ id: id.optional(), order: z.number().int().min(1), target:escalationTarget, channels: z.array(z.enum(['VOICE','SMS'])).min(1),
  maximumAttempts: z.number().int().min(1).max(10), retryDelayMs: z.number().int().min(0).max(86_400_000), waitBeforeNextStepMs: z.number().int().min(0).max(86_400_000) });
const communicationRule=z.object({audience:z.enum(['ENGINEERING','STAKEHOLDER','END_USER']),target,channels:z.array(z.enum(['VOICE','SMS'])).min(1),subscriptions:z.array(z.enum(['INITIAL','STATUS_UPDATES','RESOLUTION'])).min(1),services:z.array(id).optional(),minimumIntervalMs:z.number().int().min(0).max(86_400_000).optional()});
const policyInput = z.object({ organizationId: id, name: z.string().trim().min(1).max(200), enabled: z.boolean().default(true), sendResolution: z.boolean().default(true),
  match: z.object({ severities: z.array(z.enum(['INFO','WARNING','HIGH','CRITICAL'])).min(1), environments: z.array(id).optional(), services: z.array(id).optional(),
    classifications: z.array(z.enum(['MEMORY_EXHAUSTION','RESOURCE_SATURATION','WORKLOAD_CRASHING','DEPLOYMENT_DEGRADATION','NODE_FAILURE','WORKLOAD_CONFIGURATION_FAILURE','SCHEDULING_FAILURE','APPLICATION_DEGRADATION','APPLICATION_DEPENDENCY_FAILURE'])).optional() }),
  steps: z.array(step).min(1), communicationRules:z.array(communicationRule).optional() });
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new BadRequestException({ message: 'Invalid request', fields: result.error.issues.map((issue) => issue.path.join('.')) }); return result.data; }

@Controller('contacts')
export class ContactsController {
  constructor(@Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository) {}
  @Post() async create(@Body() body: unknown) { const input = parse(contactInput, body); const now = new Date().toISOString(); let phoneNumber: string; try { phoneNumber = normalizePhoneNumber(input.phoneNumber); } catch (error) { throw new BadRequestException((error as Error).message); }
    return this.contacts.create({ id: randomUUID(), ...input, phoneNumber, createdAt: now, updatedAt: now }); }
  @Get() @Header('Cache-Control','no-store') list() { return this.contacts.list(); }
  @Get(':id') async get(@Param('id') contactId: string) { const value = await this.contacts.get(contactId); if (!value) throw new NotFoundException('Contact not found'); return value; }
  @Patch(':id') async update(@Param('id') contactId: string, @Body() body: unknown) { const current = await this.contacts.get(contactId); if (!current) throw new NotFoundException('Contact not found'); const input = parse(contactInput.partial(), body); let phoneNumber = current.phoneNumber; if (input.phoneNumber !== undefined) try { phoneNumber = normalizePhoneNumber(input.phoneNumber); } catch (error) { throw new BadRequestException((error as Error).message); }
    return this.contacts.update({ ...current, ...input, phoneNumber, updatedAt: new Date().toISOString() }); }
}

@Controller('notification-groups')
export class NotificationGroupsController {
  constructor(@Inject(NOTIFICATION_GROUP_REPOSITORY) private readonly groups: NotificationGroupRepository, @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository) {}
  @Post() async create(@Body() body: unknown) { const input = parse(groupInput, body); await this.validateContacts(input.contactIds); const now = new Date().toISOString(); return this.groups.create({ id: randomUUID(), ...input, contactIds: [...new Set(input.contactIds)], createdAt: now, updatedAt: now }); }
  @Get() @Header('Cache-Control','no-store') list() { return this.groups.list(); }
  private async validateContacts(ids: readonly string[]) { for (const contactId of ids) if (!(await this.contacts.get(contactId))) throw new BadRequestException(`Unknown contact: ${contactId}`); }
}

@Controller('escalation-policies')
export class EscalationPoliciesController {
  constructor(@Inject(ESCALATION_POLICY_REPOSITORY) private readonly policies: EscalationPolicyRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository, @Inject(NOTIFICATION_GROUP_REPOSITORY) private readonly groups: NotificationGroupRepository,@Inject(ON_CALL_SCHEDULE_REPOSITORY)private readonly schedules:OnCallScheduleRepository) {}
  @Post() async create(@Body() body: unknown) { const input = parse(policyInput, body); await this.validate(input); const now = new Date().toISOString(); return this.policies.create(this.build(randomUUID(), input, now, now)); }
  @Get() @Header('Cache-Control','no-store') list() { return this.policies.list(); }
  @Get(':id') async get(@Param('id') policyId: string) { const value = await this.policies.get(policyId); if (!value) throw new NotFoundException('Escalation policy not found'); return value; }
  @Patch(':id') async update(@Param('id') policyId: string, @Body() body: unknown) { const current = await this.policies.get(policyId); if (!current) throw new NotFoundException('Escalation policy not found'); const input = parse(policyInput.partial(), body); const steps = input.steps ? input.steps.map((value) => ({ ...value, id: value.id ?? randomUUID() })) : current.steps; const merged: EscalationPolicy = { ...current, ...input, match: input.match ? { ...current.match, ...input.match } : current.match, steps: [...steps].sort((a,b) => a.order-b.order), updatedAt: new Date().toISOString() }; await this.validate(merged); return this.policies.update(merged); }
  private build(policyId: string, input: z.infer<typeof policyInput>, createdAt: string, updatedAt: string): EscalationPolicy { return { ...input, id: policyId, steps: input.steps.map((value) => ({ ...value, id: value.id ?? randomUUID() })).sort((a,b) => a.order-b.order), createdAt, updatedAt }; }
  private async validate(input: { steps: readonly { order: number; target: { type: 'CONTACT'|'GROUP'|'ON_CALL_SCHEDULE'; id: string } }[] }) { const orders = input.steps.map((value) => value.order); if (new Set(orders).size !== orders.length) throw new BadRequestException('Escalation step order must be unique'); for (const value of input.steps) { const found=value.target.type==='CONTACT'?await this.contacts.get(value.target.id):value.target.type==='GROUP'?await this.groups.get(value.target.id):await this.schedules.get(value.target.id);if (!found) throw new BadRequestException(`Unknown ${value.target.type.toLowerCase()}: ${value.target.id}`); } }
}
