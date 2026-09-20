import { Controller,Get,Header,Inject,NotFoundException,Param } from '@nestjs/common';
import { INCIDENT_REPOSITORY,type IncidentRepository } from '@faultline/incidents';
import { ESCALATION_EXECUTION_REPOSITORY,INCIDENT_COMMUNICATION_REPOSITORY,NOTIFICATION_ATTEMPTS,type EscalationExecutionRepository,type IncidentCommunicationRepository,type NotificationAttemptRepository } from '@faultline/notifications';
@Controller('incidents/:id')
export class IncidentNotificationStateController {
  constructor(@Inject(INCIDENT_REPOSITORY)private readonly incidents:IncidentRepository,@Inject(INCIDENT_COMMUNICATION_REPOSITORY)private readonly communications:IncidentCommunicationRepository,@Inject(ESCALATION_EXECUTION_REPOSITORY)private readonly executions:EscalationExecutionRepository,@Inject(NOTIFICATION_ATTEMPTS)private readonly attempts:NotificationAttemptRepository){}
  private async exists(id:string){if(!(await this.incidents.getIncident(id)))throw new NotFoundException('Incident not found');}
  @Get('communications')@Header('Cache-Control','no-store')async listCommunications(@Param('id')id:string){await this.exists(id);return this.communications.listForIncident(id);}
  @Get('escalation')@Header('Cache-Control','no-store')async getEscalation(@Param('id')id:string){await this.exists(id);const value=await this.executions.get(id);if(!value)throw new NotFoundException('Escalation not found');return value;}
  @Get('notification-attempts')@Header('Cache-Control','no-store')async listAttempts(@Param('id')id:string){await this.exists(id);return this.attempts.listForIncident(id);}
}
