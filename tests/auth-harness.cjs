/**
 * Test harness for the authenticated API.
 *
 * Every route is behind a global guard now, so a test that boots a controller has to
 * say who is calling. Two ways are offered, and they test different things:
 *
 *   - `actingAs(user)` installs a stub guard that simply asserts an identity. Use it
 *     when the subject under test is the controller's own logic, not the token path.
 *   - `realGuards(...)` wires the actual AuthenticationGuard and AuthorizationGuard, so
 *     the test exercises token verification, role checks and project-assignment checks
 *     exactly as a deployed API would. Use it for anything about access itself.
 */
const { Module, SetMetadata } = require('@nestjs/common');
const { APP_GUARD, Reflector } = require('@nestjs/core');
const { NestFactory } = require('@nestjs/core');
const {
  AUDIT_LOG_REPOSITORY,
  PROJECT_ASSIGNMENT_REPOSITORY,
  USER_REPOSITORY,
  InMemoryAuditLogRepository,
  InMemoryProjectAssignmentRepository,
  InMemoryUserRepository,
  issueAccessToken,
} = require('@faultline/auth');
const { APPLICATION_CONFIG } = require('@faultline/platform');
const {
  AuthenticationGuard,
} = require('../apps/api/dist/auth/authentication.guard');
const {
  AuthorizationGuard,
} = require('../apps/api/dist/auth/authorization.guard');
const { AuditTrail } = require('../apps/api/dist/auth/audit-trail');

const TOKEN_SECRET = 'test-secret-that-is-long-enough-to-sign-with';
const ISSUER = 'faultline-test';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
  debug() {},
  verbose() {},
};

/** A config object shaped like ApplicationConfig, with only what the API reads. */
function apiConfig(overrides = {}) {
  return {
    application: 'api',
    environment: 'test',
    version: '0.1.0-test',
    auth: {
      jwtSecret: TOKEN_SECRET,
      issuer: ISSUER,
      accessTokenTtlSeconds: 3600,
      mfaRequired: false,
      ...(overrides.auth ?? {}),
    },
    telemetryStorage: {
      queryLimits: overrides.queryLimits ?? {},
      ...(overrides.queryClusterScope
        ? { queryClusterScope: overrides.queryClusterScope }
        : {}),
    },
    ...overrides.extra,
  };
}

const admin = (overrides = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'admin@faultline.test',
  name: 'Administrator',
  role: 'admin',
  status: 'active',
  mfaEnabled: false,
  assignments: [],
  ...overrides,
});

const engineer = (projectIds = [], overrides = {}) => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  email: 'engineer@faultline.test',
  name: 'Onsite Engineer',
  role: 'onsiteengineer',
  status: 'active',
  mfaEnabled: false,
  assignments: projectIds.map((projectId) => ({ projectId })),
  ...overrides,
});

/** Stub guard: asserts an identity without going through a token. */
function actingAs(user) {
  return {
    provide: APP_GUARD,
    useValue: {
      canActivate(context) {
        context.switchToHttp().getRequest().user = user;
        return true;
      },
    },
  };
}

function tokenFor(user) {
  return issueAccessToken(
    { sub: user.id, email: user.email, role: user.role },
    { secret: TOKEN_SECRET, issuer: ISSUER, ttlSeconds: 3600 },
  ).token;
}

/**
 * Boots a module with the real guards in front of it.
 *
 * Returns the app plus the repositories it was built on, so a test can add users and
 * assignments and watch the guards react to them.
 */
async function bootWithRealGuards({
  controllers = [],
  providers = [],
  users = new InMemoryUserRepository(),
  assignments = new InMemoryProjectAssignmentRepository(),
  audit = new InMemoryAuditLogRepository(),
  config = apiConfig(),
} = {}) {
  class TestModule {}
  Module({
    controllers,
    providers: [
      ...providers,
      { provide: USER_REPOSITORY, useValue: users },
      { provide: PROJECT_ASSIGNMENT_REPOSITORY, useValue: assignments },
      { provide: AUDIT_LOG_REPOSITORY, useValue: audit },
      { provide: APPLICATION_CONFIG, useValue: config },
      { provide: Reflector, useValue: new Reflector() },
      { provide: require('@faultline/platform').ApplicationLogger, useValue: silentLogger },
      AuditTrail,
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      { provide: APP_GUARD, useClass: AuthorizationGuard },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, users, assignments, audit, base: await app.getUrl() };
}

module.exports = {
  TOKEN_SECRET,
  ISSUER,
  actingAs,
  admin,
  apiConfig,
  bootWithRealGuards,
  engineer,
  silentLogger,
  tokenFor,
  SetMetadata,
};
