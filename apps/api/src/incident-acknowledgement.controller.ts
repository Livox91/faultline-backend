import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { INCIDENT_REPOSITORY, type IncidentRepository } from '@faultline/incidents';
import { ESCALATION_EXECUTION_REPOSITORY, INCIDENT_ACKNOWLEDGEMENTS, NOTIFICATION_AUDIT_REPOSITORY,
  type EscalationExecutionRepository, type IncidentAcknowledgementRepository, type NotificationAuditRepository } from '@faultline/notifications';
const inputSchema = z.object({ acknowledgedBy: z.string().trim().min(1).max(200), note: z.string().trim().max(1000).optional() });
@Controller('incidents')
export class IncidentAcknowledgementController {
  constructor(@Inject(INCIDENT_REPOSITORY) private readonly incidents: IncidentRepository, @Inject(ESCALATION_EXECUTION_REPOSITORY) private readonly executions: EscalationExecutionRepository,
    @Inject(INCIDENT_ACKNOWLEDGEMENTS) private readonly acknowledgements: IncidentAcknowledgementRepository, @Inject(NOTIFICATION_AUDIT_REPOSITORY) private readonly audit: NotificationAuditRepository) {}
  @Post(':id/acknowledge') async acknowledge(@Param('id') incidentId: string, @Body() body: unknown) {
    if (!(await this.incidents.getIncident(incidentId))) throw new NotFoundException('Incident not found'); const parsed = inputSchema.safeParse(body); if (!parsed.success) throw new BadRequestException('Invalid acknowledgement');
    const now = new Date().toISOString(); const value = await this.acknowledgements.save({ incidentId, ...parsed.data, acknowledgedAt: now }); const execution = await this.executions.get(incidentId);
    if (execution?.status === 'ACTIVE') await this.executions.save({ ...execution, status: 'ACKNOWLEDGED', completedAt: now });
    await this.audit.append({ id: randomUUID(), incidentId, type: 'INCIDENT_ACKNOWLEDGED', timestamp: now, policyId: execution?.policyId, details: { acknowledgedBy: parsed.data.acknowledgedBy } }); return value;
  }
}
