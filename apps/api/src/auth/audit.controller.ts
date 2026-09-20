import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Query,
} from '@nestjs/common';
import {
  AUDIT_LOG_REPOSITORY,
  PERMISSIONS,
  ROLES,
  type AuditFilter,
  type AuditOutcome,
  type AuditLogRepository,
} from '@faultline/auth';
import { RequirePermission, Roles } from './context';

/**
 * Reads the audit trail. Admin only, and read-only.
 *
 * There is no write, update or delete route here by design, and the table refuses the
 * latter two outright (migration 0005), so the trail cannot be edited through the API
 * even by an Admin.
 */
@Controller('admin/audit')
@Roles(ROLES.ADMIN)
export class AdminAuditController {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly audit: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.AUDIT_VIEW)
  @Header('Cache-Control', 'no-store')
  async list(@Query() params: Record<string, unknown>) {
    const filter: AuditFilter = {
      ...optional('userId', params.userId),
      ...optional('action', params.action),
      ...optional('resourceType', params.resourceType),
      ...optional('resourceId', params.resourceId),
      ...outcome(params.outcome),
      ...timestamp('since', params.since),
      ...timestamp('until', params.until),
      limit: limit(params.limit),
    };
    const items = await this.audit.list(filter);
    return { items, count: items.length };
  }
}

function optional(field: string, value: unknown) {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string') throw new BadRequestException(`Invalid ${field}`);
  return { [field]: value.trim() };
}

function outcome(value: unknown): { outcome?: AuditOutcome } {
  if (value === undefined || value === '') return {};
  if (value !== 'allowed' && value !== 'denied')
    throw new BadRequestException('Invalid outcome');
  return { outcome: value };
}

function timestamp(field: string, value: unknown) {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new BadRequestException(`Invalid ${field}`);
  return { [field]: new Date(value).toISOString() };
}

function limit(value: unknown): number {
  if (value === undefined || value === '') return 200;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000)
    throw new BadRequestException('Invalid limit');
  return parsed;
}
