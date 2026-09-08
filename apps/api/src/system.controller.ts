import { Controller, Get, Header, Inject } from '@nestjs/common';
import { APPLICATION_CONFIG, type ApplicationConfig } from '@faultline/platform';

@Controller('system')
export class SystemController {
  constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  @Get('info')
  @Header('Cache-Control', 'no-store')
  info() {
    return {
      application: this.config.application,
      environment: this.config.environment,
      version: this.config.version,
      enabledComponents: this.config.enabledComponents,
    };
  }
}
