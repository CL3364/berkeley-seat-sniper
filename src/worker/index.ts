/**
 * src/worker/index.ts
 *
 * Process entry point: `npm run worker` → `tsx src/worker/index.ts`.
 *
 * Tests import from `../worker/public` (a side-effect-free barrel) to avoid
 * triggering `startPoller()` at import time.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 */

// Load local configuration before importing poller.ts and its config-bearing
// dependencies. A deployed process normally receives env directly, so a missing
// local .env is intentionally harmless.
if (process.env.SKIP_ENV_FILE !== '1') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file present — rely on the already-exported process environment.
  }
}

// Surface unhandled rejections as fatal so a process supervisor can restart.
process.on('unhandledRejection', () => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_rejection',
      classification: 'unexpected_failure',
    }) + '\n',
  );
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  const { startPoller } = await import('./poller');
  const shutdown = new AbortController();
  let stopping = false;
  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', event: 'worker_shutdown_forced', signal })}\n`,
      );
      process.exit(1);
    }
    stopping = true;
    process.stdout.write(
      `${JSON.stringify({ level: 'info', event: 'worker_shutdown_requested', signal })}\n`,
    );
    shutdown.abort();
  };
  const onSigterm = (): void => requestShutdown('SIGTERM');
  const onSigint = (): void => requestShutdown('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    await startPoller({ signal: shutdown.signal });
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }
}

bootstrap().catch(() => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'poller_fatal',
      classification: 'startup_or_runtime_failure',
    }) + '\n',
  );
  process.exit(1);
});
