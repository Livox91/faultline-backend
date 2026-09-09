// Development composition root: independent apps share process-local queue and incidents.
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const {
  APPLICATION_CONFIG,
  ApplicationLogger,
} = require('@faultline/platform');
const { getDevelopmentQueue } = require('@faultline/queue');
const apps = [];
let stopping;
async function shutdown() {
  return (stopping ??= (async () => {
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
  for (const name of ['processor', 'storage', 'ingestion', 'api']) {
    process.env.PORT =
      process.env[name.toUpperCase() + '_PORT'] || defaultPorts[name];
    const { AppModule } = require(`../apps/${name}/dist/app.module.js`);
    const app = await NestFactory.create(AppModule, {
      logger: new ApplicationLogger(name),
      abortOnError: false,
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
