import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { RetellCommunicationProvider } from './retell.provider';
import { VoiceActionService } from './voice-action.service';
const schema=z.object({incidentId:z.string().min(1),notificationAttemptId:z.string().min(1),recipientId:z.string().min(1),action:z.enum(['ACKNOWLEDGE_INCIDENT','DECLINE_INCIDENT','UNKNOWN']),providerCallId:z.string().min(1),timestamp:z.string().refine((value)=>Number.isFinite(Date.parse(value)),'Invalid timestamp')}).strict();
@Controller('v1/voice/actions')
export class VoiceActionController {
  constructor(private readonly provider:RetellCommunicationProvider,private readonly actions:VoiceActionService){}
  @Post() @HttpCode(200)
  async receive(@Req() request:{rawBody?:Buffer;body:unknown},@Body() body:unknown,@Headers('x-retell-signature') signature?:string){
    if(!request.rawBody||!(await this.provider.verifyWebhook(request.rawBody,signature)))throw new UnauthorizedException('Invalid provider signature');
    const parsed=schema.safeParse(body);if(!parsed.success)throw new BadRequestException({message:'Invalid voice action',fields:parsed.error.issues.map((issue)=>issue.path.join('.'))});
    return this.actions.process(parsed.data);
  }
}
