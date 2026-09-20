import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  ROLES,
  USER_REPOSITORY,
  type UserRepository,
} from '@faultline/auth';

/**
 * Seeds the first Admin.
 *
 * Every route now refuses anonymous callers, so a freshly migrated database is a system
 * nobody can get into: there is no Admin, and only an Admin can create one. This closes
 * that loop once, and only while the users table is empty - it will not resurrect a
 * deliberately deleted account, and it never overwrites an existing password.
 */
@Injectable()
export class AdminBootstrap implements OnApplicationBootstrap {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const seed = this.config.auth.bootstrapAdmin;
    if (!seed) return;

    const existing = await this.users.list();
    if (existing.length) {
      this.logger.log({
        event: 'admin_bootstrap_skipped',
        reason: 'users_already_exist',
      });
      return;
    }

    const admin = await this.users.create({
      email: seed.email,
      name: 'Administrator',
      role: ROLES.ADMIN,
      password: seed.password,
    });
    // The password is never logged. Operators are told to remove the seed values once
    // they have signed in, because an env file is not a credential store.
    this.logger.warn({
      event: 'admin_bootstrap_created',
      email: admin.email,
      note: 'Sign in, change this password, then unset AUTH_BOOTSTRAP_ADMIN_* ',
    });
  }
}
