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
import { z } from 'zod';
import { AUDIT_ACTIONS, type AuthenticatedUser } from '@faultline/auth';
import {
  AVAILABILITY_OVERRIDE_REPOSITORY,
  CONTACT_REPOSITORY,
  ON_CALL_SCHEDULE_REPOSITORY,
  ON_CALL_SHIFT_REPOSITORY,
  OnCallResolver,
  isValidTimezone,
  validateTimeRange,
  type AvailabilityOverrideRepository,
  type ContactRepository,
  type OnCallScheduleRepository,
  type OnCallShiftRepository,
} from '@faultline/notifications';
import { AuditTrail } from './auth/audit-trail';
import { CurrentUser, type RequestWithUser } from './auth/context';

const id = z.string().trim().min(1).max(128);
const instant = z.string().trim().min(1);
const scheduleInput = z.object({
  organizationId: id,
  teamId: id,
  name: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});
const shiftInput = z.object({
  contactId: id,
  startsAt: instant,
  endsAt: instant,
});
const overrideInput = z.object({
  replacementContactId: id,
  startsAt: instant,
  endsAt: instant,
  reason: z.string().trim().min(1).max(500),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException({
      message: 'Invalid request',
      fields: result.error.issues.map((issue) => issue.path.join('.')),
    });
  return result.data;
}

@Controller('on-call/schedules')
export class OnCallController {
  private readonly resolver: OnCallResolver;

  constructor(
    @Inject(ON_CALL_SCHEDULE_REPOSITORY)
    private readonly schedules: OnCallScheduleRepository,
    @Inject(ON_CALL_SHIFT_REPOSITORY)
    private readonly shifts: OnCallShiftRepository,
    @Inject(AVAILABILITY_OVERRIDE_REPOSITORY)
    private readonly overrides: AvailabilityOverrideRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    private readonly audit: AuditTrail,
  ) {
    this.resolver = new OnCallResolver(schedules, shifts, overrides);
  }

  @Post()
  async create(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const input = parse(scheduleInput, body);
    if (!isValidTimezone(input.timezone))
      throw new BadRequestException('Invalid IANA timezone');
    const now = new Date().toISOString();
    const schedule = await this.schedules.create({
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.ON_CALL_SCHEDULE_CREATED,
      resourceType: 'on-call-schedule',
      resourceId: schedule.id,
      request,
      metadata: {
        organizationId: schedule.organizationId,
        teamId: schedule.teamId,
      },
    });
    return schedule;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.schedules.list();
  }

  @Get(':id')
  get(@Param('id') scheduleId: string) {
    return this.schedule(scheduleId);
  }

  @Patch(':id')
  async update(
    @Param('id') scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    const current = await this.schedule(scheduleId);
    const input = parse(scheduleInput.partial(), body);
    if (input.timezone && !isValidTimezone(input.timezone))
      throw new BadRequestException('Invalid IANA timezone');
    const updated = await this.schedules.update({
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    });
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.ON_CALL_SCHEDULE_UPDATED,
      resourceType: 'on-call-schedule',
      resourceId: scheduleId,
      request,
      metadata: { fields: Object.keys(input) },
    });
    return updated;
  }

  @Post(':id/shifts')
  async addShift(
    @Param('id') scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    await this.enabledSchedule(scheduleId);
    const input = parse(shiftInput, body);
    if (!(await this.contacts.get(input.contactId)))
      throw new BadRequestException('Unknown contact');
    let range;
    try {
      range = validateTimeRange(input.startsAt, input.endsAt);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    if (await this.shifts.hasOverlap(scheduleId, range.startsAt, range.endsAt))
      throw new BadRequestException('Shift overlaps an existing shift');
    const now = new Date().toISOString();
    const shift = await this.shifts.create({
      id: randomUUID(),
      scheduleId,
      contactId: input.contactId,
      ...range,
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.ON_CALL_SHIFT_CREATED,
      resourceType: 'on-call-shift',
      resourceId: shift.id,
      request,
      metadata: { scheduleId, contactId: shift.contactId },
    });
    return shift;
  }

  @Get(':id/shifts')
  async listShifts(@Param('id') scheduleId: string) {
    await this.schedule(scheduleId);
    return this.shifts.listForSchedule(scheduleId);
  }

  @Post(':id/overrides')
  async addOverride(
    @Param('id') scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ) {
    await this.enabledSchedule(scheduleId);
    const input = parse(overrideInput, body);
    if (!(await this.contacts.get(input.replacementContactId)))
      throw new BadRequestException('Unknown replacement contact');
    let range;
    try {
      range = validateTimeRange(input.startsAt, input.endsAt);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    if (
      await this.overrides.hasOverlap(scheduleId, range.startsAt, range.endsAt)
    )
      throw new BadRequestException('Override overlaps an existing override');
    const now = new Date().toISOString();
    const override = await this.overrides.create({
      id: randomUUID(),
      scheduleId,
      replacementContactId: input.replacementContactId,
      reason: input.reason,
      ...range,
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.AVAILABILITY_OVERRIDE_CREATED,
      resourceType: 'availability-override',
      resourceId: override.id,
      request,
      metadata: {
        scheduleId,
        replacementContactId: override.replacementContactId,
      },
    });
    return override;
  }

  @Get(':id/overrides')
  async listOverrides(@Param('id') scheduleId: string) {
    await this.schedule(scheduleId);
    return this.overrides.listForSchedule(scheduleId);
  }

  @Get(':id/current')
  async current(@Param('id') scheduleId: string) {
    await this.schedule(scheduleId);
    const assignment = await this.resolver.resolve(scheduleId);
    if (!assignment)
      return {
        contact: null,
        activeShift: null,
        activeOverride: null,
        validUntil: null,
      };
    const contact = await this.contacts.get(assignment.contactId);
    return {
      contact: contact ?? null,
      activeShift: assignment.shift,
      activeOverride: assignment.override ?? null,
      validUntil: assignment.validUntil,
    };
  }

  private async schedule(scheduleId: string) {
    const value = await this.schedules.get(scheduleId);
    if (!value) throw new NotFoundException('On-call schedule not found');
    return value;
  }

  private async enabledSchedule(scheduleId: string) {
    const value = await this.schedule(scheduleId);
    if (!value.enabled)
      throw new BadRequestException('On-call schedule is disabled');
    return value;
  }
}
