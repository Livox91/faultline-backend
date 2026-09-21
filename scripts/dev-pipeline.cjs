// Development composition root: independent apps share process-local queue and incidents.
require('reflect-metadata');
const { resolve } = require('node:path');
const { parseEnv } = require('./onboarding/lib.cjs');
const { NestFactory } = require('@nestjs/core');
const {
  APPLICATION_CONFIG,
  ApplicationLogger,
} = require('@faultline/platform');
const { getDevelopmentQueue } = require('@faultline/queue');
const { startWebhookForwarding } = require('./stripe-webhooks.cjs');
const apps = [];
let stopping;
let stopWebhooks = () => {};

// The composed process must receive the union of the independently deployable
// applications' local configuration. Nest's dotenv loading only happens once in a
// shared process, so relying on each AppModule to load its own file drops settings
// required by modules started later (for example ClickHouse credentials).
for (const name of ['api', 'ingestion', 'processor', 'storage']) {
  const values = parseEnv(resolve(__dirname, `../apps/${name}/.env`));
  for (const [key, value] of Object.entries(values))
    if (key !== 'PORT' && process.env[key] === undefined)
      process.env[key] = value;
}
async function shutdown() {
  return (stopping ??= (async () => {
    stopWebhooks();
    for (const app of [...apps].reverse()) await app.close();
    await getDevelopmentQueue().close();
  })());
}
(async () => {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development pipeline disabled in production');
  // Storage runs alongside the processor as a separate consumer of the same broker
  // subject, mirroring the deployed topology.
  const defaultPorts = {
    api: '3000',
    ingestion: '3001',
    processor: '3002',
    storage: '3003',
  };
  /**
   * Webhook forwarding, before the API is loaded.
   *
   * Order is the whole point: the signing secret has to be in `apps/api/.env` before
   * `app.module.js` is required, because configuration is read from that file at import
   * time. Started here rather than left to the developer because a missing forwarder
   * makes a successful test payment provision nothing, silently.
   */
  stopWebhooks = startWebhookForwarding({
    port: Number(process.env.API_PORT || defaultPorts.api),
  });

  for (const name of ['processor', 'storage', 'ingestion', 'api']) {
    process.env.PORT =
      process.env[name.toUpperCase() + '_PORT'] || defaultPorts[name];
    const { AppModule } = require(`../apps/${name}/dist/app.module.js`);
    const app = await NestFactory.create(AppModule, {
      logger: new ApplicationLogger(name),
      abortOnError: false,
      // Mirrors `apps/api/src/main.ts`. Payment webhooks are verified against the exact
      // bytes the provider signed, and without the raw body every delivery is refused
      // with a 401 - which looks like a wrong signing secret and is not.
      ...(name === 'api' ? { rawBody: true } : {}),
    });
    if (name === 'ingestion')
      require('../apps/ingestion/dist/otlp/http').configureIngestionHttp(app);
    apps.push(app);
    const config = app.get(APPLICATION_CONFIG);
    if (name === 'ingestion' && !config.developmentAgentToken)
      throw new Error('FAULTLINE_DEV_AGENT_TOKEN is required');
    app.useLogger(app.get(ApplicationLogger));
    await app.listen(config.port, config.host);
    app
      .get(ApplicationLogger)
      .log({ event: 'application_started', port: config.port });
  }
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      shutdown().catch(() => {
        process.exitCode = 1;
      });
    });
})().catch(async () => {
  console.error(
    JSON.stringify({
      event: 'development_pipeline_start_failed',
      message: 'Check configuration, agent token and distinct ports',
    }),
  );
  await shutdown();
  process.exitCode = 1;
});
