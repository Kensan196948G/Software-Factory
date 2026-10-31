import { buildApp } from './app.js';
import { accessJwtStartupWarning, config } from './config.js';
import { closePool } from './db.js';

async function main(): Promise<void> {
  const app = await buildApp();
  const accessWarning = accessJwtStartupWarning(config);
  if (accessWarning) app.log.warn(accessWarning);
  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, env: config.nodeEnv, version: config.appVersion, commit: config.commitSha },
    'mirai-sf intake api started',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
